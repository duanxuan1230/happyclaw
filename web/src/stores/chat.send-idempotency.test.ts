import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiGetMock, apiPostMock, showToastMock, notifyMock, emitNoticeMock } =
  vi.hoisted(() => ({
    apiGetMock: vi.fn(async () => ({ items: [] })),
    apiPostMock: vi.fn(),
    showToastMock: vi.fn(),
    notifyMock: vi.fn(),
    emitNoticeMock: vi.fn(() => false),
  }));

vi.mock('../api/client', () => ({
  api: { get: apiGetMock, post: apiPostMock, patch: vi.fn(), delete: vi.fn() },
  computeUploadTimeoutMs: vi.fn(() => 120_000),
}));

vi.mock('../api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('./files', () => ({
  useFileStore: { getState: () => ({ loadFiles: vi.fn() }) },
}));

vi.mock('./auth', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));

vi.mock('../utils/toast', () => ({
  showToast: showToastMock,
  notifyIfHidden: notifyMock,
  shouldEmitBackgroundTaskNotice: emitNoticeMock,
  showNotificationPromptToast: vi.fn(),
}));

vi.mock('../utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(),
  deleteGroupMessageSnapshots: vi.fn(),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: vi.fn(async () => undefined),
}));

const { useChatStore } = await import('./chat');

const JID = 'web:idempotent';
const accepted = {
  success: true,
  messageId: 'm1',
  timestamp: '2026-01-01T00:00:00.000Z',
  disposition: 'queued',
};
const timeout = { status: 408, message: 'Request timeout' };

function sentIds(): string[] {
  return apiPostMock.mock.calls.map(
    ([, body]) => (body as { clientMessageId: string }).clientMessageId,
  );
}

beforeEach(() => {
  apiPostMock.mockReset();
  showToastMock.mockReset();
  useChatStore.setState({
    messages: { [JID]: [] },
    waiting: {},
    agentWaiting: {},
    activeRuns: {},
  });
});

describe('send idempotency keys', () => {
  it('a resend after a timeout reuses the id; the next message gets a new one', async () => {
    const send = useChatStore.getState().sendMessage;
    apiPostMock.mockRejectedValueOnce(timeout);
    expect(await send(JID, 'hello')).toBe(false);
    apiPostMock.mockResolvedValueOnce(accepted);
    expect(await send(JID, 'hello')).toBe(true);
    apiPostMock.mockResolvedValueOnce({ ...accepted, messageId: 'm2' });
    await send(JID, 'hello');

    const [first, retry, next] = sentIds();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(retry).toBe(first);
    expect(next).not.toBe(first);
    expect(showToastMock).toHaveBeenCalledWith(
      '发送失败',
      expect.stringContaining('重发不会重复'),
    );
  });

  it('a lost connection or gateway timeout also keeps the id', async () => {
    const send = useChatStore.getState().sendMessage;
    apiPostMock.mockRejectedValueOnce({ status: 0, message: 'Network error' });
    await send(JID, 'flaky');
    apiPostMock.mockRejectedValueOnce({ status: 504, message: 'Gateway' });
    await send(JID, 'flaky');
    apiPostMock.mockResolvedValueOnce(accepted);
    await send(JID, 'flaky');
    expect(sentIds()[0]).toBeTruthy();
    expect(new Set(sentIds()).size).toBe(1);
  });

  it('edited content or other images are a new message', async () => {
    const send = useChatStore.getState().sendMessage;
    apiPostMock.mockRejectedValue(timeout);
    await send(JID, 'draft');
    await send(JID, 'draft, edited');
    await send(JID, 'draft, edited', [{ data: 'AAAA', mimeType: 'image/png' }]);
    await send(JID, 'draft, edited', [{ data: 'BBBB', mimeType: 'image/png' }]);
    await send(JID, 'draft, edited', [{ data: 'BBBB', mimeType: 'image/png' }]);
    const ids = sentIds();
    expect(new Set(ids.slice(0, 4)).size).toBe(4);
    expect(ids[4]).toBe(ids[3]);
  });

  it('a rejected send is not resent under the same id', async () => {
    const send = useChatStore.getState().sendMessage;
    apiPostMock.mockRejectedValueOnce({ status: 409, message: 'conflict' });
    await send(JID, 'rejected');
    apiPostMock.mockResolvedValueOnce(accepted);
    await send(JID, 'rejected');
    const [first, second] = sentIds();
    expect(second).not.toBe(first);
    expect(showToastMock).toHaveBeenCalledWith(
      '发送失败',
      expect.not.stringContaining('重发不会重复'),
    );
  });

  it('session sends keep their own id per conversation', async () => {
    const sendAgent = useChatStore.getState().sendAgentMessage;
    apiPostMock.mockRejectedValueOnce(timeout);
    await sendAgent(JID, 'agent-1', 'same text');
    apiPostMock.mockRejectedValueOnce(timeout);
    await useChatStore.getState().sendMessage(JID, 'same text');
    apiPostMock.mockResolvedValueOnce(accepted);
    await sendAgent(JID, 'agent-1', 'same text');

    const [agentFirst, main, agentRetry] = sentIds();
    expect(agentRetry).toBe(agentFirst);
    expect(main).not.toBe(agentFirst);
  });
});

describe('when a key is not reused', () => {
  afterEach(() => vi.useRealTimers());

  it('the message showing up means a same-text send is a new message', async () => {
    const send = useChatStore.getState().sendMessage;
    apiPostMock.mockRejectedValueOnce(timeout);
    await send(JID, 'landed anyway');
    const [first] = sentIds();
    useChatStore.getState().handleWsNewMessage(JID, {
      id: 'm-landed',
      chat_jid: JID,
      sender: 'u',
      sender_name: 'U',
      content: 'landed anyway',
      timestamp: '2026-01-01T00:00:01.000Z',
      is_from_me: false,
      client_message_id: first,
    });
    apiPostMock.mockResolvedValueOnce(accepted);
    await send(JID, 'landed anyway');
    expect(sentIds()[1]).not.toBe(first);
  });

  it('after two minutes the same text is a new message', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const send = useChatStore.getState().sendMessage;
    apiPostMock.mockRejectedValue(timeout);
    await send(JID, 'much later');
    vi.advanceTimersByTime(119_000);
    await send(JID, 'much later');
    vi.advanceTimersByTime(2_000);
    await send(JID, 'much later');
    const [first, soon, late] = sentIds();
    expect(soon).toBe(first);
    expect(late).not.toBe(first);
  });

  it('steering instead of queueing is a new message', async () => {
    const send = useChatStore.getState().sendMessage;
    apiPostMock.mockRejectedValue(timeout);
    await send(JID, 'mode change', undefined, 'queue');
    await send(JID, 'mode change', undefined, 'steer');
    const [queued, steered] = sentIds();
    expect(steered).not.toBe(queued);
  });
});

describe('a replayed answer', () => {
  const replay = {
    ...accepted,
    messageId: 'm-first',
    disposition: 'started',
    runId: 'run-old',
    deduplicated: true,
  };

  it('neither restarts the old run nor overwrites the message’s current state', async () => {
    useChatStore.getState().handleRunStarted(JID, 'run-current');
    const current = {
      id: 'm-first',
      chat_jid: JID,
      sender: 'u',
      sender_name: 'U',
      content: 'replayed',
      timestamp: accepted.timestamp,
      is_from_me: false,
      delivery_mode: 'queue' as const,
      delivery_status: 'released' as const,
      delivery_run_id: 'run-current',
    };
    useChatStore.setState({ messages: { [JID]: [current] } });
    apiPostMock.mockResolvedValueOnce({ ...replay, disposition: 'queued' });

    expect(await useChatStore.getState().sendMessage(JID, 'replayed')).toBe(
      true,
    );
    const state = useChatStore.getState();
    expect(state.activeRuns[JID]?.runId).toBe('run-current');
    expect(state.messages[JID]).toEqual([current]);
    expect(apiGetMock).toHaveBeenCalled();
  });

  it('shows a message whose announcement was missed, without stale queue state', async () => {
    apiPostMock.mockResolvedValueOnce({ ...replay, disposition: 'queued' });
    await useChatStore.getState().sendMessage(JID, 'missed it');
    const [shown] = useChatStore.getState().messages[JID];
    expect(shown).toMatchObject({ id: 'm-first', content: 'missed it' });
    expect(shown.delivery_status).toBeUndefined();
    expect(useChatStore.getState().activeRuns[JID]).toBeUndefined();
  });

  it('in a session neither restarts the run nor waits for a reply', async () => {
    apiPostMock.mockResolvedValueOnce(replay);
    await useChatStore.getState().sendAgentMessage(JID, 'agent-9', 'again');
    const state = useChatStore.getState();
    expect(state.activeRuns[`${JID}#agent:agent-9`]).toBeUndefined();
    expect(state.agentWaiting['agent-9']).toBeUndefined();
  });
});

describe('background task notice', () => {
  afterEach(() => {
    notifyMock.mockReset();
    emitNoticeMock.mockReset();
    emitNoticeMock.mockReturnValue(false);
  });

  it('updates the stream before notifying, so a failing notification cannot skip it', () => {
    useChatStore.getState().handleRunStarted(JID, 'run-1');
    const before = {
      partialText: 'working',
      thinkingText: '',
      isThinking: false,
      activeTools: [],
      activeHook: null,
      systemStatus: null,
      recentEvents: [],
      todos: [],
    };
    useChatStore.setState({ streaming: { [JID]: before as never } });
    emitNoticeMock.mockReturnValue(true);
    let streamingAtNotify: unknown;
    notifyMock.mockImplementation(() => {
      streamingAtNotify = useChatStore.getState().streaming[JID];
      throw new Error('Illegal constructor');
    });

    expect(() =>
      useChatStore.getState().handleStreamEvent(
        JID,
        {
          eventType: 'task_notification',
          taskId: 'task-1',
          taskStatus: 'completed',
          taskSummary: 'done',
          isBackground: true,
        },
        undefined,
        'run-1',
      ),
    ).toThrow('Illegal constructor');

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(streamingAtNotify).toBeDefined();
    expect(streamingAtNotify).not.toBe(before);
  });
});
