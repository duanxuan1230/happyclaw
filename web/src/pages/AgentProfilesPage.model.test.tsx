// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { AgentProfile, ModelConfigOption } from '../types';
import { choose, combobox } from '../components/settings/test-helpers';

const mocks = vi.hoisted(() => ({
  profiles: [] as unknown[],
  modelConfigs: [] as unknown[],
  updateProfile: vi.fn(),
  createProfile: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../stores/agent-profiles', () => ({
  useAgentProfilesStore: () => ({
    profiles: mocks.profiles,
    modelConfigs: mocks.modelConfigs,
    loading: false,
    profilesError: null,
    loadProfiles: vi.fn(async () => undefined),
    refreshProfile: vi.fn(),
    loadProfileGovernance: vi.fn(async () => ({
      profile: mocks.profiles[0],
      workspaces: [],
      channel_mounts: [],
      runtime_cleanup_pending: false,
    })),
    retryRuntimeCleanup: vi.fn(),
    governanceByProfile: {},
    governanceLoading: {},
    governanceErrors: {},
    generateProfileDraft: vi.fn(),
    createProfile: mocks.createProfile,
    updateProfile: mocks.updateProfile,
    uploadProfileAvatar: vi.fn(),
    removeProfileAvatar: vi.fn(),
    deleteProfile: vi.fn(),
    setWorkspaceAgentProfile: vi.fn(),
  }),
}));
vi.mock('../stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'admin', role: 'admin' }, appearance: null }),
}));
vi.mock('../stores/skills', () => ({
  useSkillsStore: (selector: (state: unknown) => unknown) =>
    selector({
      skills: [],
      loading: false,
      error: null,
      loadSkills: vi.fn(async () => undefined),
    }),
}));
vi.mock('../stores/mcp-servers', () => ({
  useMcpServersStore: (selector: (state: unknown) => unknown) =>
    selector({
      servers: [],
      loading: false,
      error: null,
      loadServers: vi.fn(async () => undefined),
    }),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: mocks.toastError,
    warning: vi.fn(),
  }),
}));
vi.mock('../components/agents/AgentPromptAssistant', () => ({
  AgentPromptAssistant: () => null,
}));
vi.mock('../components/agents/AgentPromptEditor', () => ({
  AgentPromptEditor: () => null,
}));
vi.mock('../components/agents/EffectiveCapabilitiesPreview', () => ({
  EffectiveCapabilitiesPreview: () => null,
}));
vi.mock('../components/agents/AgentGovernanceSection', () => ({
  AgentGovernanceSection: () => null,
}));
vi.mock('../components/agents/PolicyResourcePicker', () => ({
  PolicyResourcePicker: () => null,
}));
vi.mock('../components/common/EmojiAvatar', () => ({
  EmojiAvatar: () => <div />,
}));
vi.mock('../components/common/EmojiPicker', () => ({
  EmojiPicker: () => <div />,
}));
vi.mock('../components/common/ColorPicker', () => ({
  ColorPicker: () => <div />,
}));

const { AgentProfilesPage } = await import('./AgentProfilesPage');

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
    id: 'relay',
    name: '中转站',
    type: 'third_party',
    enabled: true,
    anthropic_model: '',
    models: [{ id: 'deepseek-v4', hidden: false }],
  },
];

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'research',
    owner_user_id: 'admin',
    name: '调研智能体',
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
    is_default: false,
    status: 'active',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  document.body.innerHTML = '';
  root = null;
  container = null;
  mocks.profiles = [];
  mocks.modelConfigs = [];
  vi.clearAllMocks();
});

async function renderPage(profiles: AgentProfile[], configs = CONFIGS) {
  mocks.profiles = profiles;
  mocks.modelConfigs = configs;
  mocks.updateProfile.mockImplementation(
    async (_id: string, changes: Partial<AgentProfile>) => ({
      ...profiles[0],
      ...changes,
    }),
  );
  mocks.createProfile.mockImplementation(async () => profile({ id: 'new' }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const router = createMemoryRouter(
    [{ path: '/agent-profiles', element: <AgentProfilesPage /> }],
    {
      initialEntries: [
        profiles[0]
          ? `/agent-profiles?agent=${profiles[0].id}`
          : '/agent-profiles',
      ],
    },
  );
  await act(async () => {
    root?.render(<RouterProvider router={router} />);
  });
  await vi.waitFor(() =>
    expect(container?.textContent).toContain('推理努力档位'),
  );
}

const configSelect = () => combobox('智能体模型配置');
const modelSelect = () => combobox('智能体模型');

function buttonByText(text: string): HTMLButtonElement {
  const button = [
    ...container!.querySelectorAll<HTMLButtonElement>('button'),
  ].find((item) => item.textContent?.trim() === text);
  if (!button) throw new Error(`button ${text} not rendered`);
  return button;
}

describe('Agent model within its configuration', () => {
  test('picking a configuration, then a model, saves both', async () => {
    await renderPage([profile()]);
    expect(modelSelect().disabled).toBe(true);
    await choose(configSelect(), 'Claude 官方 · opus');
    await choose(modelSelect(), 'sonnet');
    await act(async () => buttonByText('保存').click());
    expect(mocks.updateProfile).toHaveBeenCalledWith('research', {
      model_config_id: 'official',
      model: 'sonnet',
    });
  });

  test('a model change alone carries its configuration along', async () => {
    await renderPage([profile({ model_config_id: 'official' })]);
    await choose(modelSelect(), 'sonnet');
    await act(async () => buttonByText('保存').click());
    expect(mocks.updateProfile).toHaveBeenCalledWith('research', {
      model_config_id: 'official',
      model: 'sonnet',
    });
  });

  test('going back to the default model sends the clear alone', async () => {
    await renderPage([
      profile({ model_config_id: 'official', model: 'sonnet' }),
    ]);
    await choose(modelSelect(), '连接默认（opus）');
    await act(async () => buttonByText('保存').click());
    expect(mocks.updateProfile).toHaveBeenCalledWith('research', {
      model: null,
    });
  });

  test('switching the configuration resets the model', async () => {
    await renderPage([
      profile({ model_config_id: 'official', model: 'sonnet' }),
    ]);
    expect(modelSelect().textContent).toContain('sonnet');
    await choose(configSelect(), '中转站');
    expect(modelSelect().textContent).toContain('连接默认（由中转站决定）');
    await act(async () => buttonByText('保存').click());
    expect(mocks.updateProfile).toHaveBeenCalledWith('research', {
      model_config_id: 'relay',
      model: null,
    });
  });

  test('following the automatic choice disables the model select', async () => {
    await renderPage([
      profile({ model_config_id: 'official', model: 'sonnet' }),
    ]);
    expect(modelSelect().disabled).toBe(false);
    await choose(configSelect(), '跟随默认模型');
    expect(modelSelect().disabled).toBe(true);
    expect(modelSelect().textContent).toContain('由模型配置决定');
  });

  test('a profile pinned to a hidden model shows it selected', async () => {
    await renderPage([
      profile({ model_config_id: 'official', model: 'haiku' }),
    ]);
    expect(modelSelect().textContent).toContain('haiku（已隐藏）');
    expect(container!.textContent).not.toContain('有未保存修改');
  });

  test('a refused model reads as such', async () => {
    await renderPage([profile({ model_config_id: 'official' })]);
    mocks.updateProfile.mockRejectedValue({
      status: 400,
      message: 'Bad Request',
      body: { code: 'MODEL_NOT_IN_CONNECTION' },
    });
    await choose(modelSelect(), 'sonnet');
    await act(async () => buttonByText('保存').click());
    expect(mocks.toastError).toHaveBeenCalledWith(
      '所选模型已不在该模型配置的模型列表里，请重新选择模型',
    );
  });

  test('a new Agent is created with its model and the summary names it', async () => {
    await renderPage([profile()]);
    await act(async () => buttonByText('新建').click());
    await act(async () => buttonByText('空白创建').click());
    const name = container!.querySelector<HTMLInputElement>(
      '#agent-profile-name',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(name, '新智能体');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await choose(configSelect(), 'Claude 官方 · opus');
    await choose(modelSelect(), 'sonnet');
    await act(async () => buttonByText('5确认创建').click());
    expect(container!.textContent).toContain('Claude 官方 · sonnet');
    await act(async () => buttonByText('创建智能体').click());
    expect(mocks.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '新智能体',
        model_config_id: 'official',
        model: 'sonnet',
      }),
    );
  });

  test('an older server without model lists shows no model select', async () => {
    await renderPage(
      [profile()],
      CONFIGS.map(({ models: _models, ...config }) => config),
    );
    expect(
      container!.querySelector('[role="combobox"][aria-label="智能体模型"]'),
    ).toBeNull();
  });
});
