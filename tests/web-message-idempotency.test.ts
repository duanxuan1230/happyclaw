/**
 * `POST /api/messages` with a `clientMessageId`: a resend after a slow or
 * lost response must not store, queue or bill the same message twice.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const ROOT =
  process.env.HAPPYCLAW_WEB_IDEMPOTENCY_TEST_DIR ??
  (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-idempotency-'));
    process.env.HAPPYCLAW_WEB_IDEMPOTENCY_TEST_DIR = dir;
    return dir;
  })();

const auth = vi.hoisted(() => ({ userId: 'owner' }));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = path.join(
    process.env.HAPPYCLAW_WEB_IDEMPOTENCY_TEST_DIR!,
    'data',
  );
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: auth.userId,
        username: auth.userId,
        display_name: auth.userId,
        role: 'admin',
        permissions: [],
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const store = await import('../src/runtime-state-store.js');

const OWNER_JID = 'web:idempotency-owner';
const OTHER_JID = 'web:idempotency-other';

const calls = {
  enqueue: [] as string[],
  promote: [] as string[],
};
let activeRunId: string | null = null;
let promoteGate: Promise<void> | null = null;
let failNextResolve = false;

const app = web.createAppForTest({
  queue: {
    stopGroup: async () => {},
    getActiveQueryId: () => activeRunId,
    requiresFeishuCliContainerRestart: () => false,
    hasActiveMainRunnerForMessage: () => false,
    sendMessage: () => 'no_active',
    enqueueMessageCheck: (jid: string) => calls.enqueue.push(jid),
  },
  getSessions: () => ({}),
  setLastAgentTimestamp: () => {},
  getRegisteredGroups: () => ({}),
  resolveEffectiveGroup: (group: unknown) => {
    if (failNextResolve) {
      failNextResolve = false;
      throw new Error('transient failure before the message is stored');
    }
    return { effectiveGroup: group };
  },
  formatMessages: () => 'formatted',
  advanceGlobalCursor: () => {},
  advanceNextPullCursorOnly: () => {},
  promoteFollowUp: async (_jid: string, messageId: string) => {
    calls.promote.push(messageId);
    await promoteGate;
    return { ok: true, state: 'interrupting' };
  },
} as unknown as Parameters<typeof web.createAppForTest>[0]);

function registerGroup(jid: string, folder: string, owner: string) {
  db.setRegisteredGroup(jid, {
    name: folder,
    folder,
    added_at: new Date().toISOString(),
    executionMode: 'host',
    created_by: owner,
  } as any);
}

beforeAll(() => {
  fs.mkdirSync(path.join(ROOT, 'data', 'db'), { recursive: true });
  db.initDatabase();
  registerGroup(OWNER_JID, 'idempotency-owner', 'owner');
  registerGroup(OTHER_JID, 'idempotency-other', 'other');
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  auth.userId = 'owner';
  activeRunId = null;
  promoteGate = null;
  failNextResolve = false;
  calls.enqueue.length = 0;
  calls.promote.length = 0;
});

let seq = 0;
function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

async function post(body: Record<string, unknown>) {
  const res = await app.request('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatJid: OWNER_JID, ...body }),
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    // An uncaught handler error answers with a plain-text 500.
  }
  return { status: res.status, body: json };
}

function storedWith(jid: string, content: string) {
  return db
    .getMessagesPage(jid, undefined, 500)
    .filter((m) => m.content === content);
}

describe('Web send idempotency', () => {
  test('a resend with the same id stores one message and starts one turn', async () => {
    const id = uuid();
    const first = await post({ content: 'resend me', clientMessageId: id });
    const second = await post({ content: 'resend me', clientMessageId: id });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.messageId).toBe(first.body.messageId);
    expect(second.body.disposition).toBe(first.body.disposition);
    expect(second.body.deduplicated).toBe(true);
    expect(storedWith(OWNER_JID, 'resend me')).toHaveLength(1);
    expect(calls.enqueue).toEqual([OWNER_JID]);
  });

  test('different ids are different messages', async () => {
    await post({ content: 'twice on purpose', clientMessageId: uuid() });
    await post({ content: 'twice on purpose', clientMessageId: uuid() });
    expect(storedWith(OWNER_JID, 'twice on purpose')).toHaveLength(2);
    expect(calls.enqueue).toHaveLength(2);
  });

  test('a client without ids keeps the old behaviour', async () => {
    const first = await post({ content: 'legacy client' });
    const second = await post({ content: 'legacy client' });
    expect(first.status).toBe(200);
    expect(second.body.messageId).not.toBe(first.body.messageId);
    expect(second.body.deduplicated).toBeUndefined();
    expect(storedWith(OWNER_JID, 'legacy client')).toHaveLength(2);
  });

  test('a concurrent resend waits for the first attempt and shares its answer', async () => {
    activeRunId = 'run-active';
    let release!: () => void;
    promoteGate = new Promise((resolve) => (release = resolve));
    const id = uuid();
    const body = {
      content: 'steer concurrently',
      clientMessageId: id,
      followUpBehavior: 'steer',
    };
    const first = post(body);
    const second = post(body);
    await vi.waitFor(() => expect(calls.promote).toHaveLength(1));
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.messageId).toBe(a.body.messageId);
    expect(storedWith(OWNER_JID, 'steer concurrently')).toHaveLength(1);
    expect(calls.promote).toHaveLength(1);
  });

  test('the same id with different content is a conflict, not a duplicate', async () => {
    const id = uuid();
    await post({ content: 'original', clientMessageId: id });
    const clash = await post({ content: 'edited', clientMessageId: id });
    const otherSession = await post({
      content: 'original',
      clientMessageId: id,
      followUpBehavior: 'steer',
    });

    expect(clash.status).toBe(409);
    expect(storedWith(OWNER_JID, 'edited')).toHaveLength(0);
    // followUpBehavior is not part of what was sent; only target and payload.
    expect(otherSession.status).toBe(200);
    expect(otherSession.body.deduplicated).toBe(true);
  });

  test('a failed first attempt is not remembered, so the resend is processed', async () => {
    const id = uuid();
    failNextResolve = true;
    const failed = await post({
      content: 'after failure',
      clientMessageId: id,
    });
    const retried = await post({
      content: 'after failure',
      clientMessageId: id,
    });

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(200);
    expect(retried.body.deduplicated).toBeUndefined();
    expect(storedWith(OWNER_JID, 'after failure')).toHaveLength(1);
    expect(calls.enqueue).toEqual([OWNER_JID]);
  });

  test('an expired record no longer answers and is pruned', async () => {
    const id = uuid();
    const longAgo = Date.now() - store.WEB_MESSAGE_DEDUP_TTL_MS - 1000;
    store.recordWebMessageDedup({
      userId: 'owner',
      chatJid: OWNER_JID,
      clientMessageId: id,
      fingerprint: 'stale',
      response: { success: true, messageId: 'stale-message' },
      now: longAgo,
    });
    expect(store.getWebMessageDedup('owner', OWNER_JID, id)).toBeNull();

    const sent = await post({ content: 'after expiry', clientMessageId: id });
    expect(sent.status).toBe(200);
    expect(sent.body.messageId).not.toBe('stale-message');
    expect(store.getWebMessageDedup('owner', OWNER_JID, id)).not.toBeNull();

    store.recordWebMessageDedup({
      userId: 'owner',
      chatJid: OWNER_JID,
      clientMessageId: uuid(),
      fingerprint: 'stale',
      response: {},
      now: longAgo,
    });
    expect(store.pruneWebMessageDedup()).toBe(1);
  });

  test('ids are per user: nobody reads another user’s answer or collides with it', async () => {
    const id = uuid();
    const owners = await post({ content: 'mine', clientMessageId: id });
    expect(owners.status).toBe(200);

    auth.userId = 'other';
    const guessed = await post({ content: 'mine', clientMessageId: id });
    expect(guessed.status).toBe(403);
    expect(guessed.body.messageId).toBeUndefined();

    const ownChat = await post({
      chatJid: OTHER_JID,
      content: 'mine',
      clientMessageId: id,
    });
    expect(ownChat.status).toBe(200);
    expect(ownChat.body.deduplicated).toBeUndefined();
    expect(storedWith(OTHER_JID, 'mine')).toHaveLength(1);
  });

  test('a malformed id is rejected', async () => {
    const res = await post({ content: 'bad id', clientMessageId: 'nope' });
    expect(res.status).toBe(400);
  });
});
