/**
 * The production index.ts paths that connect automations to a session: the
 * agent's automation tools over task IPC, and a Runtime Session turn that
 * settles a run. Run from source with explicit dependencies (see
 * helpers/runtime-source.ts); nothing here boots the server.
 */
import { describe, expect, test, vi } from 'vitest';

import {
  AgentBuilderTurnRegistry,
  agentBuilderTurnScope,
  type AgentBuilderPersistedInput,
} from '../src/agent-builder-turn-auth.js';
import type { AutomationRunOutcome } from '../src/automation-contract.js';
import * as ledger from '../src/automation-run-ledger.js';
import {
  deriveAutomationActor,
  handleAutomationIpc,
} from '../src/automation-runtime.js';
import { skillMutationTurnRejection } from '../src/skill-ipc-authorization.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const OWNER = 'owner-1';
const FOLDER = 'team';
const WORKSPACE = 'web:team';
const GROUP = 'feishu:oc_team';
const TOPIC_ROUTE = `${GROUP}#thread:omt_1#root:om_root`;
const SESSION_ID = 'topic-session';
const SESSION = `${WORKSPACE}#agent:${SESSION_ID}`;

const registrations: Record<string, Record<string, unknown>> = {
  [WORKSPACE]: { folder: FOLDER, created_by: OWNER },
  [GROUP]: {
    folder: FOLDER,
    created_by: OWNER,
    owner_im_id: 'ou_owner',
    owner_claim_source: 'configured',
  },
};

const humanInput = (sender: string): AgentBuilderPersistedInput => ({
  content: '每个工作日早上 9 点提醒我看日报',
  sender,
  source_jid: TOPIC_ROUTE,
  is_from_me: 0,
  source_kind: null,
  automation_run_id: null,
});

/** processTaskIpc with a fake automation service that records its actor. */
function ipcHost(inputs: Record<string, AgentBuilderPersistedInput>) {
  const registry = new AgentBuilderTurnRegistry();
  registry.startBatch(
    agentBuilderTurnScope(FOLDER, SESSION_ID),
    Object.keys(inputs).map((messageId) => ({
      chatJid: SESSION,
      messageId,
      runtimeTurnId: 'delivery-1',
      automationRunId: inputs[messageId].automation_run_id,
    })),
  );
  const handleIpc = vi.fn(
    async (_actor: unknown, request: { requestId: string }) => ({
      requestId: request.requestId,
      success: true,
    }),
  );
  ledger.setAutomationRuntimeService({
    handleIpc,
  } as unknown as Parameters<typeof ledger.setAutomationRuntimeService>[0]);
  const results: Array<[string, Record<string, unknown>]> = [];
  const globals: Record<string, unknown> = {
    registeredGroups: registrations,
    getRegisteredGroup: (jid: string) => registrations[jid],
    getJidsByFolder: () => Object.keys(registrations),
    getChannelType: (jid: string) =>
      jid.startsWith('feishu:') ? 'feishu' : null,
    findWebJidForFolder: () => WORKSPACE,
    getAgent: (id: string) =>
      id === SESSION_ID
        ? { id, kind: 'conversation', chat_jid: WORKSPACE }
        : undefined,
    getUserById: (id: string) =>
      id === OWNER ? { id, role: 'member', status: 'active' } : undefined,
    activeAgentBuilderTurns: registry,
    agentBuilderTurnScope,
    getAgentBuilderInputMessage: (_jid: string, id: string) =>
      inputs[id] ?? null,
    skillMutationTurnRejection,
    deriveAutomationActor,
    handleAutomationIpc,
    writeTaskResult: (
      _dir: string,
      type: string,
      _requestId: string,
      payload: Record<string, unknown>,
    ) => results.push([type, payload]),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('resolveIpcAutomationActor');
  harness.install('processTaskIpc');
  const send = (request: Record<string, unknown>) =>
    (globals.processTaskIpc as (...args: unknown[]) => Promise<void>)(
      { requestId: 'req-1', timestamp: '', ...request },
      FOLDER,
      false,
      false,
      registrations[WORKSPACE],
      '/tmp/unused-tasks',
      SESSION_ID,
    );
  return { send, handleIpc, results };
}

describe('automation tools over task IPC', () => {
  test('the owner in a Feishu topic session creates an automation bound to that session and topic', async () => {
    // The original failure: the runner passed the topic route as the target
    // and the host found no workspace for it. Now nothing is passed; the host
    // derives workspace, session and route from the IPC channel and the turn.
    const host = ipcHost({ m1: humanInput('ou_owner') });
    await host.send({
      type: 'automation_create',
      name: '日报提醒',
      prompt: '提醒我看日报',
      schedule: { kind: 'cron', cronExpr: '0 9 * * 1-5' },
    });
    expect(host.handleIpc).toHaveBeenCalledWith(
      {
        kind: 'owner_turn',
        userId: OWNER,
        isAdmin: false,
        workspaceJid: WORKSPACE,
        sessionJid: SESSION,
        sourceRouteJid: TOPIC_ROUTE,
      },
      expect.objectContaining({ type: 'automation_create' }),
    );
    expect(host.results).toEqual([
      ['automation_create', { requestId: 'req-1', success: true }],
    ]);
  });

  test("a group member's turn reaches the service as other_turn", async () => {
    const host = ipcHost({ m1: humanInput('ou_member') });
    await host.send({ type: 'automation_list' });
    expect(host.handleIpc.mock.calls[0][0]).toEqual({
      kind: 'other_turn',
      workspaceJid: WORKSPACE,
      sessionJid: SESSION,
    });
  });

  test('an automation run turn acts as that run', async () => {
    const host = ipcHost({
      'automation-run-r1': {
        ...humanInput('automation'),
        source_kind: 'automation_prompt',
        automation_run_id: 'r1',
        attachments: JSON.stringify([
          {
            type: 'automation_run_context',
            automationId: 'auto-1',
            automationName: '日报提醒',
            runId: 'r1',
            text: '',
          },
        ]),
      } as AgentBuilderPersistedInput,
    });
    await host.send({
      type: 'automation_complete',
      id: 'auto-1',
      reason: '完成',
    });
    expect(host.handleIpc.mock.calls[0][0]).toEqual({
      kind: 'automation_run',
      workspaceJid: WORKSPACE,
      sessionJid: SESSION,
      automationId: 'auto-1',
      runId: 'r1',
    });
  });

  test('old task tools answer with the move to automations', async () => {
    const host = ipcHost({ m1: humanInput('ou_owner') });
    await host.send({ type: 'schedule_task', prompt: 'x' });
    expect(host.handleIpc).not.toHaveBeenCalled();
    expect(host.results).toEqual([
      [
        'schedule_task',
        { success: false, error: ledger.LEGACY_TASK_IPC_ERROR },
      ],
    ]);
  });

  test('an automation run may not open a fresh window or use the owner profile', async () => {
    const host = ipcHost({
      a1: {
        ...humanInput('automation'),
        source_kind: 'automation_prompt',
        automation_run_id: 'r2',
      },
    });
    await host.send({ type: 'fresh_window', notes: '' });
    await host.send({ type: 'happyclaw_owner_profile', operation: 'get' });
    expect(
      host.results.map(([type, payload]) => [type, payload.success]),
    ).toEqual([
      ['fresh_window', false],
      ['happyclaw_owner_profile', false],
    ]);
    expect(String(host.results[0][1].error)).toContain('自动化');
  });
});

describe('a Runtime Session turn settles its automation run', () => {
  function sessionTurn(agentSourceKind: 'automation' | 'manual') {
    const settled: Array<[string, AutomationRunOutcome]> = [];
    ledger.setAutomationRuntimeService({
      runSink: {
        onRunInputStarted: () => {},
        onRunInputSettled: (runId: string, outcome: AutomationRunOutcome) =>
          settled.push([runId, outcome]),
        isRunSilenced: () => false,
      },
    } as unknown as Parameters<typeof ledger.setAutomationRuntimeService>[0]);
    const automationTurns = new ledger.AutomationTurnTracker();
    const runId = `run-${agentSourceKind}`;
    automationTurns.remember('input-1', [
      { source_kind: 'automation_prompt', automation_run_id: runId },
    ]);
    automationTurns.recordResult('input-1', '今日无新提交');
    const queue = { closeStdin: vi.fn() };
    const globals: Record<string, unknown> = {
      lastProcessed: { id: 'input-1' },
      virtualChatJid: SESSION,
      virtualJid: SESSION,
      agentBuilderScope: 'scope',
      activeAgentBuilderTurns: { clearCompleted: vi.fn() },
      healthyAgentCompletedInputTurns: new Set<string>(),
      agentInputUsageProjection: { complete: vi.fn() },
      automationTurns,
      agent: { source_kind: agentSourceKind },
      queue,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('markAgentOutputSettled', 'processAgentConversation');
    const settle = globals.markAgentOutputSettled as (output: object) => void;
    return { settle, settled, queue, runId };
  }

  test('the final answer settles the run once; a run session releases its runner', () => {
    const turn = sessionTurn('automation');
    turn.settle({ inputTurnId: 'input-1', inputTurnCompleted: true });
    turn.settle({ inputTurnId: 'input-1', inputTurnCompleted: true });
    expect(turn.settled).toEqual([
      [turn.runId, { status: 'success', resultText: '今日无新提交' }],
    ]);
    expect(turn.queue.closeStdin).toHaveBeenCalledTimes(1);
    expect(turn.queue.closeStdin).toHaveBeenCalledWith(SESSION);
  });

  test('a bound user session keeps its warm runner after a run', () => {
    const turn = sessionTurn('manual');
    turn.settle({ inputTurnId: 'input-1', inputTurnCompleted: true });
    expect(turn.settled).toHaveLength(1);
    expect(turn.queue.closeStdin).not.toHaveBeenCalled();
  });
});
