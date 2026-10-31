/**
 * The owner's workspace delegate switch on a direct-chat session binding:
 * who may toggle it, which bindings accept it, and that a rebind drops it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-delegate-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
let currentUser: { id: string; role: string } = { id: 'u1', role: 'member' };
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: currentUser.id,
      username: currentUser.id,
      role: currentUser.role,
      permissions: [],
    });
    await next();
  },
}));
const db = await import('../src/db.js');
const { setWebDeps } = await import('../src/web-context.js');
const routes = (await import('../src/routes/workspaces.js')).default;

const OWNER = 'u1';
const STRANGER = 'u2';
const GUEST = 'g1';
const WORKSPACE = 'web:flow-x';
const OTHER_WORKSPACE = 'web:flow-y';
const FOLDER = 'flow-x';
const SESSION = 'session-1';
const OTHER_SESSION = 'session-2';
const DM = 'qq:c2c:AAAA';
const GROUP = 'qq:group:GGGG';
const now = () => new Date().toISOString();

function bindToSession(jid: string, sessionId: string): void {
  db.setRegisteredGroup(jid, {
    name: jid,
    folder: FOLDER,
    created_by: OWNER,
    added_at: now(),
    target_agent_id: sessionId,
  });
}

function put(jid: string, body: unknown, workspace = WORKSPACE) {
  return routes.request(
    `/${encodeURIComponent(workspace)}/channel-mounts/${encodeURIComponent(jid)}/delegate`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

beforeAll(() => {
  db.initDatabase();
  for (const id of [OWNER, STRANGER])
    db.createUser({
      id,
      username: id,
      password_hash: 'hash',
      display_name: id,
      role: 'member',
      status: 'active',
      must_change_password: false,
      created_at: now(),
      updated_at: now(),
    });
  for (const jid of [WORKSPACE, OTHER_WORKSPACE])
    db.setRegisteredGroup(jid, {
      name: jid,
      folder: jid.slice('web:'.length),
      created_by: OWNER,
      added_at: now(),
    });
  for (const [id, chatJid] of [
    [SESSION, WORKSPACE],
    [OTHER_SESSION, WORKSPACE],
    ['session-y', OTHER_WORKSPACE],
  ])
    db.createAgent({
      id,
      group_folder: chatJid.slice('web:'.length),
      chat_jid: chatJid,
      name: id,
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: OWNER,
      created_at: now(),
      completed_at: null,
      result_summary: null,
    } as never);
  setWebDeps({
    queue: {},
    sessions: {},
    getRegisteredGroups: () => db.getAllRegisteredGroups(),
  } as any);
});
afterEach(() => {
  currentUser = { id: OWNER, role: 'member' };
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('workspace delegate switch', () => {
  test('the owner turns it on for a direct-chat session binding; it is mirrored and read back', async () => {
    bindToSession(DM, SESSION);
    expect(db.getChannelMount(DM)?.delegate_enabled).toBe(false);
    const response = await put(DM, { enabled: true });
    expect(response.status).toBe(200);
    expect((await response.json()).channel_mount).toMatchObject({
      channel_jid: DM,
      session_id: SESSION,
      delegate_capable: true,
      delegate_enabled: true,
    });
    expect(db.getChannelMount(DM)?.delegate_enabled).toBe(true);
    expect(db.getAgentChannelMount(DM)).toMatchObject({
      delegate_enabled: true,
      workspace_folder: FOLDER,
      owner_user_id: OWNER,
    });
    const listed = await routes.request(`/${WORKSPACE}/channel-mounts`);
    expect((await listed.json()).channel_mounts).toContainEqual(
      expect.objectContaining({ channel_jid: DM, delegate_enabled: true }),
    );
  });

  test('ordinary binding edits and a projection rebuild keep it', () => {
    bindToSession(DM, SESSION);
    db.setChannelMountDelegateEnabled(DM, WORKSPACE, SESSION, true);
    const row = db.getRegisteredGroup(DM)!;
    db.setRegisteredGroup(DM, { ...row, audience_mode: 'owner_only' });
    expect(db.getChannelMount(DM)?.delegate_enabled).toBe(true);
    db.syncAllChannelMountsFromRegisteredGroups();
    expect(db.getChannelMount(DM)?.delegate_enabled).toBe(true);
    expect(db.getAgentChannelMount(DM)?.delegate_enabled).toBe(true);
  });

  test('rebinding to another session or workspace, or unbinding, drops it', () => {
    for (const target of [OTHER_SESSION, 'session-y']) {
      bindToSession(DM, SESSION);
      expect(
        db.setChannelMountDelegateEnabled(DM, WORKSPACE, SESSION, true),
      ).toBeDefined();
      bindToSession(DM, target);
      expect(db.getChannelMount(DM)?.delegate_enabled).toBe(false);
      expect(db.getAgentChannelMount(DM)?.delegate_enabled).toBe(false);
      // Binding back does not restore it.
      bindToSession(DM, SESSION);
      expect(db.getChannelMount(DM)?.delegate_enabled).toBe(false);
    }
    db.setChannelMountDelegateEnabled(DM, WORKSPACE, SESSION, true);
    const row = db.getRegisteredGroup(DM)!;
    db.setRegisteredGroup(DM, { ...row, target_agent_id: undefined });
    expect(db.getChannelMount(DM)).toBeUndefined();
    bindToSession(DM, SESSION);
    expect(db.getChannelMount(DM)?.delegate_enabled).toBe(false);
  });

  test('a stale session write lands nowhere', () => {
    bindToSession(DM, SESSION);
    expect(
      db.setChannelMountDelegateEnabled(DM, WORKSPACE, OTHER_SESSION, true),
    ).toBeUndefined();
    expect(db.getChannelMount(DM)?.delegate_enabled).toBe(false);
  });

  test('group bindings cannot have a delegate (400), but switching off is accepted', async () => {
    bindToSession(GROUP, SESSION);
    const response = await put(GROUP, { enabled: true });
    expect(response.status).toBe(400);
    expect(db.getChannelMount(GROUP)?.delegate_enabled).toBe(false);
    const off = await put(GROUP, { enabled: false });
    expect(off.status).toBe(200);
    expect((await off.json()).channel_mount).toMatchObject({
      delegate_capable: false,
      delegate_enabled: false,
    });
  });

  test('another user, a guest, or a wrong workspace path gets 404', async () => {
    bindToSession(DM, SESSION);
    currentUser = { id: STRANGER, role: 'member' };
    expect((await put(DM, { enabled: true })).status).toBe(404);
    currentUser = { id: GUEST, role: 'guest' };
    expect((await put(DM, { enabled: true })).status).toBe(404);
    currentUser = { id: OWNER, role: 'member' };
    expect((await put(DM, { enabled: true }, OTHER_WORKSPACE)).status).toBe(
      404,
    );
    expect(db.getChannelMount(DM)?.delegate_enabled).toBe(false);
  });

  test.each([{}, { enabled: 'yes' }, { enabled: true, extra: 1 }])(
    'rejects invalid body %j',
    async (body) => {
      bindToSession(DM, SESSION);
      expect((await put(DM, body)).status).toBe(400);
    },
  );
});
