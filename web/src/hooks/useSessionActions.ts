import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useChatStore } from '../stores/chat';
import { confirmDialog } from '../stores/confirm';
import {
  confirmDiscardWorktreeChanges,
  describeIncludeIncomplete,
  WORKTREE_IGNORED_FILES_NOTE,
} from '../lib/session-worktree';
import type { AgentInfo } from '../types';

/**
 * Create / delete Runtime Sessions with the user-facing error handling shared
 * by ChatView's session list and the sidebar session tree.
 */
export function useSessionActions() {
  const [creatingSession, setCreatingSession] = useState(false);
  const createConversation = useChatStore((s) => s.createConversation);
  const deleteAgentAction = useChatStore((s) => s.deleteAgentAction);

  const createSession = useCallback(
    async (
      groupJid: string,
      options?: { name?: string; worktree?: boolean },
    ): Promise<AgentInfo | null> => {
      if (creatingSession) return null;
      setCreatingSession(true);
      try {
        const agent = await createConversation(
          groupJid,
          options?.name ?? '',
          undefined,
          { worktree: options?.worktree },
        );
        if (!agent) {
          toast.error(useChatStore.getState().error || '创建 Web 会话失败');
          return null;
        }
        const incomplete = agent.worktree?.include_incomplete;
        if (incomplete) {
          toast.warning('部分 .worktreeinclude 文件没有复制到新 worktree', {
            description: describeIncludeIncomplete(incomplete),
          });
        }
        return agent;
      } finally {
        setCreatingSession(false);
      }
    },
    [createConversation, creatingSession],
  );

  /**
   * Sessions still bound to an IM channel must be unbound first; in that case
   * `onNeedsUnbind` opens the binding dialog instead of deleting. Otherwise the
   * user confirms first, since deletion drops the session's history. A
   * worktree with uncommitted changes asks once more before they are lost.
   */
  const deleteSession = useCallback(
    (groupJid: string, id: string, onNeedsUnbind: (id: string) => void) => {
      const agent = (useChatStore.getState().agents[groupJid] || []).find(
        (item) => item.id === id,
      );
      if (agent?.linked_im_groups && agent.linked_im_groups.length > 0) {
        const names = agent.linked_im_groups
          .map((item) => item.name)
          .join('、');
        onNeedsUnbind(id);
        toast.error('请先解绑消息渠道', {
          description: `当前绑定：${names}`,
        });
        return;
      }
      void (async () => {
        const name = agent?.name || '会话';
        const confirmed = await confirmDialog({
          title: '删除会话',
          message: agent?.worktree
            ? `确定删除「${name}」吗？会话的对话记录会一并删除，无法恢复；它的独立 worktree 目录会被移除，分支 ${agent.worktree.branch} 保留。${WORKTREE_IGNORED_FILES_NOTE}`
            : `确定删除「${name}」吗？会话的对话记录会一并删除，无法恢复。工作区文件不受影响。`,
          confirmText: '删除',
          variant: 'danger',
        });
        if (!confirmed) return;
        let result = await deleteAgentAction(groupJid, id);
        if (typeof result === 'object') {
          const discard = await confirmDiscardWorktreeChanges(
            result.worktreesDirty,
            '丢弃并删除',
          );
          if (!discard) return;
          result = await deleteAgentAction(groupJid, id, {
            forceWorktree: true,
          });
        }
        if (result !== true) {
          toast.error(useChatStore.getState().error || '删除会话失败');
        }
      })();
    },
    [deleteAgentAction],
  );

  return { creatingSession, createSession, deleteSession };
}
