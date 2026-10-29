import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

// Real database in a temp DATA_DIR; provider configuration is mocked so the
// resolution runs its actual decision branches.
const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-pinned-model-source-'),
);

const mocks = vi.hoisted(() => ({
  providers: [] as Array<{
    id: string;
    type: 'third_party';
    enabled: boolean;
    weight: number;
    anthropicModel: string;
    anthropicAuthToken: string;
  }>,
  defaultId: null as string | null,
  workspaceEnv: {} as Record<string, string>,
}));

vi.mock('../src/config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/config.js')>(
      '../src/config.js',
    );
  return {
    ...actual,
    DATA_DIR: tmpRoot,
    STORE_DIR: path.join(tmpRoot, 'db'),
    GROUPS_DIR: path.join(tmpRoot, 'groups'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/runtime-config.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/runtime-config.js')
  >('../src/runtime-config.js');
  return {
    ...actual,
    getProviders: () => mocks.providers,
    getEnabledProviders: () => mocks.providers.filter((p) => p.enabled),
    getContainerEnvConfig: () => mocks.workspaceEnv,
    getUsableDefaultProvider: () =>
      mocks.providers.find((p) => p.id === mocks.defaultId && p.enabled) ??
      null,
  };
});

const db = await import('../src/db.ts');
const runner = await import('../src/container-runner.ts');

function setProviders(...entries: Array<[string, boolean]>) {
  mocks.providers = entries.map(([id, enabled]) => ({
    id,
    type: 'third_party',
    enabled,
    weight: 1,
    anthropicModel: `${id}-model`,
    anthropicAuthToken: `${id}-token`,
  }));
}

const session = { groupFolder: 'grp', agentId: null };

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db.setSessionModelSelection('grp', null, null);
  mocks.defaultId = null;
  mocks.workspaceEnv = {};
  setProviders(['A', true], ['B', true], ['C', false]);
});

describe('resolvePinnedModelConfig', () => {
  test('follows conversation pick, Agent binding, global default, sole enabled, pool', () => {
    db.setSessionModelSelection('grp', null, 'C', 'user-1');
    mocks.defaultId = 'A';
    expect(runner.resolvePinnedModelConfig('B', session)).toEqual({
      id: 'C',
      source: 'session',
    });

    db.setSessionModelSelection('grp', null, null);
    expect(runner.resolvePinnedModelConfig('B', session)).toEqual({
      id: 'B',
      source: 'agent',
    });
    expect(runner.resolvePinnedModelConfig(null, session)).toEqual({
      id: 'A',
      source: 'default',
    });

    mocks.defaultId = null;
    expect(runner.resolvePinnedModelConfig(null, session)).toEqual({
      id: null,
      source: 'pool',
    });
    setProviders(['A', true], ['C', false]);
    expect(runner.resolvePinnedModelConfig(null, session)).toEqual({
      id: 'A',
      source: 'single',
    });
    setProviders(['C', false]);
    expect(runner.resolvePinnedModelConfig(null)).toEqual({
      id: null,
      source: 'none',
    });
  });

  test('a Workspace with its own provider environment outranks only the global default', () => {
    mocks.defaultId = 'A';
    mocks.workspaceEnv = { anthropicBaseUrl: 'https://own.example' };
    expect(runner.resolvePinnedModelConfig(null, session)).toEqual({
      id: null,
      source: 'workspace_env',
    });
    expect(runner.resolvePinnedModelConfig('B', session)).toEqual({
      id: 'B',
      source: 'agent',
    });
    // Without a Workspace the environment does not apply.
    expect(runner.resolvePinnedModelConfig(null)).toEqual({
      id: 'A',
      source: 'default',
    });
  });
});
