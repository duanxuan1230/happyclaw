/**
 * Read-only developer workbench routes under /api/groups/:jid:
 *
 *   GET git/status?agentId=           changed files of the session's checkout
 *   GET git/diff?agentId=&path=       unified diff of one changed file
 *   GET git/worktree-support          can a new session get its own worktree
 *   GET workdir/peers?agentId=        other running sessions in the same dir
 *
 * Access follows the file panel: the workspace must be visible to the caller
 * (404 otherwise, no admin bypass) and Host workspaces need host permission.
 * Git runs only for Host workspaces: a container Agent controls its
 * repository's config and hooks, which must never execute on the host.
 */
import fs from 'node:fs';
import path from 'node:path';

import { Hono, type Context } from 'hono';

import { authMiddleware } from '../middleware/auth.js';
import { canAccessGroup } from '../group-acl.js';
import { getAgent, getJidsByFolder, getRegisteredGroup } from '../db.js';
import {
  getWebDeps,
  hasHostExecutionPermission,
  isHostExecutionGroup,
  type Variables,
} from '../web-context.js';
import type { AuthUser, RegisteredGroup } from '../types.js';
import {
  GitCommandError,
  GitPathError,
  locateGitRepo,
  readGitFileDiff,
  readGitStatus,
} from '../git-review.js';
import {
  getWorktreeSupport,
  resolveSessionWorkingDirectory,
  resolveWorkspaceProjectRoot,
  toSessionWorktreePayload,
  WORKTREE_UNAVAILABLE_MESSAGES,
} from '../session-worktree.js';
import { getSessionWorktree } from '../session-worktree-store.js';
import { logger } from '../logger.js';

const gitReviewRoutes = new Hono<{ Variables: Variables }>();

type WorkspaceGroup = RegisteredGroup & { jid: string };

interface ReviewScope {
  group: WorkspaceGroup;
  authUser: AuthUser;
  /** Runtime Session id, or null for the main session. */
  agentId: string | null;
}

function resolveReviewScope(
  c: Context<{ Variables: Variables }>,
): ReviewScope | Response {
  const jid = c.req.param('jid') ?? '';
  const group = getRegisteredGroup(jid);
  const authUser = c.get('user') as AuthUser;
  if (
    !group ||
    !canAccessGroup({ id: authUser.id, role: authUser.role }, group)
  ) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }
  const rawAgentId = c.req.query('agentId');
  const agentId = rawAgentId && rawAgentId !== 'main' ? rawAgentId : null;
  if (agentId) {
    const agent = getAgent(agentId);
    if (!agent || agent.chat_jid !== jid) {
      return c.json({ error: 'Session not found' }, 404);
    }
  }
  return { group, authUser, agentId };
}

type ReviewRoot =
  | { state: 'ok'; root: string }
  | {
      state: 'unavailable';
      reason: 'container_mode' | 'worktree_broken';
      message: string;
    }
  | { state: 'not_git_repo'; message: string };

async function resolveReviewRoot(scope: ReviewScope): Promise<ReviewRoot> {
  if (!isHostExecutionGroup(scope.group)) {
    return {
      state: 'unavailable',
      reason: 'container_mode',
      message: '代码改动面板目前只支持宿主机模式的工作区',
    };
  }
  const session = resolveSessionWorkingDirectory(scope.agentId);
  if (session.kind === 'broken') {
    return {
      state: 'unavailable',
      reason: 'worktree_broken',
      message: `会话的独立 worktree 不可用：${session.reason}`,
    };
  }
  if (session.kind === 'worktree') {
    return { state: 'ok', root: session.worktree.worktree_path };
  }
  // data/groups/<folder> is nested in the HappyClaw checkout; only its own
  // repository counts, never the enclosing one.
  const repo = await locateGitRepo(resolveWorkspaceProjectRoot(scope.group), {
    requireTopLevel: !scope.group.customCwd,
  });
  if (!repo) {
    return { state: 'not_git_repo', message: '工作目录不是 git 仓库' };
  }
  return { state: 'ok', root: repo.topLevel };
}

function gitErrorPayload(error: unknown): { state: 'error'; error: string } {
  const message =
    error instanceof GitCommandError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return { state: 'error', error: message.slice(0, 500) };
}

gitReviewRoutes.get('/:jid/git/status', authMiddleware, async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const scope = resolveReviewScope(c);
  if (scope instanceof Response) return scope;
  const root = await resolveReviewRoot(scope);
  const worktree = toSessionWorktreePayload(getSessionWorktree(scope.agentId));
  if (root.state !== 'ok') return c.json({ ...root, worktree });
  try {
    const status = await readGitStatus(root.root);
    return c.json({ state: 'ok', root: root.root, worktree, ...status });
  } catch (error) {
    logger.warn({ err: error, root: root.root }, 'git status failed');
    return c.json({ ...gitErrorPayload(error), worktree });
  }
});

gitReviewRoutes.get('/:jid/git/diff', authMiddleware, async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const scope = resolveReviewScope(c);
  if (scope instanceof Response) return scope;
  const filePath = c.req.query('path');
  if (!filePath) return c.json({ error: 'path is required' }, 400);
  const root = await resolveReviewRoot(scope);
  if (root.state !== 'ok') return c.json(root);
  try {
    const diff = await readGitFileDiff(
      root.root,
      filePath,
      c.req.query('orig_path') || undefined,
    );
    return c.json({ state: 'ok', ...diff });
  } catch (error) {
    if (error instanceof GitPathError) {
      return c.json({ error: error.message }, 400);
    }
    logger.warn({ err: error, root: root.root }, 'git diff failed');
    return c.json(gitErrorPayload(error));
  }
});

gitReviewRoutes.get('/:jid/git/worktree-support', authMiddleware, async (c) => {
  const scope = resolveReviewScope(c);
  if (scope instanceof Response) return scope;
  const support = await getWorktreeSupport(scope.group);
  if (support.available) return c.json({ available: true });
  return c.json({
    available: false,
    reason: support.reason,
    message: WORKTREE_UNAVAILABLE_MESSAGES[support.reason],
  });
});

const AGENT_JID_MARKER = '#agent:';
const TASK_JID_MARKER = '#task:';

function realDirectory(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function workspaceForFolder(folder: string): WorkspaceGroup | undefined {
  for (const jid of getJidsByFolder(folder)) {
    if (!jid.startsWith('web:')) continue;
    const group = getRegisteredGroup(jid);
    if (group) return group;
  }
  return undefined;
}

/**
 * Sessions with a running turn whose working directory is the caller's.
 * Concurrency is only reported, never limited: different sessions may run
 * at once by design. Peers in workspaces the caller cannot see are counted
 * but not named.
 */
gitReviewRoutes.get('/:jid/workdir/peers', authMiddleware, (c) => {
  c.header('Cache-Control', 'private, no-store');
  const scope = resolveReviewScope(c);
  if (scope instanceof Response) return scope;
  const queue = getWebDeps()?.queue;
  if (!queue) return c.json({ peers: [], hidden_count: 0 });
  const ownDir = realDirectory(
    resolveWorkspaceProjectRoot(scope.group, { agentId: scope.agentId }),
  );
  const principal = { id: scope.authUser.id, role: scope.authUser.role };
  const seen = new Set<string>();
  const peers: Array<{
    workspace_jid: string;
    workspace_name: string;
    kind: 'main' | 'session' | 'task';
    session_id: string | null;
    session_name: string | null;
  }> = [];
  let hiddenCount = 0;
  for (const entry of queue.getStatus().groups) {
    if (!entry.active || !entry.queryInFlight || !entry.groupFolder) continue;
    const agentMarker = entry.jid.indexOf(AGENT_JID_MARKER);
    const agentId =
      agentMarker >= 0
        ? entry.jid.slice(agentMarker + AGENT_JID_MARKER.length)
        : null;
    const kind = agentId
      ? 'session'
      : entry.jid.includes(TASK_JID_MARKER)
        ? 'task'
        : 'main';
    const workspace = workspaceForFolder(entry.groupFolder);
    if (!workspace) continue;
    if (
      kind !== 'task' &&
      workspace.folder === scope.group.folder &&
      agentId === scope.agentId
    ) {
      continue;
    }
    const key = kind === 'task' ? entry.jid : `${workspace.jid}\0${agentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dir = realDirectory(
      resolveWorkspaceProjectRoot(workspace, { agentId }),
    );
    if (dir !== ownDir) continue;
    if (!canAccessGroup(principal, workspace)) {
      hiddenCount++;
      continue;
    }
    peers.push({
      workspace_jid: workspace.jid,
      workspace_name: workspace.name,
      kind,
      session_id: agentId,
      session_name: agentId ? (getAgent(agentId)?.name ?? null) : null,
    });
  }
  return c.json({ peers, hidden_count: hiddenCount });
});

export default gitReviewRoutes;
