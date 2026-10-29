// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test, vi } from 'vitest';

import type { AgentInfo } from '../types';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { toast, store } = vi.hoisted(() => ({
  toast: { error: vi.fn(), warning: vi.fn() },
  store: {
    createConversation: vi.fn(),
    deleteAgentAction: vi.fn(),
    error: null as string | null,
    agents: {},
  },
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('../stores/chat', () => ({
  useChatStore: Object.assign(
    (select: (state: typeof store) => unknown) => select(store),
    { getState: () => store },
  ),
}));
vi.mock('../stores/confirm', () => ({ confirmDialog: vi.fn() }));

const { useSessionActions } = await import('./useSessionActions');

/** The hook as a component would use it. */
async function renderActions() {
  let actions!: ReturnType<typeof useSessionActions>;
  function Probe() {
    actions = useSessionActions();
    return null;
  }
  await act(async () => {
    createRoot(document.createElement('div')).render(<Probe />);
  });
  return actions;
}

const session = (worktree: AgentInfo['worktree']): AgentInfo =>
  ({ id: 's1', name: '新对话', worktree }) as AgentInfo;

describe('creating a session with its own worktree', () => {
  test('says which .worktreeinclude files were left out, without blocking', async () => {
    store.createConversation.mockResolvedValueOnce(
      session({
        branch: 'happyclaw/s1',
        base_commit: 'abc',
        status: 'active',
        broken_reason: null,
        include_incomplete: {
          reason: 'size_limit',
          copied_files: 3,
          skipped_files: ['data/huge.bin'],
        },
      }),
    );
    const actions = await renderActions();
    let created: AgentInfo | null = null;
    await act(async () => {
      created = await actions.createSession('web:ws', { worktree: true });
    });

    expect(created).toMatchObject({ id: 's1' });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(
      '部分 .worktreeinclude 文件没有复制到新 worktree',
      {
        description: expect.stringContaining('未复制的文件包括：data/huge.bin'),
      },
    );
  });

  test('a complete copy or a plain session shows nothing', async () => {
    toast.warning.mockClear();
    store.createConversation
      .mockResolvedValueOnce(
        session({
          branch: 'happyclaw/s1',
          base_commit: 'abc',
          status: 'active',
          broken_reason: null,
          include_incomplete: null,
        }),
      )
      .mockResolvedValueOnce(session(null));
    const actions = await renderActions();
    await act(async () => {
      await actions.createSession('web:ws', { worktree: true });
    });
    await act(async () => {
      await actions.createSession('web:ws');
    });
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
