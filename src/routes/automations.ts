// Automation (自动化) REST routes, mounted at /api/automations.
//
// Thin layer over AutomationService: it owns permissions (owner isolation,
// 404 for other users' automations, Host workspaces need an admin) and the
// Chinese error texts. index.ts injects the service once the runtime is up.
// Read-only guests reach only the list and detail reads (guest guard), scoped
// to the workspaces they are granted, with shell commands and their output
// left out.

import { Hono, type Context } from 'hono';
import type { ZodType } from 'zod';

import {
  AutomationError,
  type AutomationActor,
  type AutomationService,
  type AutomationSessionDisposal,
} from '../automation-contract.js';
import { logger } from '../logger.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  AutomationCreateSchema,
  AutomationMarkReadSchema,
  AutomationPatchSchema,
} from '../schemas.js';
import { getAutomation } from '../automation-store.js';
import { getRegisteredGroup, listActiveGuestGrantJids } from '../db.js';
import {
  canViewGroup,
  redactAutomationForGuest,
  redactAutomationRunForGuest,
} from '../guest-access.js';
import type { AuthUser } from '../types.js';
import type { Variables } from '../web-context.js';

let automationService: AutomationService | null = null;

/** Called by index.ts after createAutomationCore(); null detaches it. */
export function setAutomationService(service: AutomationService | null): void {
  automationService = service;
}

const automationRoutes = new Hono<{ Variables: Variables }>();
automationRoutes.use('*', authMiddleware);

function actorOf(c: Context<{ Variables: Variables }>): AutomationActor {
  const user = c.get('user') as AuthUser;
  return { kind: 'web', userId: user.id, isAdmin: user.role === 'admin' };
}

async function readBody<T>(
  c: Context<{ Variables: Variables }>,
  schema: ZodType<T>,
): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = undefined;
  }
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new AutomationError(400, '请求格式不正确');
  return parsed.data;
}

type Handler = (
  c: Context<{ Variables: Variables }>,
  service: AutomationService,
) => Promise<Response> | Response;

/** Resolve the service and map AutomationError to `{ error }`. */
function handle(handler: Handler) {
  return async (c: Context<{ Variables: Variables }>) => {
    if (!automationService)
      return c.json({ error: '自动化服务尚未就绪，请稍后重试' }, 503);
    try {
      return await handler(c, automationService);
    } catch (error) {
      if (error instanceof AutomationError)
        return c.json({ error: error.message }, error.status);
      logger.error(
        { err: error, path: c.req.path },
        'Automation request failed',
      );
      return c.json({ error: '操作失败，请稍后重试' }, 500);
    }
  };
}

/** Workspaces a guest may currently view (grant, owner and workspace intact). */
function guestWorkspaceJids(user: AuthUser): string[] {
  return listActiveGuestGrantJids(user.id).filter((jid) => {
    const group = getRegisteredGroup(jid);
    return !!group && canViewGroup(user, { ...group, jid });
  });
}

/**
 * A guest reads a workspace's automations the way a non-owner turn does:
 * scoped to that workspace, every write refused by the service.
 */
function viewerOf(workspaceJid: string): AutomationActor {
  return { kind: 'other_turn', workspaceJid, sessionJid: workspaceJid };
}

/** The guest's actor for one automation, or a 404 like any hidden one. */
function guestActorFor(user: AuthUser, automationId: string): AutomationActor {
  const automation = getAutomation(automationId);
  if (
    !automation ||
    !guestWorkspaceJids(user).includes(automation.workspaceJid)
  )
    throw new AutomationError(404, '自动化不存在');
  return viewerOf(automation.workspaceJid);
}

function isGuest(c: Context<{ Variables: Variables }>): boolean {
  return (c.get('user') as AuthUser).role === 'guest';
}

function param(c: Context<{ Variables: Variables }>, name: string): string {
  return c.req.param(name) ?? '';
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

automationRoutes.get(
  '/',
  handle((c, service) => {
    const workspaceJid = c.req.query('workspace') || undefined;
    if (isGuest(c)) {
      const jids = guestWorkspaceJids(c.get('user') as AuthUser).filter(
        (jid) => !workspaceJid || jid === workspaceJid,
      );
      return c.json({
        automations: jids
          .flatMap((jid) => service.list(viewerOf(jid)))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(redactAutomationForGuest),
      });
    }
    return c.json({
      automations: service.list(actorOf(c), { workspaceJid }),
    });
  }),
);

automationRoutes.post(
  '/',
  handle(async (c, service) => {
    const input = await readBody(c, AutomationCreateSchema);
    return c.json({ automation: service.create(actorOf(c), input) }, 201);
  }),
);

automationRoutes.get(
  '/for-session',
  handle((c, service) => {
    const jid = c.req.query('jid');
    if (!jid) throw new AutomationError(400, '缺少会话参数');
    const user = c.get('user') as AuthUser;
    return c.json({
      automations: service
        .listForSession(jid)
        .filter((automation) => automation.createdBy === user.id),
    });
  }),
);

automationRoutes.get(
  '/:id',
  handle((c, service) => {
    const id = param(c, 'id');
    if (isGuest(c)) {
      const actor = guestActorFor(c.get('user') as AuthUser, id);
      return c.json({
        automation: redactAutomationForGuest(service.get(actor, id)),
        runs: service.listRuns(actor, id, 50).map(redactAutomationRunForGuest),
      });
    }
    const actor = actorOf(c);
    return c.json({
      automation: service.get(actor, id),
      runs: service.listRuns(actor, id, 50),
    });
  }),
);

automationRoutes.patch(
  '/:id',
  handle(async (c, service) => {
    const { expectedRevision, ...patch } = await readBody(
      c,
      AutomationPatchSchema,
    );
    return c.json({
      automation: service.update(
        actorOf(c),
        param(c, 'id'),
        expectedRevision,
        patch,
      ),
    });
  }),
);

automationRoutes.post(
  '/:id/pause',
  handle((c, service) =>
    c.json({ automation: service.pause(actorOf(c), param(c, 'id')) }),
  ),
);

automationRoutes.post(
  '/:id/resume',
  handle((c, service) =>
    c.json({ automation: service.resume(actorOf(c), param(c, 'id')) }),
  ),
);

const SESSION_DISPOSALS: readonly AutomationSessionDisposal[] = [
  'keep',
  'archive',
  'delete',
];

automationRoutes.delete(
  '/:id',
  handle(async (c, service) => {
    const raw = c.req.query('sessions') ?? 'keep';
    if (!SESSION_DISPOSALS.includes(raw as AutomationSessionDisposal))
      throw new AutomationError(400, '会话处理方式无效');
    await service.delete(
      actorOf(c),
      param(c, 'id'),
      raw as AutomationSessionDisposal,
    );
    return c.body(null, 204);
  }),
);

automationRoutes.post(
  '/:id/run',
  handle(async (c, service) =>
    c.json({ run: await service.runNow(actorOf(c), param(c, 'id')) }, 202),
  ),
);

automationRoutes.get(
  '/:id/runs',
  handle((c, service) => {
    const id = param(c, 'id');
    const limit = parseLimit(c.req.query('limit'));
    if (isGuest(c)) {
      const actor = guestActorFor(c.get('user') as AuthUser, id);
      return c.json({
        runs: service
          .listRuns(actor, id, limit)
          .map(redactAutomationRunForGuest),
      });
    }
    return c.json({ runs: service.listRuns(actorOf(c), id, limit) });
  }),
);

automationRoutes.post(
  '/:id/runs/read',
  handle(async (c, service) => {
    const { runIds } = await readBody(c, AutomationMarkReadSchema);
    service.markRunsRead(actorOf(c), param(c, 'id'), runIds);
    return c.body(null, 204);
  }),
);

automationRoutes.post(
  '/:id/runs/:runId/cancel',
  handle(async (c, service) => {
    await service.cancelRun(actorOf(c), param(c, 'id'), param(c, 'runId'));
    return c.body(null, 204);
  }),
);

export default automationRoutes;
