import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiGetMock, apiPostMock, showToastMock, notifyMock, emitNoticeMock } =
  vi.hoisted(() => ({
    apiGetMock: vi.fn(
      async (): Promise<unknown> => ({ items: [], messages: [] }),
    ),
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
  apiGetMock.mockReset();
  apiGetMock.mockResolvedValue({ items: [], messages: [] });
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

  it('any failure keeps the id; only acceptance ends it', async () => {
    const send = useChatStore.getState().sendMessage;
    apiPostMock.mockRejectedValueOnce({ status: 500, message: 'boom' });
    await send(JID, 'rejected');
    apiPostMock.mockRejectedValueOnce({ status: 403, message: 'denied' });
    await send(JID, 'rejected');
    apiPostMock.mockResolvedValueOnce(accepted);
    await send(JID, 'rejected');
    apiPostMock.mockResolvedValueOnce(accepted);
    await send(JID, 'rejected');
    const [first, second, accepted1, next] = sentIds();
    expect(second).toBe(first);
    expect(accepted1).toBe(first);
    expect(next).not.toBe(first);
    expect(showToastMock).toHaveBeenCalledWith(
      '发送失败',
      expect.stringContaining('消息未发送'),
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

  it('a slow image resend keeps its id however long it takes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const send = useChatStore.getState().sendMessage;
    const images = [{ data: 'IMAGE', mimeType: 'image/png' }];
    apiPostMock.mockRejectedValue(timeout);
    await send(JID, 'big upload', images);
    vi.advanceTimersByTime(10 * 60_000);
    await send(JID, 'big upload', images);
    const [first, later] = sentIds();
    expect(later).toBe(first);
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

  it('tells the user the message was already sent', async () => {
    apiPostMock.mockResolvedValueOnce(replay);
    expect(await useChatStore.getState().sendMessage(JID, 'twice')).toBe(true);
    apiPostMock.mockResolvedValueOnce(replay);
    await useChatStore.getState().sendAgentMessage(JID, 'agent-9', 'twice');
    expect(
      showToastMock.mock.calls.filter(
        ([title]) => title === '这条消息已经发送过',
      ),
    ).toHaveLength(2);
  });

  it('in a session neither restarts the run nor waits for a reply', async () => {
    apiPostMock.mockResolvedValueOnce(replay);
    await useChatStore.getState().sendAgentMessage(JID, 'agent-9', 'again');
    const state = useChatStore.getState();
    expect(state.activeRuns[`${JID}#agent:agent-9`]).toBeUndefined();
    expect(state.agentWaiting['agent-9']).toBeUndefined();
  });

  it('in a session reads the conversation again when the message is missing', async () => {
    const sessionMessages = () =>
      apiGetMock.mock.calls.filter(([url]) =>
        String(url).includes('agentId=agent-8'),
      );
    useChatStore.setState({ agentMessages: { 'agent-8': [] } });
    apiGetMock.mockResolvedValueOnce({ messages: [] });
    apiPostMock.mockResolvedValueOnce(replay);
    await useChatStore.getState().sendAgentMessage(JID, 'agent-8', 'gone');
    expect(sessionMessages()).toHaveLength(1);

    useChatStore.setState({
      agentMessages: {
        'agent-8': [
          {
            id: 'm-first',
            chat_jid: `${JID}#agent:agent-8`,
            sender: 'u',
            sender_name: 'U',
            content: 'here',
            timestamp: accepted.timestamp,
            is_from_me: false,
          },
        ],
      },
    });
    apiPostMock.mockResolvedValueOnce(replay);
    await useChatStore.getState().sendAgentMessage(JID, 'agent-8', 'here');
    expect(sessionMessages()).toHaveLength(1);
    expect(useChatStore.getState().agentWaiting['agent-8']).toBeUndefined();
  });
});

describe('a history fetch that returns the message', () => {
  const own = (content: string, timestamp: string) => ({
    id: `own-${content}`,
    chat_jid: JID,
    sender: 'web-user',
    sender_name: 'Web',
    content,
    timestamp,
    is_from_me: false,
  });

  it('ends the key when the message is newer than the send', async () => {
    const send = useChatStore.getState().sendMessage;
    apiPostMock.mockRejectedValueOnce(timeout);
    await send(JID, ' fetched ');
    apiGetMock.mockResolvedValueOnce({
      messages: [own('fetched', new Date().toISOString())],
    });
    await useChatStore.getState().refreshMessages(JID);
    apiPostMock.mockResolvedValueOnce(accepted);
    await send(JID, ' fetched ');
    const [first, second] = sentIds();
    expect(second).not.toBe(first);
  });

  it('keeps it for the same text sent long before', async () => {
    const send = useChatStore.getState().sendMessage;
    apiPostMock.mockRejectedValueOnce(timeout);
    await send(JID, 'said before');
    apiGetMock.mockResolvedValueOnce({
      messages: [own('said before', '2020-01-01T00:00:00.000Z')],
    });
    await useChatStore.getState().refreshMessages(JID);
    apiPostMock.mockResolvedValueOnce(accepted);
    await send(JID, 'said before');
    const [first, second] = sentIds();
    expect(second).toBe(first);
  });

  it('in a session too', async () => {
    const sendAgent = useChatStore.getState().sendAgentMessage;
    apiPostMock.mockRejectedValueOnce(timeout);
    await sendAgent(JID, 'agent-6', 'session fetched');
    apiGetMock.mockResolvedValueOnce({
      messages: [
        {
          ...own('session fetched', new Date().toISOString()),
          chat_jid: `${JID}#agent:agent-6`,
        },
      ],
    });
    await useChatStore.getState().refreshAgentMessages(JID, 'agent-6');
    apiPostMock.mockResolvedValueOnce(accepted);
    await sendAgent(JID, 'agent-6', 'session fetched');
    const [first, second] = sentIds();
    expect(second).not.toBe(first);
  });
});

describe('a /clear that timed out', () => {
  it('is done once its divider arrives with the id; the next /clear is new', async () => {
    const send = useChatStore.getState().sendMessage;
    apiPostMock.mockRejectedValueOnce(timeout);
    await send(JID, '/clear');
    const [first] = sentIds();
    useChatStore.getState().handleWsNewMessage(JID, {
      id: 'divider-1',
      chat_jid: JID,
      sender: '__system__',
      sender_name: 'system',
      content: 'context_reset',
      timestamp: '2026-01-01T00:00:02.000Z',
      is_from_me: true,
      source_kind: 'context_reset',
      client_message_id: first,
    });
    apiPostMock.mockResolvedValueOnce({ success: true, cleared: true });
    await send(JID, '/clear');
    expect(sentIds()[1]).not.toBe(first);
  });
});

describe('stored, then failed on the server', () => {
  const storedError = {
    status: 500,
    message: '消息已保存，但处理失败',
    body: { stored: true, messageId: 'm-stored' },
  };

  it('counts as sent, says processing may have failed, and spends the id', async () => {
    const send = useChatStore.getState().sendMessage;
    apiPostMock.mockRejectedValueOnce(storedError);
    expect(await send(JID, 'stored anyway')).toBe(true);
    expect(showToastMock).toHaveBeenCalledWith(
      '消息已发送',
      expect.stringContaining('处理可能失败'),
    );
    expect(showToastMock).not.toHaveBeenCalledWith(
      '发送失败',
      expect.anything(),
    );
    // The input was cleared as sent: the same text again is a new message.
    apiPostMock.mockResolvedValueOnce(accepted);
    await send(JID, 'stored anyway');
    const [first, second] = sentIds();
    expect(second).not.toBe(first);
  });

  it('a 409 spends the id too', async () => {
    const send = useChatStore.getState().sendMessage;
    apiPostMock.mockRejectedValueOnce({ status: 409, message: 'conflict' });
    expect(await send(JID, 'conflicted')).toBe(false);
    apiPostMock.mockResolvedValueOnce(accepted);
    await send(JID, 'conflicted');
    const [first, second] = sentIds();
    expect(second).not.toBe(first);
  });

  it('in a session too', async () => {
    apiPostMock.mockRejectedValueOnce(storedError);
    expect(
      await useChatStore
        .getState()
        .sendAgentMessage(JID, 'agent-7', 'stored in a session'),
    ).toBe(true);
    expect(showToastMock).toHaveBeenCalledWith(
      '消息已发送',
      expect.stringContaining('处理可能失败'),
    );
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
