import {
  isOwnerProfileOwnerInput,
  OWNER_PROFILE_TRUSTED_CLAIM_SOURCES,
  type AgentBuilderPersistedInput,
  type AgentBuilderTurnRegistry,
} from './agent-builder-turn-auth.js';

export const SKILL_MUTATION_TASK_RUN_REJECTION =
  '定时任务运行中不能安装或卸载 Skill。请由工作区主人在对话中操作。';
export const SKILL_MUTATION_NON_OWNER_REJECTION =
  '本轮对话不是由工作区主人发起的（群成员、定时任务或系统触发），不能安装或卸载 Skill。请由工作区主人亲自在对话中发起。';

interface OwnerGroupRow {
  created_by?: string;
  owner_im_id?: string;
  owner_claim_source?: string;
}

/**
 * Why an Agent's install_skill / uninstall_skill request must be refused, or
 * null when the turn that issued it belongs to the workspace owner.
 *
 * Installing changes every workspace of the owner and runs third-party code,
 * so the workspace owning the runner is not enough: in a group chat any
 * member's message can start the turn. The executing batch (and everything
 * queued behind it) must be the owner's own human input, with the owner's IM
 * identity anchored the same way Owner Profile anchors it.
 */
export function skillMutationTurnRejection(input: {
  registry: Pick<AgentBuilderTurnRegistry, 'requireOwnerHumanTurn'>;
  /** Folder of the verified IPC namespace. */
  sourceFolder: string;
  /** Turn-registry scope of the requesting runtime (agentBuilderTurnScope). */
  turnScope: string;
  isolatedTaskRun: boolean;
  ownerUserId: string;
  loadPersistedInput: (
    chatJid: string,
    messageId: string,
  ) => AgentBuilderPersistedInput | null;
  getGroup: (jid: string) => OwnerGroupRow | undefined;
  getFolderJids: (folder: string) => string[];
  getChannelType: (jid: string) => string | null;
}): string | null {
  if (input.isolatedTaskRun) return SKILL_MUTATION_TASK_RUN_REJECTION;
  const ownerImIds = (provider: string): string[] => {
    const ids = new Set<string>();
    for (const jid of input.getFolderJids(input.sourceFolder)) {
      if (input.getChannelType(jid) !== provider) continue;
      const row = input.getGroup(jid);
      if (
        row?.created_by === input.ownerUserId &&
        row.owner_im_id &&
        row.owner_claim_source &&
        OWNER_PROFILE_TRUSTED_CLAIM_SOURCES.includes(row.owner_claim_source)
      ) {
        ids.add(row.owner_im_id);
      }
    }
    return [...ids];
  };
  try {
    input.registry.requireOwnerHumanTurn(
      input.turnScope,
      input.loadPersistedInput,
      (persisted) =>
        isOwnerProfileOwnerInput(
          persisted,
          input.ownerUserId,
          input.getGroup,
          ownerImIds,
        ),
    );
    return null;
  } catch {
    return SKILL_MUTATION_NON_OWNER_REJECTION;
  }
}
