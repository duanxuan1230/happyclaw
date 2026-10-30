import { useEffect, useMemo, useRef } from 'react';
import { Link2, Pencil, Timer, Trash2 } from 'lucide-react';
import { PromptDialog } from '@/components/common/PromptDialog';
import { isLiveStream, useChatStore } from '../../../stores/chat';
import { buildConversationSessions } from '../../../lib/session-presentation';
import type { AgentInfo } from '../../../types';
import type { MenuAction } from '../../common/ResponsiveMenu';
import { MenuActionItems } from './WorkspaceTree';

// Session lists shared by the desktop sidebar tree and the phone home list.

const EMPTY_AGENTS: AgentInfo[] = [];

/** The binding target of a workspace's main conversation. */
export const MAIN_BINDING = '__main__';

/**
 * A workspace's conversations, newest first. They are fetched once the
 * element behind `containerRef` scrolls into view: a workspace far down a
 * long list should not cost a request on every load.
 */
export function useWorkspaceSessions<T extends Element>(groupJid: string) {
  const loadAgents = useChatStore((s) => s.loadAgents);
  const agents = useChatStore((s) => s.agents[groupJid] ?? EMPTY_AGENTS);
  // A joined id string keeps streaming deltas from re-rendering the list:
  // it only changes when a session starts or stops answering.
  // A card frozen by a stop is not a running query.
  const activeQueryIds = useChatStore((s) =>
    (s.agents[groupJid] ?? EMPTY_AGENTS)
      .filter(
        (a) => s.agentWaiting[a.id] || isLiveStream(s.agentStreaming[a.id]),
      )
      .map((a) => a.id)
      .join(','),
  );

  const containerRef = useRef<T>(null);
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      void loadAgents(groupJid);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void loadAgents(groupJid);
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [groupJid, loadAgents]);

  const sessions = useMemo(() => {
    const active = new Set(activeQueryIds ? activeQueryIds.split(',') : []);
    return buildConversationSessions(agents, (id) => active.has(id));
  }, [agents, activeQueryIds]);

  return { containerRef, sessions };
}

interface SessionMenuHandlers {
  onBind: () => void;
  onCreateAutomation?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}

/** A conversation row's ⋯ actions; the main conversation only binds. */
export function sessionMenuGroups({
  onBind,
  onCreateAutomation,
  onRename,
  onDelete,
}: SessionMenuHandlers): MenuAction[][] {
  const actions: MenuAction[] = [
    { label: '会话绑定', icon: Link2, onSelect: onBind },
  ];
  if (onCreateAutomation) {
    actions.push({
      label: '从此会话创建自动化…',
      icon: Timer,
      onSelect: onCreateAutomation,
    });
  }
  if (onRename)
    actions.push({ label: '重命名', icon: Pencil, onSelect: onRename });
  if (onDelete) {
    actions.push({
      label: '删除',
      icon: Trash2,
      destructive: true,
      onSelect: onDelete,
    });
  }
  return [actions];
}

/** The same actions as dropdown items, for the desktop session tree. */
export function SessionMenuItems(handlers: SessionMenuHandlers) {
  return <MenuActionItems groups={sessionMenuGroups(handlers)} />;
}

/** Renames `session` (open while it is set). */
export function RenameSessionDialog({
  groupJid,
  session,
  onClose,
}: {
  groupJid: string;
  session: AgentInfo | null;
  onClose: () => void;
}) {
  const renameConversation = useChatStore((s) => s.renameConversation);
  return (
    <PromptDialog
      open={session !== null}
      title="重命名对话"
      label="对话名称"
      placeholder="输入新名称"
      defaultValue={session?.name ?? ''}
      onConfirm={(name) => {
        if (session) void renameConversation(groupJid, session.id, name);
      }}
      onClose={onClose}
    />
  );
}
