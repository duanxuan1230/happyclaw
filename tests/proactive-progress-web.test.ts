import { describe, expect, test, vi } from 'vitest';

import { ActiveChannelOutboxScopeRegistry } from '../src/channel-outbox-runtime-scope.js';
import { resolveOutputChannelReplySource } from '../src/channel-reply-source.js';
import { channelTurnScope } from '../src/channel-turn-registry.js';
import { routeHostIpcOutput } from '../src/host-ipc-output-router.js';
import type { StreamEvent } from '../src/stream-event.types.js';
import { ActiveTurnOutputRegistry } from '../src/turn-output-coordinator.js';
import { hasUnfinishedProactiveOutput } from '../src/turn-outcome.js';
import { ProactiveProgressCarry, TurnTraceTracker } from '../src/turn-trace.js';
import type { InteractionMode, ProcessVisibility } from '../src/types.js';
import {
  proactiveClosingNote,
  projectProgressForWeb,
} from '../src/workspace-interaction-runtime.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

// The proactive progress path as the host runs it: each turn is bound with the
// channel its input came from, the IPC router stages a Web turn's
// send_message(delivery_role=progress) on it, and the turn's own onProgress
// handler (installed from index.ts, main session and conversation session
// alike) tells the Web and records it for turn_traces. A turn that ends
// without a reply keeps its progress on a closing note.

const LEVELS: ProcessVisibility[] = ['hidden', 'activity', 'full'];
const FOLDER = 'ws-progress';
const CHAT_JID = 'web:ws-progress';
const AGENT_ID = 'session-1';

type StoredTrace = Parameters<
  NonNullable<ConstructorParameters<typeof TurnTraceTracker>[0]['store']>
>[0];

function sessionLane(
  lane: 'main' | 'session',
  mode: InteractionMode,
  visibility: ProcessVisibility,
  options: { initialSource?: string | null } = {},
) {
  const activeTurnOutputs = new ActiveTurnOutputRegistry();
  const broadcast = vi.fn<(...args: unknown[]) => void>();
  const stored: StoredTrace[] = [];
  const turnTraces = new TurnTraceTracker({
    mode,
    getVisibility: () => visibility,
    store: (row) => {
      stored.push(row);
    },
  });
  const nonTerminal = new Map<string, boolean>();
  const globals: Record<string, unknown> = {
    activeTurnOutputs,
    projectProgressForWeb,
    resolveOutputChannelReplySource,
    interactionMode: mode,
    turnTraces,
    broadcastStreamEvent: broadcast,
    chatJid: CHAT_JID,
    agentId: AGENT_ID,
    activeSessionId: 'sdk-session',
    currentAgentSessionId: 'sdk-session',
    lastProcessed: { id: 'input-1' },
    initialReplySourceImJid: options.initialSource ?? null,
    initialAgentReplySourceImJid: options.initialSource ?? null,
    admittedWarmMainInputs: new Map(),
    admittedWarmAgentInputs: new Map(),
    mainAdmissionKey: channelTurnScope(FOLDER),
    agentAdmissionKey: channelTurnScope(FOLDER, AGENT_ID),
    turnOutputCoordinators: new Map(),
    agentTurnOutputCoordinators: new Map(),
    channelStreamingSessionsByInput: new Map(),
    agentStreamingSessionsByInput: new Map(),
    channelNonTerminalDeliveryAckByInput: nonTerminal,
    agentNonTerminalDeliveryAckByInput: nonTerminal,
  };
  const harness = createRuntimeSourceHarness(globals);
  if (lane === 'main') {
    harness.install('bindTurnOutputCoordinator', 'processGroupMessages');
  } else {
    harness.install(
      'bindAgentTurnOutputCoordinator',
      'processAgentConversation',
    );
  }
  const bind = globals[
    lane === 'main'
      ? 'bindTurnOutputCoordinator'
      : 'bindAgentTurnOutputCoordinator'
  ] as (inputTurnId: string) => unknown;
  bind('input-1');
  const scope = channelTurnScope(FOLDER, lane === 'main' ? null : AGENT_ID);
  // What the IPC watcher passes: the bound source, and whether a route is open.
  const send = (text: string, imRouteAvailable = false) =>
    routeHostIpcOutput(
      {
        sourceGroup: FOLDER,
        agentId: lane === 'main' ? null : AGENT_ID,
        inputTurnId: 'input-1',
        text,
        deliveryRole: 'progress',
        authorized: true,
        scheduledTask: false,
        interactionMode: mode,
        turnSource: activeTurnOutputs.sourceOf(scope, 'input-1'),
        imRouteAvailable,
      },
      activeTurnOutputs,
    );
  const sent = () => broadcast.mock.calls.map((call) => call[1] as StreamEvent);
  return { send, sent, broadcast, turnTraces, stored, nonTerminal };
}

describe("a proactive Web turn's progress", () => {
  for (const lane of ['main', 'session'] as const) {
    test(`reaches the Web as a progress step at every level (${lane})`, () => {
      for (const level of LEVELS) {
        const run = sessionLane(lane, 'proactive', level);
        expect(run.send('先看一下仓库结构')).toMatchObject({
          path: 'primary_projection',
          staged: true,
          disposition: 'staged_progress',
        });
        expect(run.sent()).toEqual([
          {
            eventType: 'commentary',
            agentScope: 'main',
            text: '先看一下仓库结构',
            turnId: 'input-1',
            inputTurnId: 'input-1',
            sessionId: 'sdk-session',
            progress: true,
          },
        ]);
        // The session lane addresses its own tab.
        expect(run.broadcast.mock.calls[0][0]).toBe(CHAT_JID);
        expect(run.broadcast.mock.calls[0][2]).toBe(
          lane === 'main' ? undefined : AGENT_ID,
        );
        // It is non-terminal output: the turn still owes its final.
        expect(run.nonTerminal.get('input-1')).toBe(true);
      }
    });

    test(`lands on the card of a warm turn, under the Runner's own id (${lane})`, () => {
      // A warm turn's events carry the Runner's id, not the input's: a step
      // under the input's id would start a new card and wipe the one shown.
      const run = sessionLane(lane, 'proactive', 'hidden');
      run.turnTraces.observe('input-1', {
        eventType: 'status',
        statusText: 'requesting',
        turnId: 'runner-turn-2',
      });
      run.send('换个思路再试');
      expect(run.sent()[0]).toMatchObject({
        turnId: 'runner-turn-2',
        inputTurnId: 'input-1',
        progress: true,
      });
    });

    test(`is kept for turn_traces at every level, alone at hidden (${lane})`, () => {
      for (const level of LEVELS) {
        const run = sessionLane(lane, 'proactive', level);
        run.turnTraces.observe('input-1', {
          eventType: 'tool_use_start',
          toolName: 'Bash',
          toolUseId: 'bash-1',
        });
        run.send('已定位到问题');
        expect(
          run.turnTraces.persist({ chatJid: CHAT_JID, inputId: 'input-1' }),
        ).toBe(true);
        const steps = JSON.parse(run.stored[0].stepsJson!) as Array<{
          kind: string;
          text?: string;
          progress?: boolean;
        }>;
        expect(steps.filter((step) => step.progress)).toEqual([
          expect.objectContaining({ kind: 'text', text: '已定位到问题' }),
        ]);
        expect(steps.some((step) => step.kind === 'tool')).toBe(
          level !== 'hidden',
        );
      }
    });

    test(`of an IM input goes to the channel, and fails closed without a route (${lane})`, () => {
      // The input's own source decides, not whether a scope happens to exist:
      // an address without its account, or a recalled input, has none.
      const run = sessionLane(lane, 'proactive', 'full', {
        initialSource: 'feishu:oc_chat',
      });
      expect(run.send('在查', true)).toMatchObject({
        path: 'separate_provider',
      });
      expect(run.send('在查', false)).toMatchObject({
        path: 'rejected',
        reason: 'native_route_unavailable',
      });
      expect(run.sent()).toEqual([]);
      expect(run.turnTraces.holdsProgress('input-1')).toBe(false);
    });
  }

  test('an Assistant turn keeps its step and status line', () => {
    const run = sessionLane('main', 'assistant', 'hidden');
    run.send('正在处理');
    expect(run.sent().map((event) => event.eventType)).toEqual([
      'commentary',
      'status',
    ]);
    expect(run.sent()[0].progress).toBeUndefined();
  });
});

describe('a proactive turn that sent progress and ends without a reply', () => {
  function mainLane(options: { replied?: boolean } = {}) {
    const stored: StoredTrace[] = [];
    const turnTraces = new TurnTraceTracker({
      mode: 'proactive',
      getVisibility: () => 'hidden',
      store: (row) => {
        stored.push(row);
      },
    });
    const sendMessage = vi.fn(
      async (
        jid: string,
        _text: string,
        opts: {
          turnTrace?: { tracker: TurnTraceTracker; inputId: string };
          messageMeta?: { turnId?: string };
        },
      ) => {
        opts.turnTrace?.tracker.persist({
          chatJid: jid,
          inputId: opts.turnTrace.inputId,
          turnId: opts.messageMeta?.turnId,
        });
        return 'note-1';
      },
    );
    const announceTurnTrace = vi.fn();
    const globals: Record<string, unknown> = {
      turnTraces,
      chatJid: CHAT_JID,
      activeSessionId: 'sdk-session',
      resolveIpcOutputWorkspaceJid: () => null,
      getLastAgentMessageIdForTurn: (jid: string) =>
        options.replied && jid === CHAT_JID ? 'final-1' : undefined,
      announceTurnTrace,
      sendMessage,
      proactiveClosingNote,
      logger: { warn: vi.fn() },
      // No attempt follows: each ending here is the turn's last.
      queue: { willRetryAfterFailure: () => false },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('persistProactiveTurnTrace', 'processGroupMessages');
    harness.install('keepProactiveProgress', 'processGroupMessages');
    const keep = globals.keepProactiveProgress as (
      inputId: string,
      ending: 'stopped' | 'steered' | 'failed',
    ) => Promise<void>;
    return { turnTraces, stored, sendMessage, announceTurnTrace, keep };
  }
  const progress = (turnTraces: TurnTraceTracker, inputId: string) =>
    turnTraces.observeProgress(inputId, {
      eventType: 'commentary',
      agentScope: 'main',
      text: '先看日志',
      progress: true,
    });

  test("keeps it on a closing note that becomes the turn's reply", async () => {
    for (const [ending, reason] of [
      ['stopped', 'interrupted'],
      ['steered', 'interrupted'],
      ['failed', 'error'],
    ] as const) {
      const lane = mainLane();
      progress(lane.turnTraces, 'input-1');
      await lane.keep('input-1', ending);
      expect(lane.sendMessage).toHaveBeenCalledOnce();
      const [jid, text, opts] = lane.sendMessage.mock.calls[0];
      expect(jid).toBe(CHAT_JID);
      expect(text).toBe(proactiveClosingNote(ending));
      expect(opts).toMatchObject({
        sendToIM: false,
        messageMeta: {
          turnId: 'input-1',
          sourceKind: 'interrupt_partial',
          finalizationReason: reason,
        },
      });
      // The note carries the turn's trace: the progress is kept with it.
      expect(lane.stored).toHaveLength(1);
      expect(lane.stored[0].turnId).toBe('input-1');
      expect(JSON.parse(lane.stored[0].stepsJson!)).toEqual([
        expect.objectContaining({ progress: true, text: '先看日志' }),
      ]);
      expect(lane.turnTraces.inputsWithProgress()).toEqual([]);
    }
  });

  test('hangs it on the reply the turn already has', async () => {
    const lane = mainLane({ replied: true });
    progress(lane.turnTraces, 'input-1');
    await lane.keep('input-1', 'stopped');
    expect(lane.sendMessage).not.toHaveBeenCalled();
    expect(lane.stored).toHaveLength(1);
    expect(lane.announceTurnTrace).toHaveBeenCalledWith(
      CHAT_JID,
      'final-1',
      'input-1',
    );
  });

  test('writes nothing for a turn that sent no progress', async () => {
    const lane = mainLane();
    lane.turnTraces.observe('input-1', {
      eventType: 'status',
      statusText: 'requesting',
      turnId: 'input-1',
    });
    await lane.keep('input-1', 'failed');
    expect(lane.sendMessage).not.toHaveBeenCalled();
    expect(lane.stored).toHaveLength(0);
  });

  test('a session keeps it the same way, on its own tab', () => {
    const stored: StoredTrace[] = [];
    const turnTraces = new TurnTraceTracker({
      mode: 'proactive',
      getVisibility: () => 'hidden',
      store: (row) => {
        stored.push(row);
      },
    });
    const storeMessageDirect = vi.fn(() => 'note-s');
    const broadcastNewMessage = vi.fn();
    const globals: Record<string, unknown> = {
      turnTraces,
      virtualChatJid: `${CHAT_JID}#agent:${AGENT_ID}`,
      agentId: AGENT_ID,
      currentAgentSessionId: 'sdk-session',
      getLastAgentMessageIdForTurn: () => undefined,
      announceTurnTrace: vi.fn(),
      ensureChatExists: vi.fn(),
      storeMessageDirect,
      broadcastNewMessage,
      proactiveClosingNote,
      logger: { warn: vi.fn() },
      ASSISTANT_NAME: 'HappyClaw',
      crypto: { randomUUID: () => 'uuid-1' },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('persistProactiveTurnTrace', 'processAgentConversation');
    harness.install('closeProactiveTurn', 'processAgentConversation');
    harness.install('keepProactiveProgress', 'processAgentConversation');
    progress(turnTraces, 'input-1');
    (
      globals.keepProactiveProgress as (
        inputId: string,
        ending: 'stopped',
      ) => void
    )('input-1', 'stopped');
    expect(storeMessageDirect).toHaveBeenCalledOnce();
    expect(broadcastNewMessage).toHaveBeenCalledWith(
      `${CHAT_JID}#agent:${AGENT_ID}`,
      expect.objectContaining({
        id: 'note-s',
        content: proactiveClosingNote('stopped'),
        has_trace: true,
        turn_id: 'input-1',
        source_kind: 'interrupt_partial',
      }),
      AGENT_ID,
    );
    expect(stored).toHaveLength(1);
  });
});

describe('a proactive turn refused for lack of a final, and run again', () => {
  // Every attempt is a run of its own (a fresh tracker); what an attempt that
  // will be retried sent waits in the one carry the host keeps for all runs.
  const carry = new ProactiveProgressCarry();
  const messages: Array<{ id: string; turnId: string; content: string }> = [];
  const stored: StoredTrace[] = [];

  function attempt(willRetry: boolean) {
    const turnTraces = new TurnTraceTracker({
      mode: 'proactive',
      getVisibility: () => 'hidden',
      store: (row) => {
        stored.push(row);
      },
    });
    const globals: Record<string, unknown> = {
      turnTraces,
      proactiveProgressCarry: carry,
      queue: { willRetryAfterFailure: () => willRetry },
      chatJid: CHAT_JID,
      missedMessages: [{ id: 'm1' }],
      lastProcessed: { id: 'm1' },
      interactionMode: 'proactive',
      admittedWarmMainInputs: new Map(),
      channelTurnRuntimes: new Map(),
      hasUnfinishedProactiveOutput,
      // The attempt sent progress and no final.
      channelNonTerminalDeliveryAckByInput: new Map([['m1', true]]),
      channelPhysicalDeliveryAckByInput: new Map(),
      clearProcessingIndicatorForInput: vi.fn(),
      logger: { warn: vi.fn(), error: vi.fn() },
      activeSessionId: 'sdk-session',
      resolveIpcOutputWorkspaceJid: () => null,
      getLastAgentMessageIdForTurn: (_jid: string, turnId: string) =>
        messages.filter((m) => m.turnId === turnId).at(-1)?.id,
      announceTurnTrace: vi.fn(),
      proactiveClosingNote,
      sendMessage: async (
        jid: string,
        content: string,
        opts: {
          turnTrace?: { tracker: TurnTraceTracker; inputId: string };
          messageMeta?: { turnId?: string };
        },
      ) => {
        const id = `note-${messages.length + 1}`;
        messages.push({ id, turnId: opts.messageMeta!.turnId!, content });
        opts.turnTrace?.tracker.persist({
          chatJid: jid,
          inputId: opts.turnTrace.inputId,
          turnId: opts.messageMeta?.turnId,
        });
        return id;
      },
    };
    const harness = createRuntimeSourceHarness(globals);
    for (const name of [
      'takeCarriedProgress',
      'persistProactiveTurnTrace',
      'keepProactiveProgress',
      'completeChannelRuntimesForOutput',
    ]) {
      harness.install(name, 'processGroupMessages');
    }
    (globals.takeCarriedProgress as () => void)();
    return {
      progress: (text: string, at: number) =>
        turnTraces.observeProgress(
          'm1',
          { eventType: 'commentary', agentScope: 'main', text, progress: true },
          at,
        ),
      // The turn's result arrives without a final: the host refuses it.
      refuse: () =>
        (
          globals.completeChannelRuntimesForOutput as (
            result: Record<string, unknown>,
          ) => Promise<boolean>
        )({ inputTurnCompleted: true, inputTurnId: 'm1' }),
      final: () => {
        messages.push({ id: 'final-1', turnId: 'm1', content: '结论' });
        (globals.persistProactiveTurnTrace as (inputId: string) => void)('m1');
      },
    };
  }
  const notes = () =>
    messages.filter((m) => m.content === proactiveClosingNote('failed'));
  const lastTrace = () =>
    (JSON.parse(stored.at(-1)!.stepsJson!) as Array<{ text?: string }>).map(
      (step) => step.text,
    );

  test('refused, retried, refused, given up: one closing note with all the progress', async () => {
    messages.length = 0;
    stored.length = 0;
    const first = attempt(true);
    first.progress('第一次：先看日志', 1_000);
    expect(await first.refuse()).toBe(false);
    expect(notes()).toHaveLength(0);
    const second = attempt(true);
    second.progress('第二次：换个方向', 2_000);
    expect(await second.refuse()).toBe(false);
    expect(notes()).toHaveLength(0);
    const last = attempt(false);
    last.progress('第三次：还是不行', 3_000);
    expect(await last.refuse()).toBe(false);
    expect(notes()).toHaveLength(1);
    expect(stored).toHaveLength(1);
    expect(stored[0].turnId).toBe('m1');
    expect(lastTrace()).toEqual([
      '第一次：先看日志',
      '第二次：换个方向',
      '第三次：还是不行',
    ]);
  });

  test('refused, then retried with a final: no closing note, the progress on the final', async () => {
    messages.length = 0;
    stored.length = 0;
    const first = attempt(true);
    first.progress('先看日志', 1_000);
    await first.refuse();
    const retry = attempt(true);
    retry.progress('找到了', 2_000);
    retry.final();
    expect(notes()).toHaveLength(0);
    expect(messages.map((m) => m.id)).toEqual(['final-1']);
    expect(stored).toHaveLength(1);
    expect(lastTrace()).toEqual(['先看日志', '找到了']);
  });
});

test('a session turn refused and retried, then given up, gets one closing note', () => {
  const carry = new ProactiveProgressCarry();
  const stored: StoredTrace[] = [];
  const storeMessageDirect = vi.fn(() => 'note-s');
  function attempt(willRetry: boolean) {
    const turnTraces = new TurnTraceTracker({
      mode: 'proactive',
      getVisibility: () => 'hidden',
      store: (row) => {
        stored.push(row);
      },
    });
    const globals: Record<string, unknown> = {
      turnTraces,
      proactiveProgressCarry: carry,
      queue: { willRetryAfterFailure: () => willRetry },
      virtualChatJid: `${CHAT_JID}#agent:${AGENT_ID}`,
      agentId: AGENT_ID,
      missedMessages: [{ id: 'm1' }],
      lastProcessed: { id: 'm1' },
      admittedWarmAgentInputs: new Map(),
      currentAgentSessionId: 'sdk-session',
      getLastAgentMessageIdForTurn: () => undefined,
      announceTurnTrace: vi.fn(),
      ensureChatExists: vi.fn(),
      storeMessageDirect,
      broadcastNewMessage: vi.fn(),
      proactiveClosingNote,
      logger: { warn: vi.fn() },
      ASSISTANT_NAME: 'HappyClaw',
      crypto: { randomUUID: () => 'uuid-1' },
    };
    const harness = createRuntimeSourceHarness(globals);
    for (const name of [
      'takeCarriedProgress',
      'persistProactiveTurnTrace',
      'closeProactiveTurn',
      'keepProactiveProgress',
    ]) {
      harness.install(name, 'processAgentConversation');
    }
    (globals.takeCarriedProgress as () => void)();
    return { turnTraces, globals };
  }
  const first = attempt(true);
  first.turnTraces.observeProgress(
    'm1',
    {
      eventType: 'commentary',
      agentScope: 'main',
      text: '先看',
      progress: true,
    },
    1_000,
  );
  (first.globals.keepProactiveProgress as (id: string, e: string) => void)(
    'm1',
    'failed',
  );
  expect(storeMessageDirect).not.toHaveBeenCalled();
  const last = attempt(false);
  last.turnTraces.observeProgress(
    'm1',
    {
      eventType: 'commentary',
      agentScope: 'main',
      text: '再看',
      progress: true,
    },
    2_000,
  );
  (last.globals.keepProactiveProgress as (id: string, e: string) => void)(
    'm1',
    'failed',
  );
  expect(storeMessageDirect).toHaveBeenCalledOnce();
  expect(
    (JSON.parse(stored[0].stepsJson!) as Array<{ text?: string }>).map(
      (step) => step.text,
    ),
  ).toEqual(['先看', '再看']);
});

describe('the reply route a progress statement follows', () => {
  function routeOf(bindImScope: boolean): string | null {
    const activeChannelOutboxScopes = new ActiveChannelOutboxScopeRegistry();
    if (bindImScope) {
      activeChannelOutboxScopes.bind(channelTurnScope(FOLDER), {
        provider: 'feishu',
        accountId: 'acct',
        sourceJid: 'feishu:oc_chat',
        chatId: 'oc_chat',
        rootId: null,
        threadId: null,
        turnRunId: 'run-1',
        inputTurnId: 'input-1',
        owner: 'test',
      });
    }
    const globals: Record<string, unknown> = {
      activeChannelOutboxScopes,
      channelTurnScope,
    };
    createRuntimeSourceHarness(globals).install('resolveImRoute');
    return (
      globals.resolveImRoute as (opts: Record<string, unknown>) => string | null
    )({
      ipcAgentId: null,
      isHome: false,
      chatJid: 'feishu:oc_chat',
      sourceGroup: FOLDER,
      inputTurnId: 'input-1',
    });
  }

  test('an IM input has its channel route while its scope is bound', () => {
    expect(routeOf(true)).toBe('feishu:oc_chat');
    expect(routeOf(false)).toBeNull();
  });
});
