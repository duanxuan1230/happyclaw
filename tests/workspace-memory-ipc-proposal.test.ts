import { describe, expect, test, vi } from 'vitest';

import { signWorkspaceMemoryMutation } from '../container/agent-runner/src/workspace-memory-auth.js';
import {
  agentBuilderTurnScope,
  AgentBuilderTurnRegistry,
  type AgentBuilderPersistedInput,
} from '../src/agent-builder-turn-auth.js';
import { WorkspaceMemoryServiceError } from '../src/memory-service.js';
import {
  issueWorkspaceMemoryWriteCapability,
  revokeWorkspaceMemoryWriteCapability,
  verifyAndConsumeWorkspaceMemoryMutation,
} from '../src/workspace-memory-capability.js';
import {
  isWorkspaceMemoryMutation,
  isWorkspaceMemoryOwnerTurn,
  workspaceMemoryWriteRejection,
} from '../src/workspace-memory-ipc.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const FOLDER = 'team';
const OWNER = 'owner-1';

const registrations: Record<string, Record<string, unknown>> = {
  'web:team': { folder: FOLDER, created_by: OWNER },
  'feishu:oc_group': {
    folder: FOLDER,
    created_by: OWNER,
    owner_im_id: 'ou_owner',
    owner_claim_source: 'auto_feishu',
  },
};

/**
 * The host's Workspace Memory IPC case, run from index.ts: what a create
 * becomes for the turn that asked for it.
 */
function host(inputs: Record<string, AgentBuilderPersistedInput>) {
  const results: Array<Record<string, unknown>> = [];
  const createWorkspaceMemory = vi.fn((input: Record<string, unknown>) => ({
    storeRevision: 1,
    item: { id: 'wmi_1', revision: 1 },
    replayed: false,
    proposal: input.proposal,
  }));
  const activeAgentBuilderTurns = new AgentBuilderTurnRegistry();
  const globals: Record<string, unknown> = {
    resolveScheduledTaskIpcRunId: () => null,
    extractDurableTaskRunIdFromNamespace: () => null,
    getTaskRunById: () => undefined,
    getUserHomeGroup: () => undefined,
    resolveBroadcastFolder: () => FOLDER,
    registeredGroups: registrations,
    getRegisteredGroup: (jid: string) => registrations[jid],
    getUserById: (id: string) =>
      id === OWNER ? { id, role: 'member', status: 'active' } : undefined,
    canAccessGroup: vi.fn(),
    SAFE_REQUEST_ID_RE: /^[A-Za-z0-9_-]+$/,
    WorkspaceMemoryServiceError,
    getJidsByFolder: () => Object.keys(registrations),
    getChannelType: (jid: string) =>
      jid.startsWith('feishu:') ? 'feishu' : null,
    activeAgentBuilderTurns,
    agentBuilderTurnScope,
    getAgentBuilderInputMessage: (_chatJid: string, messageId: string) =>
      inputs[messageId] ?? null,
    getAgent: () => undefined,
    isWorkspaceMemoryMutation,
    isWorkspaceMemoryOwnerTurn,
    workspaceMemoryWriteRejection,
    verifyAndConsumeWorkspaceMemoryMutation,
    createWorkspaceMemory,
    writeTaskResult: (
      _dir: string,
      _type: string,
      _id: string,
      payload: Record<string, unknown>,
    ) => results.push(payload),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('processTaskIpc');
  const create = async (
    turnId: string,
    taskRunId: string | null = null,
    sign = true,
  ) => {
    const scope = { groupFolder: FOLDER, agentId: null, taskRunId };
    const capability = issueWorkspaceMemoryWriteCapability(scope, turnId);
    const request: Record<string, unknown> = {
      type: 'workspace_memory',
      operation: 'create',
      requestId: `req-${turnId}`,
      inputTurnId: turnId,
      kind: 'fact',
      content: 'Deploys go through launchd.',
      runnerInstanceId: capability.runnerInstanceId,
    };
    if (sign) {
      request.mutationSignature = signWorkspaceMemoryMutation(
        capability.signingSecret,
        scope,
        request,
      );
    }
    try {
      await (globals.processTaskIpc as (...args: unknown[]) => Promise<void>)(
        request,
        FOLDER,
        false,
        false,
        registrations['web:team'],
        '/tmp/unused',
        null,
        taskRunId,
      );
    } finally {
      revokeWorkspaceMemoryWriteCapability(scope, capability.runnerInstanceId);
    }
    return results.at(-1);
  };
  const start = (chatJid: string, messageId: string) =>
    activeAgentBuilderTurns.set(FOLDER, chatJid, messageId);
  return { create, start, createWorkspaceMemory };
}

const human = (
  sender: string,
  sourceJid: string,
): AgentBuilderPersistedInput => ({
  content: 'remember this',
  sender,
  source_jid: sourceJid,
  is_from_me: 0,
  source_kind: null,
  task_id: null,
});

describe('what a Workspace Memory write becomes on the host', () => {
  test("the owner's own turn writes; a group member's turn proposes", async () => {
    const { create, start } = host({
      'om-owner': human('ou_owner', 'feishu:oc_group'),
      'om-member': human('ou_member', 'feishu:oc_group'),
      'web-owner': human(OWNER, 'web:team'),
    });
    start('web:team', 'web-owner');
    expect(await create('web-owner')).toMatchObject({
      success: true,
      proposal: false,
    });
    start('feishu:oc_group', 'om-owner');
    expect(await create('om-owner')).toMatchObject({
      success: true,
      proposal: false,
    });
    start('feishu:oc_group', 'om-member');
    expect(await create('om-member')).toMatchObject({
      success: true,
      proposal: true,
    });
  });

  test('a scheduled run proposes, and only with its signed capability', async () => {
    const { create, createWorkspaceMemory } = host({});
    expect(await create('run-1', 'task-run-1')).toMatchObject({
      success: true,
      proposal: true,
    });
    expect(await create('run-2', 'task-run-2', false)).toMatchObject({
      success: false,
      code: 'workspace_memory_invalid_capability',
    });
    expect(createWorkspaceMemory).toHaveBeenCalledTimes(1);
  });
});
