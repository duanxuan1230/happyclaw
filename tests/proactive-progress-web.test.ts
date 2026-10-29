import { describe, expect, test, vi } from 'vitest';

import { ActiveChannelOutboxScopeRegistry } from '../src/channel-outbox-runtime-scope.js';
import { channelTurnScope } from '../src/channel-turn-registry.js';
import { routeHostIpcOutput } from '../src/host-ipc-output-router.js';
import type { StreamEvent } from '../src/stream-event.types.js';
import { ActiveTurnOutputRegistry } from '../src/turn-output-coordinator.js';
import { TurnTraceTracker } from '../src/turn-trace.js';
import type { InteractionMode, ProcessVisibility } from '../src/types.js';
import { projectProgressForWeb } from '../src/workspace-interaction-runtime.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

// The proactive progress path as the host runs it: the IPC router stages a Web
// turn's send_message(delivery_role=progress) on its turn, and the turn's own
// onProgress handler (installed from index.ts, main session and conversation
// session alike) tells the Web and records it for turn_traces.

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
    interactionMode: mode,
    resolveProcessVisibility: () => visibility,
    turnTraces,
    broadcastStreamEvent: broadcast,
    chatJid: CHAT_JID,
    agentId: AGENT_ID,
    activeSessionId: 'sdk-session',
    currentAgentSessionId: 'sdk-session',
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
  const send = (text: string) =>
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
        turnSource: 'web',
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

  test('an IM input has its channel route; a Web input has none', () => {
    expect(routeOf(true)).toBe('feishu:oc_chat');
    expect(routeOf(false)).toBeNull();
  });
});
