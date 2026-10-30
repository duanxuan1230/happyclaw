import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v86-model-names-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const backupDir = path.join(root, 'backups');
const databasePath = path.join(storeDir, 'messages.db');
for (const dir of [storeDir, groupsDir, dataDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

const OWNER = 'owner-user';

/** Build a current database, then write v85-era model names on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.createAgentProfile({
    profileId: 'wide-agent',
    ownerUserId: OWNER,
    name: 'Wide',
    modelConfigId: 'cfg-a',
  });
  db.createAgentProfile({
    profileId: 'plain-agent',
    ownerUserId: OWNER,
    name: 'Plain',
    modelConfigId: 'cfg-a',
    model: 'glm-5',
  });
  db.setSession('grp', 'sdk-1', null);
  db.closeDatabase();

  const legacy = new Database(databasePath);
  legacy
    .prepare("UPDATE agent_profiles SET model = 'glm-5[1m]' WHERE id = ?")
    .run('wide-agent');
  legacy
    .prepare(
      `INSERT INTO session_model_selections
         (group_folder, agent_id, model_config_id, model, reasoning_effort, updated_by, updated_at)
       VALUES ('grp', '', 'cfg-a', 'kimi-k3[1M]', 'high', 'u', '2026-10-01T00:00:00Z'),
              ('grp', 'side', 'cfg-a', NULL, NULL, 'u', '2026-10-01T00:00:00Z')`,
    )
    .run();
  legacy
    .prepare(
      "UPDATE sessions SET model = 'glm-5[1m]' WHERE group_folder = 'grp'",
    )
    .run();
  legacy
    .prepare(
      "UPDATE router_state SET value = '85' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v86 model names', () => {
  test('backs up the v85 database and strips [1m] from every stored model name', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(
      fs
        .readdirSync(backupDir)
        .some((name) =>
          name.startsWith(`messages-v85-to-v${db.CURRENT_SCHEMA_VERSION}-`),
        ),
    ).toBe(true);

    expect(db.getAgentProfile('wide-agent')).toMatchObject({
      model: 'glm-5',
    });
    expect(db.getAgentProfile('plain-agent')).toMatchObject({
      model: 'glm-5',
    });
    expect(db.getSessionModelSelectionDetail('grp', null)).toMatchObject({
      model: 'kimi-k3',
      effort: 'high',
    });
    expect(db.getSessionModelSelectionDetail('grp', 'side')).toMatchObject({
      model: null,
    });
    expect(db.getSessionModel('grp', null)).toBe('glm-5');
  });

  test('only the window changed: the Agent keeps its version', () => {
    // A version bump would retire every SDK session of the Agent.
    expect(db.getAgentProfile('wide-agent')?.version).toBe(1);
  });

  test('new writes never store [1m]', () => {
    db.updateAgentProfile('plain-agent', OWNER, { model: 'glm-5[1m]' });
    expect(db.getAgentProfile('plain-agent')?.model).toBe('glm-5');
    db.setSessionModelSelection('grp', null, 'cfg-a', 'u', {
      model: 'kimi-k3[1m]',
    });
    expect(db.getSessionModelSelectionDetail('grp', null)?.model).toBe(
      'kimi-k3',
    );
  });

  test('a restart changes nothing', () => {
    db.closeDatabase();
    db.initDatabase();
    expect(db.getAgentProfile('wide-agent')?.model).toBe('glm-5');
  });

  test('a newer database is refused', () => {
    db.closeDatabase();
    const raw = new Database(databasePath);
    raw
      .prepare("UPDATE router_state SET value = ? WHERE key = 'schema_version'")
      .run(String(db.CURRENT_SCHEMA_VERSION + 1));
    raw.close();
    expect(() => db.initDatabase()).toThrow(/refusing downgrade/);
  });
});
