/**
 * A conversation or an Agent picks a model within a model configuration. The
 * launch runs it (ANTHROPIC_MODEL and the environment that follows it), a
 * model's own effort comes with it, and one SDK session always runs on one
 * model: a pick or an un-pick starts a new session once, nothing else does.
 *
 * Real configuration file and database in a temp DATA_DIR; the real pool
 * selection and environment builder run.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-model-launch-'));

const mocks = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  CONTAINER_IMAGE: 'happyclaw-agent:test',
  TIMEZONE: 'UTC',
}));
vi.mock('../src/logger.js', () => ({ logger: mocks.logger }));

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const runner = await import('../src/container-runner.js');
const { applyProviderSwitchToInput } =
  await import('../src/provider-switch-context.js');
const { providerPool } = await import('../src/provider-pool.js');

const FOLDER = 'model-launch';
let glm: ReturnType<typeof runtimeConfig.createProvider>;
let kimi: ReturnType<typeof runtimeConfig.createProvider>;
let relay: ReturnType<typeof runtimeConfig.createProvider>;

function balancing(strategy: 'failover' | 'round-robin') {
  runtimeConfig.saveBalancingConfig({
    strategy,
    unhealthyThreshold: 1,
    recoveryIntervalMs: 300_000,
  });
}

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups', FOLDER), { recursive: true });
  db.initDatabase();
  glm = runtimeConfig.createProvider({
    name: 'GLM',
    type: 'third_party',
    anthropicBaseUrl: 'https://glm.example.test',
    anthropicAuthToken: 'glm-token',
    anthropicModel: 'glm-5',
    models: [
      { id: 'glm-5' },
      { id: 'glm-5-air', effort: 'low' },
      { id: 'glm-5[1m]' },
      { id: 'glm-legacy', hidden: true },
    ],
    enabled: true,
  });
  kimi = runtimeConfig.createProvider({
    name: 'Kimi',
    type: 'third_party',
    anthropicBaseUrl: 'https://kimi.example.test',
    anthropicAuthToken: 'kimi-token',
    anthropicModel: 'kimi-k3',
    models: [{ id: 'kimi-k3', effort: 'high' }],
    enabled: true,
  });
  // A pass-through relay names no model of its own.
  relay = runtimeConfig.createProvider({
    name: 'Relay',
    type: 'third_party',
    anthropicBaseUrl: 'https://relay.example.test',
    anthropicAuthToken: 'relay-token',
    anthropicModel: '',
    models: [{ id: 'relay-a' }],
    enabled: false,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  db.deleteAllSessionsForFolder(FOLDER);
  db.setSessionModelSelection(FOLDER, null, null);
  runtimeConfig.setDefaultModelConfig(null);
  runtimeConfig.saveSystemSettings({ fallbackModel: '' });
  balancing('failover');
  for (const provider of [glm, kimi, relay]) {
    providerPool.resetHealth(provider.id);
    providerPool.resetModelQuarantine(provider.id);
  }
});

function pick(modelConfigId: string | null, model?: string, effort?: string) {
  db.setSessionModelSelection(FOLDER, null, modelConfigId, 'user-1', {
    model: model ?? null,
    effort: effort ?? null,
  });
}

function select(agent: { modelConfigId?: string; model?: string } = {}) {
  const selection = runner.trySelectPoolProvider(
    FOLDER,
    null,
    agent.modelConfigId,
    null,
    agent.model,
  )!;
  providerPool.releaseSession(selection.profileId);
  return selection;
}

/** The runner environment a selection launches with. */
function envOf(
  selection: ReturnType<typeof select>,
  agentProfile?: Record<string, unknown>,
): (key: string) => string | undefined {
  runner.buildVolumeMounts(
    {
      name: FOLDER,
      folder: FOLDER,
      added_at: new Date().toISOString(),
    } as never,
    false,
    false,
    undefined,
    undefined,
    selection.resolved,
    undefined,
    agentProfile as never,
    undefined,
    selection.modelOverride,
    true,
    { envLines: [], addHostGateway: false },
  );
  const envFile = fs.readFileSync(
    path.join(runner.getContainerRuntimeEnvDir(FOLDER), 'env'),
    'utf8',
  );
  return (key) => new RegExp(`^${key}='([^']*)'$`, 'm').exec(envFile)?.[1];
}

let sdkSessions = 0;

/**
 * One turn as the orchestration runs it: predict, select, clear the SDK
 * session when told to, and let the runner store the session it ran on.
 */
function launch(agent: { modelConfigId?: string; model?: string } = {}) {
  const predicted = runner.willClearSessionOnProviderSwitch(
    FOLDER,
    null,
    agent.modelConfigId,
    agent.model,
  );
  const selection = select(agent);
  const sessionId = db.getSession(FOLDER, null) || undefined;
  applyProviderSwitchToInput(
    {
      prompt: 'next',
      sessionId,
      groupFolder: FOLDER,
      chatJid: `web:${FOLDER}`,
    },
    selection,
    null,
  );
  if (!sessionId || selection.resetSession) {
    sdkSessions += 1;
    db.setSession(FOLDER, `sdk-${sdkSessions}`, null);
  }
  return { predicted, reset: !!selection.resetSession, selection };
}

/** A Session that already ran on `providerId` before models were recorded. */
function legacySession(providerId: string) {
  db.setSession(FOLDER, 'sdk-legacy', null);
  db.setSessionProviderId(FOLDER, null, providerId);
}

describe('a conversation runs the model it picked within its configuration', () => {
  test('the pick replaces the main model; the tiers and the compaction window follow it', () => {
    pick(glm.id, 'glm-5[1m]');
    const selection = select();
    expect(selection).toMatchObject({
      profileId: glm.id,
      chosenModel: 'glm-5[1m]',
      sessionModel: 'glm-5[1m]',
      resolved: { config: { anthropicModel: 'glm-5[1m]' } },
    });
    const env = envOf(selection);
    for (const key of [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
    ]) {
      expect(env(key)).toBe('glm-5[1m]');
    }
    expect(env('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).toBe('1000000');

    pick(glm.id);
    const own = envOf(select());
    expect(own('ANTHROPIC_MODEL')).toBe('glm-5');
    expect(own('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).toBe('200000');
  });

  test('a hidden model runs when the conversation names it', () => {
    pick(glm.id, 'glm-legacy');
    expect(select().resolved.config.anthropicModel).toBe('glm-legacy');
  });

  test('a pick the configuration no longer offers runs its default and says why', () => {
    pick(glm.id, 'glm-4');
    const selection = select();
    expect(selection.resolved.config.anthropicModel).toBe('glm-5');
    expect(selection).not.toHaveProperty('chosenModel');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: glm.id, model: 'glm-4' }),
      'Conversation model is no longer offered by its configuration; following the configuration default',
    );
  });

  test('a pass-through relay runs the picked model, and none without a pick', () => {
    pick(relay.id, 'relay-a');
    expect(envOf(select())('ANTHROPIC_MODEL')).toBe('relay-a');
    pick(relay.id);
    const selection = select();
    expect(selection.sessionModel).toBe('');
    expect(envOf(selection)('ANTHROPIC_MODEL')).toBeUndefined();
  });
});

describe('an Agent runs the model it is bound to', () => {
  test('when its binding is what pins the launch', () => {
    const selection = select({ modelConfigId: glm.id, model: 'glm-5-air' });
    expect(selection).toMatchObject({
      profileId: glm.id,
      chosenModel: 'glm-5-air',
      resolved: { config: { anthropicModel: 'glm-5-air' } },
    });
  });

  test('a conversation pick outranks it, even one of the same configuration without a model', () => {
    pick(glm.id);
    expect(
      select({ modelConfigId: glm.id, model: 'glm-5-air' }).resolved.config
        .anthropicModel,
    ).toBe('glm-5');
    pick(kimi.id);
    expect(
      select({ modelConfigId: glm.id, model: 'glm-5-air' }).resolved.config
        .anthropicModel,
    ).toBe('kimi-k3');
  });

  test('a model without the binding that offers it is ignored', () => {
    runtimeConfig.setDefaultModelConfig(glm.id);
    const selection = select({ model: 'glm-5-air' });
    expect(selection.profileId).toBe(glm.id);
    expect(selection.resolved.config.anthropicModel).toBe('glm-5');
  });

  test('a model the configuration dropped runs its default and says why', () => {
    const selection = select({ modelConfigId: glm.id, model: 'glm-4' });
    expect(selection.resolved.config.anthropicModel).toBe('glm-5');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: glm.id, model: 'glm-4' }),
      'Agent model is no longer offered by its configuration; following the configuration default',
    );
  });
});

describe("a model's own effort", () => {
  test('comes with the model the launch runs on', () => {
    pick(glm.id, 'glm-5-air');
    const selection = select();
    expect(selection.resolved.customEnv.CLAUDE_CODE_EFFORT_LEVEL).toBe('low');
    expect(envOf(selection)('CLAUDE_CODE_EFFORT_LEVEL')).toBe('low');
  });

  test("an Agent's explicit effort wins", () => {
    pick(glm.id, 'glm-5-air');
    const env = envOf(select(), {
      id: 'agent',
      name: 'Agent',
      version: 1,
      isDefault: false,
      identityHash: '',
      identityPrompt: '',
      includeClaudePreset: true,
      runtimePolicy: db.normalizeAgentProfileRuntimePolicy({
        reasoning: { effort: 'high' },
      }),
    });
    expect(env('CLAUDE_CODE_EFFORT_LEVEL')).toBeUndefined();
  });

  test("a conversation's effort wins over the model's and the Agent's", () => {
    pick(kimi.id, 'kimi-k3', 'low');
    const selection = select();
    expect(selection.sessionEffort).toBe('low');
    expect(envOf(selection)('CLAUDE_CODE_EFFORT_LEVEL')).toBe('low');

    // Over an Agent's own effort too, through the environment, which Claude
    // Code ranks above the SDK effort the runner passes for the Agent. The
    // Agent profile the runner sees, and hashes, stays as stored.
    const runtimePolicy = db.normalizeAgentProfileRuntimePolicy({
      reasoning: { effort: 'max' },
    });
    const stored = JSON.stringify(runtimePolicy);
    const env = envOf(selection, {
      id: 'agent',
      name: 'Agent',
      version: 1,
      isDefault: false,
      identityHash: '',
      identityPrompt: '',
      includeClaudePreset: true,
      runtimePolicy,
    });
    expect(env('CLAUDE_CODE_EFFORT_LEVEL')).toBe('low');
    expect(JSON.stringify(runtimePolicy)).toBe(stored);
  });

  test('an effort the model does not take is ignored', () => {
    pick(glm.id, 'glm-5-air', 'high');
    const selection = select();
    expect(selection).not.toHaveProperty('sessionEffort');
    expect(envOf(selection)('CLAUDE_CODE_EFFORT_LEVEL')).toBe('low');
  });

  test('an effort-only change keeps the SDK session', () => {
    legacySession(kimi.id);
    pick(kimi.id, 'kimi-k3');
    expect(launch()).toMatchObject({ predicted: false, reset: false });
    pick(kimi.id, 'kimi-k3', 'low');
    expect(launch()).toMatchObject({ predicted: false, reset: false });
    pick(kimi.id, 'kimi-k3', 'max');
    expect(launch()).toMatchObject({ predicted: false, reset: false });
    expect(db.getSession(FOLDER, null)).toBe('sdk-legacy');
  });

  test('a model without one keeps the configuration effort', () => {
    pick(glm.id, 'glm-5[1m]');
    const selection = select();
    expect(selection.resolved.customEnv).not.toHaveProperty(
      'CLAUDE_CODE_EFFORT_LEVEL',
    );
    expect(envOf(selection)('CLAUDE_CODE_EFFORT_LEVEL')).toBe('max');
  });

  test("the pool's pick brings its model's effort; a fallback tier is judged as itself", () => {
    db.setSessionProviderId(FOLDER, null, kimi.id);
    expect(select().resolved.customEnv.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');

    runtimeConfig.saveSystemSettings({ fallbackModel: 'glm-5-air' });
    providerPool.reportModelFailure(glm.id, 'glm-5');
    providerPool.reportModelFailure(kimi.id, 'kimi-k3');
    const onKimi = select();
    expect(onKimi).toMatchObject({
      profileId: kimi.id,
      modelOverride: 'glm-5-air',
    });
    // Kimi does not list the fallback model: kimi-k3's effort is not its.
    expect(onKimi.resolved.customEnv).not.toHaveProperty(
      'CLAUDE_CODE_EFFORT_LEVEL',
    );

    db.setSessionProviderId(FOLDER, null, glm.id);
    const onGlm = select();
    expect(onGlm).toMatchObject({
      profileId: glm.id,
      modelOverride: 'glm-5-air',
    });
    expect(onGlm.resolved.customEnv.CLAUDE_CODE_EFFORT_LEVEL).toBe('low');
  });
});

describe('one SDK session runs on one model', () => {
  test('a session from before models were recorded keeps its SDK session', () => {
    // Pinned by the Agent's binding, no model anywhere.
    legacySession(glm.id);
    expect(db.getSessionModel(FOLDER, null)).toBeNull();
    const pinned = launch({ modelConfigId: glm.id });
    expect(pinned).toMatchObject({ predicted: false, reset: false });
    expect(db.getSession(FOLDER, null)).toBe('sdk-legacy');
    expect(db.getSessionModel(FOLDER, null)).toBe('glm-5');

    // Bound by the pool's sticky failover.
    db.deleteAllSessionsForFolder(FOLDER);
    legacySession(kimi.id);
    const pooled = launch();
    expect(pooled).toMatchObject({ predicted: false, reset: false });
    expect(pooled.selection.profileId).toBe(kimi.id);
    expect(db.getSession(FOLDER, null)).toBe('sdk-legacy');
    expect(db.getSessionModel(FOLDER, null)).toBe('kimi-k3');
  });

  test('a pick and an un-pick each start a new session exactly once', () => {
    legacySession(glm.id);
    pick(glm.id);
    const steps: Array<[string, boolean]> = [];
    const turn = (label: string) => {
      const { predicted, reset } = launch();
      expect(predicted).toBe(reset);
      steps.push([label, reset]);
    };
    turn('the configuration default, as before');
    pick(glm.id, 'glm-5-air');
    turn('picked');
    turn('picked again');
    pick(glm.id);
    turn('back to the default');
    turn('default again');
    pick(glm.id, 'glm-5-air');
    turn('picked once more');
    pick(null);
    turn('no pick: the pool keeps the binding on its default');
    turn('pool again');
    expect(steps).toEqual([
      ['the configuration default, as before', false],
      ['picked', true],
      ['picked again', false],
      ['back to the default', true],
      ['default again', false],
      ['picked once more', true],
      ['no pick: the pool keeps the binding on its default', true],
      ['pool again', false],
    ]);
    expect(db.getSessionModel(FOLDER, null)).toBe('glm-5');
  });

  test('switching only the 1M window keeps the session: the upstream model is the same', () => {
    legacySession(glm.id);
    pick(glm.id);
    expect(launch()).toMatchObject({ predicted: false, reset: false });
    pick(glm.id, 'glm-5[1m]');
    const widened = launch();
    expect(widened).toMatchObject({ predicted: false, reset: false });
    expect(widened.selection.resolved.config.anthropicModel).toBe('glm-5[1m]');
    expect(db.getSessionModel(FOLDER, null)).toBe('glm-5[1m]');
    pick(glm.id);
    expect(launch()).toMatchObject({ predicted: false, reset: false });
    expect(db.getSession(FOLDER, null)).toBe('sdk-legacy');
  });

  test("an Agent's model binding that changes the model starts a new session once", () => {
    legacySession(glm.id);
    const agent = { modelConfigId: glm.id };
    expect(launch(agent)).toMatchObject({ predicted: false, reset: false });
    const bound = { modelConfigId: glm.id, model: 'glm-5-air' };
    expect(launch(bound)).toMatchObject({ predicted: true, reset: true });
    expect(launch(bound)).toMatchObject({ predicted: false, reset: false });
    expect(launch(agent)).toMatchObject({ predicted: true, reset: true });
    expect(launch(agent)).toMatchObject({ predicted: false, reset: false });
  });

  test('pool rotation starts a new session only when the provider changes', () => {
    balancing('round-robin');
    legacySession(glm.id);
    let changes = 0;
    for (let i = 0; i < 6; i += 1) {
      const { reset, selection } = launch();
      const changed = selection.previousProviderId !== selection.profileId;
      if (changed) changes += 1;
      expect(reset).toBe(changed);
      expect(db.getSessionModel(FOLDER, null)).toBe(
        selection.profileId === glm.id ? 'glm-5' : 'kimi-k3',
      );
    }
    expect(changes).toBeGreaterThan(0);
  });

  test('a fallback tier escalation keeps the session, as it always has', () => {
    runtimeConfig.saveSystemSettings({ fallbackModel: 'claude-opus-5' });
    legacySession(glm.id);
    expect(launch()).toMatchObject({ predicted: false, reset: false });
    expect(db.getSessionModel(FOLDER, null)).toBe('glm-5');

    providerPool.reportModelFailure(glm.id, 'glm-5');
    providerPool.reportModelFailure(kimi.id, 'kimi-k3');
    const escalated = launch();
    expect(escalated.selection).toMatchObject({
      profileId: glm.id,
      modelOverride: 'claude-opus-5',
    });
    expect(escalated).toMatchObject({ predicted: false, reset: false });
    expect(db.getSession(FOLDER, null)).toBe('sdk-legacy');
    expect(db.getSessionModel(FOLDER, null)).toBe('glm-5');

    providerPool.resetModelQuarantine(glm.id);
    providerPool.resetModelQuarantine(kimi.id);
    expect(launch()).toMatchObject({ predicted: false, reset: false });
    expect(db.getSession(FOLDER, null)).toBe('sdk-legacy');
  });
});
