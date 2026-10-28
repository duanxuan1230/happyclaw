import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-history-'));
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: tmp,
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/runtime-state-store.js');
const { invalidateSessionAfterRunnerExit, CAPABILITY_CHANGE_RESET_REASON } =
  await import('../src/capability-runtime-mutation.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('history hand-off after a capability change', () => {
  test('every reset conversation session is owed history until it has a session again', () => {
    const folder = 'cap-folder';
    db.setSession(folder, 'sdk-main');
    db.setSession(folder, 'sdk-topic', 'session-topic');
    db.setSession(folder, 'sdk-task', 'task-run-1');
    expect(store.markFolderSessionsForHistoryReinjection(folder, 'x')).toBe(2);
    db.deleteWorkspaceSessions(folder);

    // A turn that fails before it establishes a session re-injects on retry.
    expect(store.takeSessionHistoryReinjection(folder, null, false)).toBe('x');
    expect(store.takeSessionHistoryReinjection(folder, null, false)).toBe('x');
    expect(
      store.takeSessionHistoryReinjection(folder, 'session-topic', false),
    ).toBe('x');
    // Isolated task sessions never resume and owe nothing.
    expect(
      store.takeSessionHistoryReinjection(folder, 'task-run-1', false),
    ).toBeNull();

    // Once the session exists again the marker is spent.
    expect(store.takeSessionHistoryReinjection(folder, null, true)).toBeNull();
    expect(store.takeSessionHistoryReinjection(folder, null, false)).toBeNull();
    expect(
      store.takeSessionHistoryReinjection(folder, 'session-topic', false),
    ).toBe('x');
  });

  test('a runner that changed its own capabilities loses the session it saved, once it exits', () => {
    const folder = 'self-folder';
    db.setSession(folder, 'kept-alive', 'session-self');
    invalidateSessionAfterRunnerExit(folder, 'session-self');
    expect(db.getSession(folder, 'session-self')).toBeUndefined();
    expect(
      store.takeSessionHistoryReinjection(folder, 'session-self', false),
    ).toBe(CAPABILITY_CHANGE_RESET_REASON);

    // Nothing to reset, nothing owed.
    invalidateSessionAfterRunnerExit(folder, null);
    expect(store.takeSessionHistoryReinjection(folder, null, false)).toBeNull();
  });

  test('both conversation paths re-inject history with the capability intro', () => {
    const source = fs.readFileSync('src/index.ts', 'utf8');
    const main = source.slice(
      source.indexOf('async function processGroupMessages('),
      source.indexOf('async function runTerminalWarmup('),
    );
    expect(main).toMatch(
      /else if \(\s*takeSessionHistoryReinjection\(\s*effectiveGroup\.folder,\s*null,\s*!!sessions\[effectiveGroup\.folder\],\s*\)\s*\)\s*\{[\s\S]{0,400}intro: CAPABILITY_CHANGE_HISTORY_INTRO,/,
    );
    const agent = source.slice(
      source.indexOf('async function processAgentConversation('),
    );
    expect(agent).toMatch(
      /const capabilityReset = takeSessionHistoryReinjection\(\s*effectiveGroup\.folder,\s*agentId,\s*!!sessionId,\s*\);/,
    );
    expect(agent).toMatch(
      /capabilityReset\s*\?\s*CAPABILITY_CHANGE_HISTORY_INTRO/,
    );
  });

  test('install_skill and uninstall_skill let the requesting runner finish its turn', () => {
    const source = fs.readFileSync('src/index.ts', 'utf8');
    expect(source).toMatch(
      /runSelfCapabilityMutation\(\s*sourceGroup,\s*ipcAgentId,\s*\(\) => installSkillForUser\(userId, pkg\),\s*\)/,
    );
    expect(source).toMatch(
      /runSelfCapabilityMutation\(\s*sourceGroup,\s*ipcAgentId,\s*\(\) => deleteSkillForUser\(userId, skillId\),\s*\)/,
    );
  });
});
