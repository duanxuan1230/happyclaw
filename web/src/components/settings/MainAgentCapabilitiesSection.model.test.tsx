// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { AgentProfile, ModelConfigOption } from '../../types';
import { choose, combobox } from './test-helpers';

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  governance: vi.fn(),
  loadProfiles: vi.fn(async () => undefined),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  confirm: vi.fn(async () => true),
  state: {} as Record<string, unknown>,
}));

vi.mock('../../stores/confirm', () => ({
  confirmDialog: mocks.confirm,
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('../../stores/agent-profiles', () => ({
  useAgentProfilesStore: (selector: (state: unknown) => unknown) =>
    selector(mocks.state),
}));
vi.mock('../../stores/skills', () => ({
  useSkillsStore: (selector: (state: unknown) => unknown) =>
    selector({
      skills: [],
      loading: false,
      error: null,
      loadSkills: vi.fn(async () => undefined),
    }),
}));
vi.mock('../../stores/mcp-servers', () => ({
  useMcpServersStore: (selector: (state: unknown) => unknown) =>
    selector({
      servers: [],
      loading: false,
      error: null,
      loadServers: vi.fn(async () => undefined),
    }),
}));
vi.mock('../agents/AgentSkillsPolicyEditor', () => ({
  AgentSkillsPolicyEditor: () => null,
}));
vi.mock('../agents/EffectiveCapabilitiesPreview', () => ({
  EffectiveCapabilitiesPreview: () => null,
}));
vi.mock('../agents/PolicyResourcePicker', () => ({
  PolicyResourcePicker: () => null,
}));

const { MainAgentCapabilitiesSection } =
  await import('./MainAgentCapabilitiesSection');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CONFIGS: ModelConfigOption[] = [
  {
    id: 'official',
    name: 'Claude 官方',
    type: 'official',
    enabled: true,
    anthropic_model: 'opus',
    is_default: true,
    models: [
      { id: 'opus', hidden: false },
      { id: 'sonnet', hidden: false },
      { id: 'haiku', hidden: true },
    ],
  },
  {
    id: 'glm',
    name: 'GLM',
    type: 'third_party',
    enabled: true,
    anthropic_model: 'glm-5.3[1m]',
    models: [
      { id: 'glm-5.3[1m]', hidden: false },
      { id: 'glm-4.6', hidden: false },
    ],
  },
];

function mainProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'main',
    owner_user_id: 'admin',
    name: '主 HappyClaw',
    identity_prompt: '',
    soul_prompt: '',
    agents_prompt: '',
    tools_prompt: '',
    prompt_mode: 'append',
    include_claude_preset: true,
    avatar_emoji: null,
    avatar_color: null,
    avatar_url: null,
    model_config_id: null,
    model: null,
    runtime_policy: {
      reasoning: { effort: 'inherit' },
      context: {
        source: 'managed',
        auto_compact_window: 0,
        auto_compact_percentage: 0,
      },
      skills: { mode: 'inherit', ids: [], host: { mode: 'disabled', ids: [] } },
      mcp: { mode: 'inherit', ids: [] },
    },
    identity_hash: 'hash',
    version: 1,
    is_default: true,
    status: 'active',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function setStore(profile: AgentProfile, configs = CONFIGS) {
  mocks.state = {
    profiles: [profile],
    modelConfigs: configs,
    loading: false,
    loadProfiles: mocks.loadProfiles,
    // The store's update is what the section saves through.
    updateProfile: (id: string, data: unknown) =>
      mocks.patch(`/api/agent-profiles/${id}`, data),
    governanceByProfile: {},
    loadProfileGovernance: mocks.governance,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.patch.mockResolvedValue({});
  mocks.governance.mockResolvedValue({ workspaces: [], channel_mounts: [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render() {
  await act(async () => {
    root.render(<MainAgentCapabilitiesSection />);
  });
}

const configSelect = () => combobox('主 HappyClaw 模型配置');
const modelSelect = () => combobox('主 HappyClaw 模型');

async function optionsOf(select: HTMLButtonElement): Promise<string[]> {
  await act(async () => select.click());
  const texts = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].map((item) => item.textContent ?? '');
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  return texts;
}

async function save() {
  const button = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === '保存模型与能力',
  );
  if (!button) throw new Error('save button not rendered');
  await act(async () => button.click());
}

describe('主 HappyClaw model within its configuration', () => {
  test('picking a configuration, then a model, saves both', async () => {
    setStore(mainProfile());
    await render();
    await choose(configSelect(), 'GLM');
    expect(modelSelect().disabled).toBe(false);
    expect(await optionsOf(modelSelect())).toEqual([
      '连接默认（glm-5.3[1m]）',
      'glm-4.6',
    ]);
    await choose(modelSelect(), 'glm-4.6');
    await save();
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/agent-profiles/main',
      expect.objectContaining({ model_config_id: 'glm', model: 'glm-4.6' }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  test('switching the configuration resets the model to its default', async () => {
    setStore(mainProfile({ model_config_id: 'official', model: 'sonnet' }));
    await render();
    expect(modelSelect().textContent).toContain('sonnet');
    await choose(configSelect(), 'GLM');
    expect(modelSelect().textContent).toContain('连接默认（glm-5.3[1m]）');
    await save();
    const body = mocks.patch.mock.calls[0][1];
    expect(body).toMatchObject({ model_config_id: 'glm', model: null });
  });

  test('an automatic configuration leaves nothing to pick', async () => {
    setStore(mainProfile());
    await render();
    expect(modelSelect().disabled).toBe(true);
    expect(modelSelect().textContent).toContain('由模型配置决定');

    await choose(configSelect(), 'Claude 官方 · opus');
    await choose(modelSelect(), 'sonnet');
    await choose(configSelect(), '跟随默认模型');
    expect(modelSelect().disabled).toBe(true);
    // Back where it started: nothing to save.
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === '保存模型与能力',
    );
    expect(button?.disabled).toBe(true);
  });

  test('a binding to a hidden model shows it selected and lists the hidden ones', async () => {
    setStore(mainProfile({ model_config_id: 'official', model: 'haiku' }));
    await render();
    expect(modelSelect().textContent).toContain('haiku（已隐藏）');
    expect(await optionsOf(modelSelect())).toEqual([
      '连接默认（opus）',
      'sonnet',
      'haiku（已隐藏）',
    ]);
    // Unchanged, so nothing to save.
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === '保存模型与能力',
    );
    expect(button?.disabled).toBe(true);
  });

  test('an unchanged model is not sent with another change', async () => {
    setStore(mainProfile({ model_config_id: 'official', model: 'sonnet' }));
    await render();
    await choose(combobox('主 HappyClaw 推理努力档位'), '高');
    await save();
    expect(mocks.patch.mock.calls[0][1]).not.toHaveProperty('model');
  });

  test('a model the configuration no longer offers reads as such', async () => {
    setStore(mainProfile({ model_config_id: 'official' }));
    mocks.patch.mockRejectedValue({
      status: 400,
      message: 'Bad Request',
      body: { code: 'MODEL_NOT_IN_CONNECTION' },
    });
    await render();
    await choose(modelSelect(), 'sonnet');
    await save();
    expect(mocks.toastError).toHaveBeenCalledWith(
      '所选模型已不在该模型配置的模型列表里，请重新选择模型',
    );
  });

  test('an older server without model lists shows no model select and sends no model', async () => {
    setStore(
      mainProfile(),
      CONFIGS.map(({ models: _models, ...config }) => config),
    );
    await render();
    expect(
      container.querySelector(
        '[role="combobox"][aria-label="主 HappyClaw 模型"]',
      ),
    ).toBeNull();
    await choose(configSelect(), 'GLM');
    await save();
    expect(mocks.patch.mock.calls[0][1]).not.toHaveProperty('model');
    expect(mocks.patch.mock.calls[0][1]).toMatchObject({
      model_config_id: 'glm',
    });
  });

  test('saving only the model leaves the stored host Skills alone', async () => {
    // An admin's main HappyClaw under host_claude runs with every host Skill.
    setStore(
      mainProfile({
        runtime_policy: {
          ...mainProfile().runtime_policy,
          skills: {
            mode: 'inherit',
            ids: [],
            host: { mode: 'inherit', ids: [] },
          },
        },
      }),
    );
    await render();
    await choose(configSelect(), 'GLM');
    await save();
    expect(mocks.patch.mock.calls[0][1]).toEqual({ model_config_id: 'glm' });
  });

  test('host Skills of an older server follow the effective context source', async () => {
    const legacy = mainProfile();
    delete legacy.runtime_policy.skills.host;
    setStore({
      ...legacy,
      effective_runtime_policy: {
        ...legacy.runtime_policy,
        context: { ...legacy.runtime_policy.context!, source: 'host_claude' },
      },
    });
    await render();
    await choose(combobox('主 HappyClaw 推理努力档位'), '高');
    await save();
    expect(mocks.patch.mock.calls[0][1]).toMatchObject({
      runtime_policy: {
        reasoning: { effort: 'high' },
        skills: { host: { mode: 'inherit', ids: [] } },
      },
    });
  });

  test('asks before a save interrupts running conversations', async () => {
    setStore(mainProfile());
    mocks.governance.mockResolvedValue({
      workspaces: [
        { name: 'Home', active_conversations: 2 },
        { name: 'Idle', active_conversations: 0 },
      ],
      channel_mounts: [],
    });
    mocks.confirm.mockResolvedValueOnce(false);
    await render();
    await choose(configSelect(), 'GLM');
    await save();
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          '保存会中断 2 个正在进行的对话（「Home」2 个）',
        ),
      }),
    );
    expect(mocks.patch).not.toHaveBeenCalled();

    await save();
    expect(mocks.patch).toHaveBeenCalledOnce();
  });
});
