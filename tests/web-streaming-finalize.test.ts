import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message, StreamEvent } from '../web/src/stores/chat';

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: vi.fn(),
    delete: vi.fn(),
  },
  computeUploadTimeoutMs: vi.fn(() => 8000),
}));

vi.mock('../web/src/api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('../web/src/stores/files', () => ({
  useFileStore: { getState: () => ({ loadFiles: vi.fn() }) },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));

vi.mock('../web/src/utils/toast', () => ({
  showToast: vi.fn(),
  notifyIfHidden: vi.fn(),
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: vi.fn(),
}));

vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(async () => undefined),
  deleteGroupMessageSnapshots: vi.fn(async () => undefined),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: vi.fn(async () => undefined),
}));

const { useChatStore, MAX_STEPS_CACHE_CHARS } =
  await import('../web/src/stores/chat');
const { hasVisibleWork } = await import('../web/src/lib/process-visibility');
const initialState = useChatStore.getState();

const JID = 'web:finalize';
const AGENT = 'agent-1';
const AGENT_JID = `${JID}#agent:${AGENT}`;

const rafCallbacks: FrameRequestCallback[] = [];
function flushRaf(): void {
  for (const cb of rafCallbacks.splice(0)) cb(0);
}

function reset(): void {
  useChatStore.setState(
    {
      ...initialState,
      groups: {},
      messages: { [JID]: [] },
      waiting: {},
      activeRuns: {},
      streaming: {},
      thinkingCache: {},
      thinkingDurationCache: {},
      traceCache: {},
      stepsCache: {},
      stopRequests: {},
      settledStreaming: {},
      pendingThinking: {},
      pendingThinkingDuration: {},
      clearing: {},
      agents: {},
      agentStreaming: {},
      activeAgentTab: {},
      agentMessages: { [AGENT]: [] },
      agentWaiting: {},
      agentHasMore: {},
      unreadReplies: {},
    },
    true,
  );
}

function emit(event: StreamEvent, runId: string, agentId?: string): void {
  useChatStore.getState().handleStreamEvent(JID, event, agentId, runId);
}

function finalMessage(
  id: string,
  content: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    chat_jid: JID,
    sender: 'happyclaw-agent',
    sender_name: 'HappyClaw',
    content,
    timestamp: '2026-10-10T00:00:00.000Z',
    is_from_me: true,
    source_kind: 'sdk_final',
    finalization_reason: 'completed',
    turn_id: 'turn-1',
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rafCallbacks.length = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks[id - 1] = () => {};
  });
  reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('run_finished before the final message', () => {
  function streamAReply(runtimeJid: string, agentId?: string) {
    useChatStore.getState().handleRunStarted(runtimeJid, 'run-a');
    emit(
      { eventType: 'thinking_delta', text: '先想一想。', turnId: 'turn-1' },
      'run-a',
      agentId,
    );
    flushRaf();
    emit(
      {
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'tool-1',
        toolInputSummary: 'ls',
        turnId: 'turn-1',
      },
      'run-a',
      agentId,
    );
    emit(
      { eventType: 'tool_use_end', toolUseId: 'tool-1', turnId: 'turn-1' },
      'run-a',
      agentId,
    );
    emit(
      { eventType: 'text_delta', text: '最终答案。', turnId: 'turn-1' },
      'run-a',
      agentId,
    );
    // The last frame is still waiting for rAF when the run ends.
  }

  it('keeps the main reply on screen until its final replaces it in one update', () => {
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');

    let state = useChatStore.getState();
    const settled = state.settledStreaming[JID];
    expect(settled?.settling).toBe(true);
    expect(settled?.runId).toBe('run-a');
    // The frame buffered for rAF was applied, not dropped.
    expect(settled?.partialText).toBe('最终答案。');
    expect(settled?.activeTools).toEqual([]);
    // The live slot is free for the next run.
    expect(state.streaming[JID]).toBeUndefined();
    expect(state.waiting[JID]).toBe(false);

    const updates: Array<{ settled: boolean; messages: number }> = [];
    const unsubscribe = useChatStore.subscribe((s) =>
      updates.push({
        settled: !!s.settledStreaming[JID],
        messages: s.messages[JID]?.length ?? 0,
      }),
    );
    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-1', '最终答案。'));
    unsubscribe();

    // Never a state with neither the card nor the final message.
    expect(updates).toEqual([{ settled: false, messages: 1 }]);
    state = useChatStore.getState();
    expect(state.thinkingCache['final-1']).toBe('先想一想。');
    expect(state.thinkingDurationCache['final-1']).toBeGreaterThanOrEqual(0);
    expect(
      state.traceCache['final-1']?.some((e) => e.title === '工具 Bash'),
    ).toBe(true);
  });

  it('keeps a session reply settled and carries its thinking to the final', () => {
    useChatStore.setState({ agentWaiting: { [AGENT]: true } });
    streamAReply(AGENT_JID, AGENT);
    useChatStore.getState().handleRunFinished(AGENT_JID, 'run-a');

    let state = useChatStore.getState();
    expect(state.settledStreaming[AGENT_JID]?.partialText).toBe('最终答案。');
    expect(state.agentStreaming[AGENT]).toBeUndefined();

    useChatStore
      .getState()
      .handleWsNewMessage(
        JID,
        finalMessage('agent-final', '最终答案。', { chat_jid: AGENT_JID }),
        AGENT,
      );
    state = useChatStore.getState();
    expect(state.settledStreaming[AGENT_JID]).toBeUndefined();
    expect(state.agentMessages[AGENT].map((m) => m.id)).toEqual([
      'agent-final',
    ]);
    expect(state.thinkingCache['agent-final']).toBe('先想一想。');
    expect(state.traceCache['agent-final']?.length).toBeGreaterThan(0);
  });

  it('re-syncs a settled card whose final never arrives, then lets it go', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    apiGetMock.mockResolvedValueOnce({
      messages: [finalMessage('final-rest', '最终答案。')],
    });

    await vi.advanceTimersByTimeAsync(1600);

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    const state = useChatStore.getState();
    expect(state.settledStreaming[JID]).toBeUndefined();
    expect(state.messages[JID].map((m) => m.id)).toEqual(['final-rest']);
    expect(state.thinkingCache['final-rest']).toBe('先想一想。');
  });

  it('drops a settled card when the re-sync finds nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    apiGetMock.mockResolvedValueOnce({ messages: [] });

    await vi.advanceTimersByTimeAsync(1600);

    const state = useChatStore.getState();
    expect(state.settledStreaming[JID]).toBeUndefined();
    // Not left for a later, unrelated reply to pick up.
    expect(state.pendingThinking[JID]).toBeUndefined();
  });

  it('keeps the settled card across the next queued run until the final lands', () => {
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    useChatStore.getState().handleRunStarted(JID, 'run-b');

    let state = useChatStore.getState();
    expect(state.settledStreaming[JID]?.partialText).toBe('最终答案。');
    expect(state.waiting[JID]).toBe(true);

    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-a', '最终答案。'));
    state = useChatStore.getState();
    // A's card became A's reply; B (still preparing) has no projection yet.
    expect(state.settledStreaming[JID]).toBeUndefined();
    expect(state.streaming[JID]).toBeUndefined();
    expect(state.thinkingCache['final-a']).toBe('先想一想。');
    expect(state.waiting[JID]).toBe(true);
  });

  it("keeps A's settled card while B streams before A's final, then swaps only A", () => {
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    useChatStore.getState().handleRunStarted(JID, 'run-b');
    // The SDK opens every request with a status; B then streams text.
    emit(
      { eventType: 'status', statusText: 'requesting', turnId: 'turn-2' },
      'run-b',
    );
    emit(
      { eventType: 'text_delta', text: 'B 的回答', turnId: 'turn-2' },
      'run-b',
    );
    flushRaf();

    let state = useChatStore.getState();
    expect(state.settledStreaming[JID]?.partialText).toBe('最终答案。');
    expect(state.streaming[JID]?.partialText).toBe('B 的回答');

    // A reconnect snapshot for B leaves A alone too.
    useChatStore.getState().handleStreamSnapshot(
      JID,
      {
        partialText: 'B 的回答，更多',
        activeTools: [],
        recentEvents: [],
        systemStatus: null,
        turnId: 'turn-2',
      },
      undefined,
      'run-b',
    );
    expect(useChatStore.getState().settledStreaming[JID]?.partialText).toBe(
      '最终答案。',
    );

    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-a', '最终答案。'));
    state = useChatStore.getState();
    expect(state.settledStreaming[JID]).toBeUndefined();
    expect(state.thinkingCache['final-a']).toBe('先想一想。');
    expect(state.traceCache['final-a']?.length).toBeGreaterThan(0);
    expect(state.streaming[JID]?.partialText).toBe('B 的回答，更多');
    expect(state.waiting[JID]).toBe(true);
  });

  it("settles a replaced attempt's card when the next run starts without run_finished", () => {
    streamAReply(JID);
    useChatStore.getState().handleRunStarted(JID, 'run-b');
    const state = useChatStore.getState();
    expect(state.settledStreaming[JID]?.runId).toBe('run-a');
    expect(state.streaming[JID]).toBeUndefined();
  });

  it('replaces the settled card of a group-mode scheduled task with its result', () => {
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');

    const updates: Array<{ settled: boolean; ids: string[] }> = [];
    const unsubscribe = useChatStore.subscribe((s) =>
      updates.push({
        settled: !!s.settledStreaming[JID],
        ids: (s.messages[JID] ?? []).map((m) => m.id),
      }),
    );
    useChatStore.getState().handleWsNewMessage(
      JID,
      finalMessage('sched-1', '## 定时任务结果\n\n最终答案。', {
        source_kind: 'scheduled_task_result',
      }),
      undefined,
      'scheduled_task',
    );
    unsubscribe();

    // One update: the result in, the card out. Never both on screen.
    expect(updates).toEqual([{ settled: false, ids: ['sched-1'] }]);
    const state = useChatStore.getState();
    expect(state.thinkingCache['sched-1']).toBe('先想一想。');
    expect(state.pendingThinking[JID]).toBeUndefined();
  });

  it("leaves another turn's settled card for its own final", () => {
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    useChatStore.getState().handleWsNewMessage(
      JID,
      finalMessage('sched-other', '另一个任务', {
        source_kind: 'scheduled_task_result',
        turn_id: 'turn-other',
      }),
      undefined,
      'scheduled_task',
    );
    const state = useChatStore.getState();
    expect(state.settledStreaming[JID]?.partialText).toBe('最终答案。');
    expect(state.thinkingCache['sched-other']).toBeUndefined();
  });

  it('ignores a run_finished for another attempt', () => {
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-other');
    flushRaf();
    expect(useChatStore.getState().settledStreaming[JID]).toBeUndefined();
    expect(useChatStore.getState().streaming[JID]?.partialText).toBe(
      '最终答案。',
    );
    expect(useChatStore.getState().waiting[JID]).toBe(true);
  });
});

describe('the steps a finished reply keeps', () => {
  function streamSteps(runtimeJid: string, agentId?: string) {
    useChatStore.getState().handleRunStarted(runtimeJid, 'run-a');
    emit(
      { eventType: 'thinking_delta', text: '先想一想。', turnId: 'turn-1' },
      'run-a',
      agentId,
    );
    flushRaf();
    emit(
      {
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'tool-1',
        toolInputSummary: 'ls',
        turnId: 'turn-1',
      },
      'run-a',
      agentId,
    );
    emit(
      { eventType: 'tool_use_end', toolUseId: 'tool-1', turnId: 'turn-1' },
      'run-a',
      agentId,
    );
    emit(
      { eventType: 'text_delta', text: '最终答案。', turnId: 'turn-1' },
      'run-a',
      agentId,
    );
  }

  it('moves the steps of the settled card onto the final message', () => {
    streamSteps(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    const settled = useChatStore.getState().settledStreaming[JID];
    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-1', '最终答案。'));

    const cached = useChatStore.getState().stepsCache['final-1'];
    // The card and the message list the same steps, in the same order.
    expect(cached.steps).toEqual(settled?.steps);
    expect(cached.steps.map((step) => step.kind)).toEqual([
      'thinking',
      'tool',
      'text',
    ]);
    expect(cached.steps.every((step) => step.status !== 'running')).toBe(true);
    expect(cached.dropped).toBe(0);
  });

  it('carries the count of steps dropped from the front', () => {
    streamSteps(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    useChatStore.setState((s) => ({
      settledStreaming: {
        [JID]: { ...s.settledStreaming[JID]!, stepsDropped: 7 },
      },
    }));
    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-1', '最终答案。'));
    expect(useChatStore.getState().stepsCache['final-1'].dropped).toBe(7);
  });

  it('moves the steps of a session reply onto its final', () => {
    useChatStore.setState({ agentWaiting: { [AGENT]: true } });
    streamSteps(AGENT_JID, AGENT);
    useChatStore.getState().handleRunFinished(AGENT_JID, 'run-a');
    useChatStore
      .getState()
      .handleWsNewMessage(
        JID,
        finalMessage('agent-final', '最终答案。', { chat_jid: AGENT_JID }),
        AGENT,
      );
    expect(
      useChatStore
        .getState()
        .stepsCache['agent-final']?.steps.map((step) => step.kind),
    ).toEqual(['thinking', 'tool', 'text']);
  });

  it('keeps the steps of a card a stop froze, its tool marked as stopped', () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    emit(
      { eventType: 'text_delta', text: '已输出', turnId: 'turn-1' },
      'run-a',
    );
    flushRaf();
    emit(
      {
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'tool-1',
        toolInputSummary: 'sleep 60',
        turnId: 'turn-1',
      },
      'run-a',
    );
    emit(
      { eventType: 'text_delta', text: '，被打断', turnId: 'turn-1' },
      'run-a',
    );
    flushRaf();
    useChatStore.getState().handleStreamEvent(
      JID,
      {
        eventType: 'status',
        statusText: 'interrupted',
        turnId: 'turn-1',
      },
      undefined,
      'run-a',
    );
    expect(useChatStore.getState().streaming[JID]?.interrupted).toBe(true);
    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-1', '已输出，被打断'));

    const bash = useChatStore
      .getState()
      .stepsCache['final-1']?.steps.find((step) => step.kind === 'tool');
    expect(bash?.status).toBe('error');
  });

  it('closes a step that a never-settled projection still had running', () => {
    streamSteps(JID);
    emit(
      {
        eventType: 'tool_use_start',
        toolName: 'Read',
        toolUseId: 'tool-2',
        toolInputSummary: 'a.ts',
        turnId: 'turn-1',
      },
      'run-a',
    );
    expect(
      useChatStore
        .getState()
        .streaming[JID]?.steps?.some((step) => step.status === 'running'),
    ).toBe(true);
    // No run_finished and no active run: the final replaces the live card.
    useChatStore.setState({ activeRuns: {} });
    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-1', '最终答案。'));
    const steps = useChatStore.getState().stepsCache['final-1']?.steps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some((step) => step.status === 'running')).toBe(false);
  });

  it('keeps nothing for a reply that only answered', () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    emit(
      { eventType: 'text_delta', text: '直接回答。', turnId: 'turn-1' },
      'run-a',
    );
    flushRaf();
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-1', '直接回答。'));
    expect(useChatStore.getState().stepsCache['final-1']).toBeUndefined();
  });
});

describe('the steps of a tab that joined the run part-way', () => {
  const snapshot = (turnId = 'turn-1') => ({
    partialText: '最终答案。',
    thinkingText: '先想一想。',
    activeTools: [],
    recentEvents: [],
    traceEvents: [
      {
        id: 'r1',
        timestamp: Date.now() - 5000,
        kind: 'tool' as const,
        title: '工具 Bash',
        summary: 'ls',
        toolUseId: 'tool-1',
      },
    ],
    systemStatus: null,
    turnId,
  });
  const finish = () => {
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-1', '最终答案。'));
  };

  beforeEach(() => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
  });

  it('are provisional on the final message: rebuilt, not exact', () => {
    useChatStore
      .getState()
      .handleStreamSnapshot(JID, snapshot(), undefined, 'run-a');
    // Events that follow the snapshot are exact, but the list is still partly a
    // rebuilt one.
    emit(
      {
        eventType: 'tool_use_start',
        toolName: 'Read',
        toolUseId: 'tool-2',
        toolInputSummary: 'a.ts',
        turnId: 'turn-1',
      },
      'run-a',
    );
    emit(
      { eventType: 'tool_use_end', toolUseId: 'tool-2', turnId: 'turn-1' },
      'run-a',
    );
    finish();
    const cached = useChatStore.getState().stepsCache['final-1'];
    expect(cached?.steps.some((step) => step.toolName === 'Bash')).toBe(true);
    expect(cached?.steps.some((step) => step.toolName === 'Read')).toBe(true);
    expect(cached?.provisional).toBe(true);
  });

  it('are exact when this tab saw the whole run, whatever a snapshot says', () => {
    emit(
      {
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'tool-1',
        toolInputSummary: 'ls',
        turnId: 'turn-1',
      },
      'run-a',
    );
    emit(
      { eventType: 'tool_use_end', toolUseId: 'tool-1', turnId: 'turn-1' },
      'run-a',
    );
    useChatStore
      .getState()
      .handleStreamSnapshot(JID, snapshot(), undefined, 'run-a');
    finish();
    const cached = useChatStore.getState().stepsCache['final-1'];
    expect(cached?.steps.some((step) => step.toolName === 'Bash')).toBe(true);
    expect(cached?.provisional).toBeUndefined();
  });

  it('are exact on a reply that streamed here from its first event', () => {
    emit(
      { eventType: 'thinking_delta', text: '先想一想。', turnId: 'turn-1' },
      'run-a',
    );
    flushRaf();
    emit(
      {
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'tool-1',
        toolInputSummary: 'ls',
        turnId: 'turn-1',
      },
      'run-a',
    );
    emit(
      { eventType: 'tool_use_end', toolUseId: 'tool-1', turnId: 'turn-1' },
      'run-a',
    );
    finish();
    const cached = useChatStore.getState().stepsCache['final-1'];
    expect(cached?.steps.length).toBeGreaterThan(0);
    expect(cached?.provisional).toBeUndefined();
  });
});

describe('the trace a finished reply keeps', () => {
  function streamDenialThenTools(tools: number) {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    emit(
      {
        eventType: 'permission_denied',
        toolName: 'Write',
        summary: 'a.ts 被拒绝',
        turnId: 'turn-1',
      },
      'run-a',
    );
    for (let i = 0; i < tools; i += 1) {
      emit(
        {
          eventType: 'tool_use_start',
          toolName: 'Read',
          toolUseId: `tool-${i}`,
          toolInputSummary: `f${i}.ts`,
          turnId: 'turn-1',
        },
        'run-a',
      );
      emit(
        { eventType: 'tool_use_end', toolUseId: `tool-${i}`, turnId: 'turn-1' },
        'run-a',
      );
    }
    emit(
      { eventType: 'text_delta', text: '最终答案。', turnId: 'turn-1' },
      'run-a',
    );
  }

  it('keeps a denied permission from early in a long run', () => {
    streamDenialThenTools(40);
    const live = useChatStore.getState().streaming[JID]!.traceEvents;
    expect(live.length).toBeGreaterThan(60);
    expect(live[0].kind).toBe('permission');

    useChatStore.getState().handleRunFinished(JID, 'run-a');
    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-1', '最终答案。'));
    const rows = useChatStore.getState().traceCache['final-1'];
    // The banner the card showed is still there; the rest is the newest rows.
    expect(rows.filter((row) => row.kind === 'permission')).toHaveLength(1);
    expect(rows).toHaveLength(60);
    expect(rows[0].kind).toBe('permission');
    expect(rows.at(-1)).toEqual(live.at(-1));
  });

  it('leaves a trace within the cap as it is', () => {
    streamDenialThenTools(3);
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-1', '最终答案。'));
    const rows = useChatStore.getState().traceCache['final-1'];
    expect(rows[0].kind).toBe('permission');
    expect(rows.length).toBeLessThan(60);
  });
});

describe('reconnect snapshot', () => {
  const snapshot = (partialText: string, turnId = 'turn-1') => ({
    partialText,
    activeTools: [],
    recentEvents: [],
    systemStatus: null,
    turnId,
  });

  beforeEach(() => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    emit(
      {
        eventType: 'text_delta',
        text: 'Kubernetes 调度入门：' + '内容'.repeat(100),
        turnId: 'turn-1',
      },
      'run-a',
    );
    flushRaf();
  });

  it('never replaces the longer text of the same turn with a shorter tail', () => {
    const local = useChatStore.getState().streaming[JID]!.partialText;
    useChatStore
      .getState()
      .handleStreamSnapshot(JID, snapshot('…\n\n内容内容'), undefined, 'run-a');
    expect(useChatStore.getState().streaming[JID]?.partialText).toBe(local);
  });

  it('takes the snapshot when it has text this tab missed', () => {
    const full = useChatStore.getState().streaming[JID]!.partialText + '新增';
    useChatStore
      .getState()
      .handleStreamSnapshot(JID, snapshot(full), undefined, 'run-a');
    expect(useChatStore.getState().streaming[JID]?.partialText).toBe(full);
  });

  it('takes the snapshot of a newer turn', () => {
    useChatStore
      .getState()
      .handleStreamSnapshot(
        JID,
        snapshot('新一轮', 'turn-2'),
        undefined,
        'run-a',
      );
    expect(useChatStore.getState().streaming[JID]?.partialText).toBe('新一轮');
  });
});

describe('tool and thinking status', () => {
  beforeEach(() => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
  });

  it('ends a tool on its result and returns the phase to the model', () => {
    emit(
      { eventType: 'tool_use_start', toolName: 'Glob', toolUseId: 'g1' },
      'run-a',
    );
    emit(
      { eventType: 'tool_use_start', toolName: 'Task', toolUseId: 't1' },
      'run-a',
    );
    emit(
      { eventType: 'tool_result', toolUseId: 'g1', toolResult: 'a.ts' },
      'run-a',
    );
    emit(
      { eventType: 'tool_result', toolUseId: 't1', toolResult: 'launched' },
      'run-a',
    );
    const stream = useChatStore.getState().streaming[JID]!;
    // Task keeps its own lifecycle (task_notification / tool_use_end).
    expect(stream.activeTools.map((t) => t.toolUseId)).toEqual(['t1']);
    expect(stream.awaitingModel).toBe(true);
  });

  it('replays mixed thinking and text of one frame in arrival order', () => {
    emit({ eventType: 'thinking_delta', text: '想' }, 'run-a');
    emit({ eventType: 'text_delta', text: '答' }, 'run-a');
    flushRaf();
    expect(useChatStore.getState().streaming[JID]?.isThinking).toBe(false);

    emit({ eventType: 'text_delta', text: '再答' }, 'run-a');
    emit({ eventType: 'thinking_delta', text: '再想' }, 'run-a');
    flushRaf();
    expect(useChatStore.getState().streaming[JID]?.isThinking).toBe(true);
  });

  it('times a late thinking burst from the model request, not its first delta', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
    emit({ eventType: 'status', statusText: 'requesting' }, 'run-a');
    // The model reasons silently, then its thinking arrives in one burst.
    vi.setSystemTime(new Date('2026-10-10T00:00:14.600Z'));
    emit({ eventType: 'thinking_delta', text: '整段思考' }, 'run-a');
    emit({ eventType: 'text_delta', text: '回答' }, 'run-a');
    flushRaf();
    expect(
      useChatStore.getState().streaming[JID]?.thinkingDurationMs,
    ).toBeGreaterThanOrEqual(14_000);
  });

  it('clears the deep-thinking heartbeat once text starts', () => {
    emit({ eventType: 'status', statusText: '正在深入分析…' }, 'run-a');
    expect(useChatStore.getState().streaming[JID]?.systemStatus).toBe(
      '正在深入分析…',
    );
    emit({ eventType: 'text_delta', text: '开始回答' }, 'run-a');
    flushRaf();
    expect(useChatStore.getState().streaming[JID]?.systemStatus).toBeNull();
  });
});

describe('stop and interrupt', () => {
  it('shows a stop at once and clears it when the run ends', async () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    apiPostMock.mockResolvedValueOnce({ success: true, interrupted: true });
    const pending = useChatStore.getState().interruptQuery(JID);
    expect(useChatStore.getState().stopRequests[JID]).toBeTypeOf('number');
    await pending;
    expect(useChatStore.getState().stopRequests[JID]).toBeTypeOf('number');
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    expect(useChatStore.getState().stopRequests[JID]).toBeUndefined();
  });

  it('withdraws the stop when the request fails', async () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    apiPostMock.mockRejectedValueOnce(new Error('offline'));
    await useChatStore.getState().interruptQuery(JID);
    expect(useChatStore.getState().stopRequests[JID]).toBeUndefined();
  });

  it('keeps a stopped session card frozen against late deltas', () => {
    useChatStore.setState({ agentWaiting: { [AGENT]: true } });
    useChatStore.getState().handleRunStarted(AGENT_JID, 'run-a');
    emit({ eventType: 'text_delta', text: '已输出' }, 'run-a', AGENT);
    flushRaf();
    emit({ eventType: 'status', statusText: 'interrupted' }, 'run-a', AGENT);
    emit({ eventType: 'text_delta', text: '迟到' }, 'run-a', AGENT);
    flushRaf();
    emit(
      { eventType: 'tool_use_start', toolName: 'Bash', toolUseId: 'x' },
      'run-a',
      AGENT,
    );
    const card = useChatStore.getState().agentStreaming[AGENT]!;
    expect(card.interrupted).toBe(true);
    expect(card.partialText).toBe('已输出');
    expect(card.activeTools).toEqual([]);
  });
});

describe('dead streaming persistence', () => {
  it('no longer writes streaming state to sessionStorage', () => {
    const store = fs.readFileSync(
      path.join(process.cwd(), 'web/src/stores/chat.ts'),
      'utf8',
    );
    expect(store).not.toMatch(/hc_streaming|sessionStorage/);
  });
});

describe('session running state', () => {
  it('does not count a settled or stopped session card as running', async () => {
    const { isLiveStream } = await import('../web/src/stores/chat');
    useChatStore.setState({ agentWaiting: { [AGENT]: true } });
    useChatStore.getState().handleRunStarted(AGENT_JID, 'run-a');
    emit({ eventType: 'text_delta', text: '输出中' }, 'run-a', AGENT);
    flushRaf();
    expect(isLiveStream(useChatStore.getState().agentStreaming[AGENT])).toBe(
      true,
    );

    emit({ eventType: 'status', statusText: 'interrupted' }, 'run-a', AGENT);
    expect(isLiveStream(useChatStore.getState().agentStreaming[AGENT])).toBe(
      false,
    );

    useChatStore.getState().handleRunFinished(AGENT_JID, 'run-a');
    const state = useChatStore.getState();
    // The frozen card moved out of the live slot: no stop button, no spinner.
    expect(state.agentStreaming[AGENT]).toBeUndefined();
    expect(state.agentWaiting[AGENT]).toBe(false);
    expect(state.settledStreaming[AGENT_JID]?.interrupted).toBe(true);
  });
});

describe('streaming text cap', () => {
  it('cuts past the cap once with headroom instead of on every frame', () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    const paragraph = `${'长回复内容。'.repeat(80)}\n\n`;
    emit({ eventType: 'text_delta', text: paragraph.repeat(420) }, 'run-a');
    flushRaf();
    const cut = useChatStore.getState().streaming[JID]!.partialText;
    expect(cut.startsWith('…\n\n')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(200_000 * 0.9 + 3);

    // The next deltas append without another cut.
    emit({ eventType: 'text_delta', text: '继续' }, 'run-a');
    flushRaf();
    const next = useChatStore.getState().streaming[JID]!.partialText;
    expect(next).toBe(`${cut}继续`);
  });
});

describe('the steps cache across a finish', () => {
  const entry = (label: string) => ({
    steps: [
      {
        id: `thinking-${label}`,
        kind: 'thinking' as const,
        at: 1,
        status: 'done' as const,
        text: 'x'.repeat(1_000_000),
      },
    ],
    dropped: 0,
  });
  const room = Math.floor(MAX_STEPS_CACHE_CHARS / 1_000_000);

  function streamAndFinish() {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    emit(
      { eventType: 'thinking_delta', text: '先想一想。', turnId: 'turn-1' },
      'run-a',
    );
    flushRaf();
    emit(
      {
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'tool-1',
        toolInputSummary: 'ls',
        turnId: 'turn-1',
      },
      'run-a',
    );
    emit(
      { eventType: 'tool_use_end', toolUseId: 'tool-1', turnId: 'turn-1' },
      'run-a',
    );
    emit(
      { eventType: 'text_delta', text: '最终答案。', turnId: 'turn-1' },
      'run-a',
    );
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-1', '最终答案。'));
  }

  it('lets go of the oldest entries once the finished reply takes it past the limit', () => {
    const ids = Array.from({ length: room }, (_, i) => `old-${i}`);
    useChatStore.setState({
      stepsCache: Object.fromEntries(ids.map((id) => [id, entry(id)])),
    });
    streamAndFinish();
    const keys = Object.keys(useChatStore.getState().stepsCache);
    expect(keys).not.toContain('old-0');
    expect(keys).toContain('old-1');
    expect(keys.at(-1)).toBe('final-1');
  });

  it('keeps what is on screen, and leaves the cache alone within the limit', () => {
    const ids = Array.from({ length: room }, (_, i) => `old-${i}`);
    useChatStore.setState({
      stepsCache: Object.fromEntries(ids.map((id) => [id, entry(id)])),
      currentGroup: JID,
      messages: { [JID]: [finalMessage('old-0', '旧的回复')] },
    });
    streamAndFinish();
    const keys = Object.keys(useChatStore.getState().stepsCache);
    expect(keys).toContain('old-0');
    expect(keys).not.toContain('old-1');

    reset();
    useChatStore.setState({ stepsCache: { 'old-0': entry('old-0') } });
    streamAndFinish();
    expect(Object.keys(useChatStore.getState().stepsCache)).toEqual([
      'old-0',
      'final-1',
    ]);
  });
});

/** What is on screen after each store update one call makes. */
function updatesOf(fn: () => void, runtimeJid = JID, agentId?: string) {
  const updates: Array<{ live: boolean; settled: boolean; ids: string[] }> = [];
  const unsubscribe = useChatStore.subscribe((s) =>
    updates.push({
      live: agentId ? !!s.agentStreaming[agentId] : !!s.streaming[JID],
      settled: !!s.settledStreaming[runtimeJid],
      ids: (agentId ? s.agentMessages[agentId] : s.messages[JID]).map(
        (m) => m.id,
      ),
    }),
  );
  fn();
  unsubscribe();
  return updates;
}

describe('a final that arrives while its run is still closing', () => {
  // A final can reach the Web while its run is still closing, before
  // run_finished. The live card of that very turn settles in place; anything
  // else is left alone.
  interface Turn {
    turnId: string;
    inputTurnId?: string;
  }

  function streamTurn(
    runId: string,
    turn: Turn,
    agentId?: string,
    answer = '最终答案。',
  ) {
    emit(
      { eventType: 'thinking_delta', text: `想一想 ${runId}`, ...turn },
      runId,
      agentId,
    );
    flushRaf();
    emit(
      {
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: `tool-${runId}`,
        toolInputSummary: 'ls',
        ...turn,
      },
      runId,
      agentId,
    );
    emit(
      { eventType: 'tool_use_end', toolUseId: `tool-${runId}`, ...turn },
      runId,
      agentId,
    );
    // The last frame is still waiting for rAF when the final arrives.
    emit({ eventType: 'text_delta', text: answer, ...turn }, runId, agentId);
  }

  it('settles a cold start in place, in one update, and run_finished brings nothing back', () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    // A cold start's turn is its input: the frames need not name it.
    streamTurn('run-a', { turnId: 'turn-1' });

    const updates = updatesOf(() =>
      useChatStore
        .getState()
        .handleWsNewMessage(JID, finalMessage('final-1', '最终答案。')),
    );
    // The flushed frame, then one update: the reply in, the card out.
    expect(updates.at(-1)).toEqual({
      live: false,
      settled: false,
      ids: ['final-1'],
    });
    expect(updates.filter((u) => u.ids.length > 0)).toHaveLength(1);

    let state = useChatStore.getState();
    expect(state.thinkingCache['final-1']).toBe('想一想 run-a');
    expect(state.stepsCache['final-1']?.steps.length).toBeGreaterThan(0);
    expect(
      state.traceCache['final-1']?.some((e) => e.title === '工具 Bash'),
    ).toBe(true);
    // The run is still closing: the composer can stop it, and its card shows
    // nothing meanwhile.
    expect(state.activeRuns[JID]?.answered).toBe('turn-1');
    expect(state.waiting[JID]).toBe(true);

    useChatStore.getState().handleRunFinished(JID, 'run-a');
    state = useChatStore.getState();
    expect(state.settledStreaming[JID]).toBeUndefined();
    expect(state.streaming[JID]).toBeUndefined();
    expect(state.waiting[JID]).toBe(false);
    expect(state.activeRuns[JID]).toBeUndefined();
  });

  it("settles a warm turn by the input its frames name, not the Runner's own turn", () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    streamTurn('run-a', {
      turnId: 'presentation-7',
      inputTurnId: 'delivery-7',
    });

    useChatStore.getState().handleWsNewMessage(
      JID,
      finalMessage('final-7', '最终答案。', {
        turn_id: 'delivery-7',
      }),
    );
    const state = useChatStore.getState();
    expect(state.streaming[JID]).toBeUndefined();
    expect(state.stepsCache['final-7']?.steps.length).toBeGreaterThan(0);
    expect(state.activeRuns[JID]?.answered).toBe('delivery-7');
  });

  it("keeps a warm turn's card when nothing names its input: no guessing", () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    streamTurn('run-a', { turnId: 'presentation-8' });

    useChatStore
      .getState()
      .handleWsNewMessage(
        JID,
        finalMessage('final-8', '最终答案。', { turn_id: 'delivery-8' }),
      );
    const state = useChatStore.getState();
    expect(state.streaming[JID]?.partialText).toBe('最终答案。');
    expect(state.activeRuns[JID]?.answered).toBeUndefined();
    // run_finished settles it as before.
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    expect(useChatStore.getState().settledStreaming[JID]).toBeDefined();
  });

  it('leaves the stream of a newer turn alone when an older final arrives', () => {
    useChatStore.getState().handleRunStarted(JID, 'run-b');
    streamTurn(
      'run-b',
      { turnId: 'turn-b', inputTurnId: 'input-b' },
      undefined,
      'B 的回答',
    );
    flushRaf();

    useChatStore
      .getState()
      .handleWsNewMessage(
        JID,
        finalMessage('final-a', 'A 的回答', { turn_id: 'input-a' }),
      );
    const state = useChatStore.getState();
    expect(state.streaming[JID]?.partialText).toBe('B 的回答');
    expect(state.thinkingCache['final-a']).toBeUndefined();
    expect(state.stepsCache['final-a']).toBeUndefined();
    expect(state.activeRuns[JID]?.answered).toBeUndefined();
    expect(state.waiting[JID]).toBe(true);
  });

  it("settles a failover attempt's card, and drops the replaced attempt's", () => {
    const turn = { turnId: 'turn-f', inputTurnId: 'input-f' };
    useChatStore.getState().handleRunStarted(JID, 'attempt-1');
    streamTurn('attempt-1', turn, undefined, '第一次');
    // The provider failed over: a new attempt of the same input.
    useChatStore.getState().handleRunStarted(JID, 'attempt-2');
    expect(useChatStore.getState().settledStreaming[JID]?.runId).toBe(
      'attempt-1',
    );
    streamTurn('attempt-2', turn, undefined, '第二次');

    const updates = updatesOf(() =>
      useChatStore
        .getState()
        .handleWsNewMessage(
          JID,
          finalMessage('final-f', '第二次', { turn_id: 'input-f' }),
        ),
    );
    expect(updates.at(-1)).toEqual({
      live: false,
      settled: false,
      ids: ['final-f'],
    });
    const state = useChatStore.getState();
    // The reply is the second attempt's, and so is its process.
    expect(state.thinkingCache['final-f']).toBe('想一想 attempt-2');
    expect(state.activeRuns[JID]?.answered).toBe('input-f');

    useChatStore.getState().handleRunFinished(JID, 'attempt-2');
    expect(useChatStore.getState().settledStreaming[JID]).toBeUndefined();
  });

  it('keeps a stopped card to the stop rule, and a truncated part to its continuation', () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    streamTurn('run-a', { turnId: 'turn-1' });
    flushRaf();
    useChatStore.getState().handleWsNewMessage(
      JID,
      finalMessage('part-1', '最终答案。', {
        finalization_reason: 'truncated',
      }),
    );
    let state = useChatStore.getState();
    // The continuation of the same turn still streams into this card.
    expect(state.streaming[JID]?.partialText).toBe('最终答案。');
    expect(state.activeRuns[JID]?.answered).toBeUndefined();

    emit({ eventType: 'status', statusText: 'interrupted' }, 'run-a');
    useChatStore.getState().handleWsNewMessage(
      JID,
      finalMessage('stopped-1', '最终答案。', {
        source_kind: 'interrupt_partial',
        finalization_reason: 'interrupted',
      }),
    );
    state = useChatStore.getState();
    expect(state.streaming[JID]).toBeUndefined();
    expect(state.thinkingCache['stopped-1']).toBe('想一想 run-a');
    // A stop is not a turn that ended by itself.
    expect(state.activeRuns[JID]?.answered).toBeUndefined();
  });

  it('never settles on a send_message reply: the turn goes on after it', () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    streamTurn('run-a', { turnId: 'turn-1' });
    useChatStore.getState().handleWsNewMessage(
      JID,
      finalMessage('interim-1', '先说一句', {
        source_kind: 'sdk_send_message',
      }),
    );
    const state = useChatStore.getState();
    expect(state.streaming[JID]?.partialText).toBe('最终答案。');
    expect(state.thinkingCache['interim-1']).toBeUndefined();
    expect(state.activeRuns[JID]?.answered).toBeUndefined();
  });

  it('settles a group-mode scheduled task in place on its result, and only on its own', () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    streamTurn('run-a', { turnId: 'sched-turn', inputTurnId: 'sched-input' });

    // An isolated task posts its result here while this turn streams.
    useChatStore.getState().handleWsNewMessage(
      JID,
      finalMessage('isolated-1', '别的任务', {
        source_kind: 'scheduled_task_result',
        turn_id: 'isolated-input',
      }),
      undefined,
      'scheduled_task',
    );
    let state = useChatStore.getState();
    expect(state.streaming[JID]?.partialText).toBe('最终答案。');
    expect(state.thinkingCache['isolated-1']).toBeUndefined();

    useChatStore.getState().handleWsNewMessage(
      JID,
      finalMessage('sched-1', '## 定时任务结果', {
        source_kind: 'scheduled_task_result',
        turn_id: 'sched-input',
      }),
      undefined,
      'scheduled_task',
    );
    state = useChatStore.getState();
    expect(state.streaming[JID]).toBeUndefined();
    expect(state.thinkingCache['sched-1']).toBe('想一想 run-a');
    expect(state.activeRuns[JID]?.answered).toBe('sched-input');
  });

  it('settles a session reply in place, its tab still running until run_finished', () => {
    useChatStore.setState({ agentWaiting: { [AGENT]: true } });
    useChatStore.getState().handleRunStarted(AGENT_JID, 'run-a');
    streamTurn('run-a', { turnId: 'p-s', inputTurnId: 'input-s' }, AGENT);

    const updates = updatesOf(
      () =>
        useChatStore.getState().handleWsNewMessage(
          JID,
          finalMessage('agent-final', '最终答案。', {
            chat_jid: AGENT_JID,
            turn_id: 'input-s',
          }),
          AGENT,
        ),
      AGENT_JID,
      AGENT,
    );
    expect(updates.at(-1)).toEqual({
      live: false,
      settled: false,
      ids: ['agent-final'],
    });
    let state = useChatStore.getState();
    expect(state.thinkingCache['agent-final']).toBe('想一想 run-a');
    expect(state.agentWaiting[AGENT]).toBe(true);
    expect(state.activeRuns[AGENT_JID]?.answered).toBe('input-s');

    useChatStore.getState().handleRunFinished(AGENT_JID, 'run-a');
    state = useChatStore.getState();
    expect(state.settledStreaming[AGENT_JID]).toBeUndefined();
    expect(state.agentWaiting[AGENT]).toBe(false);
  });

  it('settles in place when the reply comes back by refresh after a reconnect', async () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    streamTurn('run-a', { turnId: 'p-r', inputTurnId: 'input-r' });
    flushRaf();
    apiGetMock.mockResolvedValueOnce({
      messages: [finalMessage('final-r', '最终答案。', { turn_id: 'input-r' })],
    });
    await useChatStore.getState().refreshMessages(JID);

    const state = useChatStore.getState();
    expect(state.streaming[JID]).toBeUndefined();
    expect(state.thinkingCache['final-r']).toBe('想一想 run-a');
    expect(state.waiting[JID]).toBe(true);
    expect(state.activeRuns[JID]?.answered).toBe('input-r');
  });

  it("keeps another turn's settled card when a refresh settles in place", async () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    streamTurn('run-a', { turnId: 'p-a', inputTurnId: 'input-a' });
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    useChatStore.getState().handleRunStarted(JID, 'run-b');
    streamTurn('run-b', { turnId: 'p-b', inputTurnId: 'input-b' });
    flushRaf();
    apiGetMock.mockResolvedValueOnce({
      messages: [finalMessage('final-b', '最终答案。', { turn_id: 'input-b' })],
    });
    await useChatStore.getState().refreshMessages(JID);

    const state = useChatStore.getState();
    expect(state.streaming[JID]).toBeUndefined();
    expect(state.thinkingCache['final-b']).toBe('想一想 run-b');
    // A's card waits for A's own final, as it would over the WebSocket.
    expect(state.settledStreaming[JID]?.inputTurnId).toBe('input-a');
  });

  it('settles a session reply in place on refresh too', async () => {
    useChatStore.setState({ agentWaiting: { [AGENT]: true } });
    useChatStore.getState().handleRunStarted(AGENT_JID, 'run-a');
    streamTurn('run-a', { turnId: 'p-sr', inputTurnId: 'input-sr' }, AGENT);
    flushRaf();
    apiGetMock.mockResolvedValueOnce({
      messages: [
        finalMessage('agent-r', '最终答案。', {
          chat_jid: AGENT_JID,
          turn_id: 'input-sr',
        }),
      ],
    });
    await useChatStore.getState().refreshAgentMessages(JID, AGENT);

    const state = useChatStore.getState();
    expect(state.agentStreaming[AGENT]).toBeUndefined();
    expect(state.thinkingCache['agent-r']).toBe('想一想 run-a');
    expect(state.activeRuns[AGENT_JID]?.answered).toBe('input-sr');
  });
});

describe("a proactive turn's reply", () => {
  // A proactive workspace answers through send_message, mid-turn; the turn then
  // asks the model once more to decide it is done. The utterance of the live
  // turn is its reply: the panel gives way to it and stays away while the turn
  // only reasons, and nothing of the process moves onto it.
  const SPEECH = 'mcp__happyclaw__send_message';
  type Level = 'hidden' | 'activity' | 'full';

  function proactive(visibility: Level) {
    useChatStore.setState({
      groups: {
        [JID]: {
          name: 'Proactive',
          folder: 'proactive',
          added_at: '2026-10-10T00:00:00.000Z',
          interaction_mode: 'proactive',
          process_visibility: visibility,
        } as never,
      },
    });
  }

  const turn1 = { turnId: 'p-1', inputTurnId: 'input-1' };

  /** Reasoning, then the model's answer text: what the host sends at `full`. */
  function reason(turn = turn1, agentId?: string) {
    emit(
      { eventType: 'status', statusText: 'requesting', ...turn },
      'run-a',
      agentId,
    );
    emit({ eventType: 'thinking_start', ...turn }, 'run-a', agentId);
    emit(
      { eventType: 'thinking_delta', text: '用户问你在做什么', ...turn },
      'run-a',
      agentId,
    );
    flushRaf();
    emit({ eventType: 'thinking_end', ...turn }, 'run-a', agentId);
  }

  function tool(id: string, turn = turn1, agentId?: string) {
    emit(
      {
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: id,
        toolInputSummary: 'ls',
        ...turn,
      },
      'run-a',
      agentId,
    );
    emit(
      { eventType: 'tool_use_end', toolUseId: id, ...turn },
      'run-a',
      agentId,
    );
  }

  /** The speech tool's call, and the utterance it delivers mid-call. */
  function speak(id: string, turnId = 'input-1', agentId?: string) {
    const turn = { turnId: 'p-1', inputTurnId: turnId };
    emit(
      { eventType: 'tool_use_start', toolName: SPEECH, toolUseId: id, ...turn },
      'run-a',
      agentId,
    );
    useChatStore.getState().handleWsNewMessage(
      JID,
      finalMessage(id, '刚回完你上一条问题', {
        source_kind: 'sdk_send_message',
        turn_id: turnId,
        ...(agentId ? { chat_jid: AGENT_JID } : {}),
      }),
      agentId,
    );
    emit(
      { eventType: 'tool_result', toolUseId: id, ...turn },
      'run-a',
      agentId,
    );
    emit(
      { eventType: 'tool_use_end', toolUseId: id, ...turn },
      'run-a',
      agentId,
    );
  }

  const visibleWork = () =>
    hasVisibleWork(useChatStore.getState().streaming[JID]);

  it('gives the panel way to the reply, quiet while the turn decides it is done', () => {
    proactive('activity');
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    reason();
    tool('tool-1');
    expect(visibleWork()).toBe(true);

    const updates = updatesOf(() => speak('utterance-1'));
    // The reply lands and the panel goes in the same update.
    expect(updates.find((u) => u.ids.length > 0)).toEqual({
      live: false,
      settled: false,
      ids: ['utterance-1'],
    });
    let state = useChatStore.getState();
    expect(state.activeRuns[JID]?.answered).toBe('input-1');

    // The closing request: reasoning only, so nothing is shown.
    reason();
    expect(visibleWork()).toBe(false);
    state = useChatStore.getState();
    expect(state.activeRuns[JID]?.answered).toBe('input-1');
    expect(state.waiting[JID]).toBe(true);

    useChatStore.getState().handleRunFinished(JID, 'run-a');
    state = useChatStore.getState();
    expect(state.settledStreaming[JID]).toBeUndefined();
    expect(state.waiting[JID]).toBe(false);
  });

  it('brings the panel back when the turn goes on working after its reply', () => {
    proactive('activity');
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    reason();
    tool('tool-1');
    speak('utterance-1');
    reason();
    expect(visibleWork()).toBe(false);
    tool('tool-2');
    expect(visibleWork()).toBe(true);
    // Only the work since the reply: the earlier steps went with it.
    const steps = useChatStore.getState().streaming[JID]?.steps ?? [];
    expect(steps.filter((step) => step.kind === 'tool')).toHaveLength(1);
  });

  it("leaves the panel of the next input alone when an older turn's reply lands", () => {
    proactive('activity');
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    reason({ turnId: 'p-2', inputTurnId: 'input-2' });
    tool('tool-2', { turnId: 'p-2', inputTurnId: 'input-2' });
    useChatStore.getState().handleWsNewMessage(
      JID,
      finalMessage('utterance-old', '上一轮的话', {
        source_kind: 'sdk_send_message',
        turn_id: 'input-1',
      }),
    );
    const state = useChatStore.getState();
    expect(state.streaming[JID]?.inputTurnId).toBe('input-2');
    expect(state.activeRuns[JID]?.answered).toBeUndefined();
  });

  it('shows each level what it showed before, and moves none of it onto the reply', () => {
    for (const [level, expectSteps, expectThinking] of [
      ['hidden', false, false],
      ['activity', true, false],
      ['full', true, true],
    ] as const) {
      reset();
      proactive(level);
      useChatStore.getState().handleRunStarted(JID, 'run-a');
      reason();
      emit({ eventType: 'text_delta', text: '模型的话', ...turn1 }, 'run-a');
      flushRaf();
      tool('tool-1');
      const live = useChatStore.getState().streaming[JID];
      expect(!!live?.steps?.length, level).toBe(expectSteps);
      expect(!!live?.thinkingText, level).toBe(expectThinking);
      // Never the model's words, at any level.
      expect(live?.partialText ?? '', level).toBe('');

      speak('utterance-1');
      const state = useChatStore.getState();
      expect(state.activeRuns[JID]?.answered, level).toBe('input-1');
      expect(state.thinkingCache['utterance-1'], level).toBeUndefined();
      expect(state.stepsCache['utterance-1'], level).toBeUndefined();
      expect(state.traceCache['utterance-1'], level).toBeUndefined();
    }
  });

  it('gives a Runtime Session panel way to its reply too', () => {
    proactive('activity');
    useChatStore.setState({
      agents: {
        [JID]: [
          {
            id: AGENT,
            name: 'Session',
            prompt: '',
            status: 'running',
            kind: 'conversation',
            created_at: '2026-10-10T00:00:00.000Z',
          },
        ],
      },
      agentWaiting: { [AGENT]: true },
    });
    useChatStore.getState().handleRunStarted(AGENT_JID, 'run-a');
    reason(turn1, AGENT);
    tool('tool-1', turn1, AGENT);
    expect(useChatStore.getState().agentStreaming[AGENT]).toBeDefined();
    speak('utterance-s', 'input-1', AGENT);
    const state = useChatStore.getState();
    expect(state.agentMessages[AGENT].map((m) => m.id)).toEqual([
      'utterance-s',
    ]);
    expect(state.agentStreaming[AGENT]?.steps ?? []).toEqual([]);
    expect(state.activeRuns[AGENT_JID]?.answered).toBe('input-1');
    expect(state.agentWaiting[AGENT]).toBe(true);
  });

  it('gives the panel way to a reply that comes back by refresh', async () => {
    proactive('activity');
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    reason();
    tool('tool-1');
    apiGetMock.mockResolvedValueOnce({
      messages: [
        finalMessage('utterance-r', '刚回完你上一条问题', {
          source_kind: 'sdk_send_message',
          turn_id: 'input-1',
        }),
      ],
    });
    await useChatStore.getState().refreshMessages(JID);

    const state = useChatStore.getState();
    expect(state.streaming[JID]).toBeUndefined();
    expect(state.activeRuns[JID]?.answered).toBe('input-1');
    expect(state.stepsCache['utterance-r']).toBeUndefined();
  });

  it('holds the row of the trace the reply will carry, where the process is kept', () => {
    proactive('activity');
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    reason();
    tool('tool-1');
    speak('utterance-1');
    expect(useChatStore.getState().traceAwaited[JID]).toBe('utterance-1');
    // The trace is stored: the reply carries it, and the hold goes.
    useChatStore.getState().handleMessageTrace(JID, 'utterance-1');
    const state = useChatStore.getState();
    expect(state.traceAwaited[JID]).toBeUndefined();
    expect(state.messages[JID][0].has_trace).toBe(true);
  });

  it('holds nothing at the hidden level, where nothing is kept', () => {
    proactive('hidden');
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    reason();
    speak('utterance-1');
    expect(useChatStore.getState().activeRuns[JID]?.answered).toBe('input-1');
    expect(useChatStore.getState().traceAwaited[JID]).toBeUndefined();
  });

  it('lets the hold go a moment after a run whose turn kept nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    proactive('activity');
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    reason();
    speak('utterance-1');
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    expect(useChatStore.getState().traceAwaited[JID]).toBe('utterance-1');
    await vi.advanceTimersByTimeAsync(1600);
    expect(useChatStore.getState().traceAwaited[JID]).toBeUndefined();
  });

  it('never makes an Assistant workspace send_message the reply', () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    emit({ eventType: 'text_delta', text: '答案', ...turn1 }, 'run-a');
    flushRaf();
    useChatStore.getState().handleWsNewMessage(
      JID,
      finalMessage('interim', '先说一句', {
        source_kind: 'sdk_send_message',
        turn_id: 'input-1',
      }),
    );
    const state = useChatStore.getState();
    expect(state.streaming[JID]?.partialText).toBe('答案');
    expect(state.activeRuns[JID]?.answered).toBeUndefined();
  });

  it('does not create a virtual sdkTask tab or duplicate task step for local_bash', () => {
    proactive('activity');
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    emit(
      {
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'bash-bg',
        toolInputSummary: 'npm run dev',
        ...turn1,
      },
      'run-a',
    );
    emit(
      {
        eventType: 'task_start',
        taskId: 'bash-bg',
        toolUseId: 'bash-bg',
        taskType: 'local_bash',
        taskDescription: 'Run dev server',
        ...turn1,
      },
      'run-a',
    );
    const state = useChatStore.getState();
    expect(state.sdkTasks['bash-bg']).toBeUndefined();
    expect(state.streaming[JID]?.steps?.map((s) => s.kind)).toEqual(['tool']);
  });
});
