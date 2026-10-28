import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { ChevronRight, Folder, Link2, Pin } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useChatStore } from '../../../stores/chat';
import { useAuthStore } from '../../../stores/auth';
import { useGroupsStore } from '../../../stores/groups';
import { useShellStore } from '../../../stores/shell';
import { useSessionActions } from '../../../hooks/useSessionActions';
import { useStableCallback } from '../../../hooks/useStableCallback';
import {
  openWorkspaceSession,
  type NavigateToPath,
} from '../../../lib/chat-navigation';
import {
  formatSessionTime,
  isNativeManagedSession,
  messagePreview,
  previewText,
  sessionActivityAt,
} from '../../../lib/session-presentation';
import {
  type AgentWorkspaceSection,
  getPrimaryAgentWorkspaceRows,
} from '../../../utils/agent-product';
import type { AgentDisplayIdentity } from '../../../utils/agent-identity';
import type { AgentInfo, SessionWorktreeInfo } from '../../../types';
import { WorktreeBranchTag } from '../../chat/WorktreeBranchTag';
import type { GroupEntry } from '../../../utils/group-utils';
import {
  AgentAvatar,
  RowMenu,
  WorkspaceRowMenu,
  profileIdOf,
  sectionIdentity,
  workspaceDisplayName,
  type WorkspaceMenuActions,
} from './WorkspaceTree';
import {
  MAIN_BINDING,
  RenameSessionDialog,
  SessionMenuItems,
  useWorkspaceSessions,
} from './workspace-sessions';

/** Sessions shown under a workspace before 显示更多, as in cindy's projects. */
const INITIAL_VISIBLE = 5;

/** One workspace header of the list, with what it shows and acts on. */
interface WorkspaceEntry {
  group: GroupEntry;
  label: string;
  /** The agent, shown after the name of one of its several workspaces. */
  agentName?: string;
  identity: AgentDisplayIdentity | null;
  agentId?: string;
  isHome: boolean;
}

/** The list creates sessions itself; the page supplies the rest. */
export type PhoneWorkspaceActions = Omit<
  WorkspaceMenuActions,
  'onCreateSession'
>;

interface PhoneWorkspaceListProps {
  primary: AgentWorkspaceSection | null;
  custom: AgentWorkspaceSection[];
  actions: PhoneWorkspaceActions;
  /** A workspace to expand and scroll to, once per navigation `key`. */
  reveal?: { folder: string; key: string } | null;
}

/**
 * The phone home, after cindy's mobile list: one level where each workspace
 * header (collapsible, remembered like the desktop tree's) has its
 * conversations directly under it. Pinned workspaces come first, then the
 * primary agent's, then custom agents'. Workspace and session actions live
 * in each row's ⋯ menu.
 */
export function PhoneWorkspaceList({
  primary,
  custom,
  actions,
  reveal = null,
}: PhoneWorkspaceListProps) {
  const navigate = useNavigate();
  const appearance = useAuthStore((s) => s.appearance);
  const username = useAuthStore((s) => s.user?.username);
  // Workspaces are open unless collapsed, and the choice is kept with the
  // desktop tree's.
  const expandedWorkspaces = useShellStore((s) => s.expandedWorkspaces);
  const setWorkspaceExpanded = useShellStore((s) => s.setWorkspaceExpanded);
  const revealWorkspace = useShellStore((s) => s.revealWorkspace);
  const requestComposerFocus = useShellStore((s) => s.requestComposerFocus);
  const { createSession } = useSessionActions();

  const sections = useMemo(() => {
    const pinned: WorkspaceEntry[] = [];
    const primaryRows: WorkspaceEntry[] = [];
    const customRows: WorkspaceEntry[] = [];
    const add = (rows: WorkspaceEntry[], entry: WorkspaceEntry) =>
      (entry.group.pinned_at && !entry.isHome ? pinned : rows).push(entry);
    if (primary) {
      const identity = sectionIdentity(primary, appearance, true);
      for (const group of getPrimaryAgentWorkspaceRows(primary)) {
        const isHome = !!group.is_my_home;
        add(primaryRows, {
          group,
          label: workspaceDisplayName(group, isHome, username),
          identity: isHome ? identity : null,
          isHome,
        });
      }
    }
    for (const section of custom) {
      const identity = sectionIdentity(section, appearance, false);
      const single = section.items.length === 1;
      for (const group of section.items) {
        add(customRows, {
          group,
          label: single ? section.name : group.name,
          agentName: single ? undefined : section.name,
          identity,
          agentId: profileIdOf(section),
          isHome: !!group.is_my_home,
        });
      }
    }
    return [
      { title: '已固定', entries: pinned },
      { title: '主智能体', entries: primaryRows },
      { title: '自定义智能体', entries: customRows },
    ].filter((section) => section.entries.length > 0);
  }, [primary, custom, appearance, username]);

  // `?sessions=1` lands here: open that workspace and bring it into view.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reveal) return;
    const entry = sections
      .flatMap((section) => section.entries)
      .find((item) => item.group.folder === reveal.folder);
    if (!entry) return;
    revealWorkspace(entry.group.jid);
    const frame = requestAnimationFrame(() =>
      listRef.current
        ?.querySelector(`[data-phone-workspace="${CSS.escape(reveal.folder)}"]`)
        ?.scrollIntoView({ block: 'start' }),
    );
    return () => cancelAnimationFrame(frame);
    // Once per navigation: later list changes must not scroll the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.key]);

  const navigateTo = useStableCallback((to: string) => navigate(to));
  const toggleExpanded = useStableCallback((jid: string, expanded: boolean) =>
    setWorkspaceExpanded(jid, expanded),
  );
  const createWorkspaceSession = useStableCallback(
    async (
      group: GroupEntry,
      options?: { name?: string; worktree?: boolean },
    ) => {
      const session = await createSession(group.jid, options);
      if (!session) return false;
      openWorkspaceSession(navigateTo, group, session.id);
      requestComposerFocus();
      return true;
    },
  );
  const menuActions = useMemo<WorkspaceMenuActions>(
    () => ({ ...actions, onCreateSession: createWorkspaceSession }),
    [actions, createWorkspaceSession],
  );

  return (
    <div ref={listRef} data-hc-phone-workspace-list>
      {sections.map((section) => (
        <section key={section.title} aria-label={section.title}>
          <h2 className="px-4 pt-4 pb-1 text-label font-medium text-faint-foreground">
            {section.title}
          </h2>
          <ul>
            {section.entries.map((entry) => (
              <WorkspaceBlock
                key={entry.group.jid}
                entry={entry}
                expanded={expandedWorkspaces[entry.group.jid] !== false}
                onExpandedChange={toggleExpanded}
                menuActions={menuActions}
                navigate={navigateTo}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const WorkspaceBlock = memo(function WorkspaceBlock({
  entry,
  expanded,
  onExpandedChange,
  menuActions,
  navigate,
}: {
  entry: WorkspaceEntry;
  expanded: boolean;
  onExpandedChange: (jid: string, expanded: boolean) => void;
  menuActions: WorkspaceMenuActions;
  navigate: NavigateToPath;
}) {
  const { group, label, agentName, identity, agentId, isHome } = entry;
  const contentId = useId();
  const isRunning = useGroupsStore(
    (s) => s.runnerStates[group.jid] === 'running',
  );
  // Unread replies are counted per workspace, not per session.
  const unread = useChatStore((s) => s.unreadReplies[group.jid] ?? 0);

  return (
    <li className="scroll-mt-14 list-none" data-phone-workspace={group.folder}>
      <div className="flex h-14 items-center gap-1 pr-2 pl-4">
        <button
          type="button"
          onClick={() => onExpandedChange(group.jid, !expanded)}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {identity ? (
            <AgentAvatar identity={identity} touch />
          ) : (
            <span
              aria-hidden="true"
              className="grid size-6 shrink-0 place-items-center text-faint-foreground"
            >
              <Folder className="size-5" />
            </span>
          )}
          <span className="truncate text-base leading-7 font-medium text-foreground">
            {label}
          </span>
          {agentName && (
            <span className="max-w-[40%] shrink-0 truncate text-label text-faint-foreground">
              {agentName}
            </span>
          )}
          {group.pinned_at && !isHome && (
            <Pin
              className="size-3.5 shrink-0 text-faint-foreground"
              aria-label="已固定"
            />
          )}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-4 shrink-0 text-faint-foreground transition-transform duration-150 motion-reduce:transition-none',
              expanded && 'rotate-90',
            )}
          />
        </button>
        {isRunning ? (
          <Spinner
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label="运行中"
          />
        ) : (
          unread > 0 && (
            <span
              role="img"
              aria-label={`${unread} 条未读回复`}
              className="size-2 shrink-0 rounded-full bg-primary"
            />
          )
        )}
        <WorkspaceRowMenu
          group={group}
          isHome={isHome}
          displayName={label}
          agentId={agentId}
          actions={menuActions}
          touch
          withCreateSession
        />
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <m.div
            id={contentId}
            key="sessions"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <WorkspaceSessions group={group} navigate={navigate} />
          </m.div>
        )}
      </AnimatePresence>
    </li>
  );
});

/** The main conversation and the newest sessions of an open workspace. */
function WorkspaceSessions({
  group,
  navigate,
}: {
  group: GroupEntry;
  navigate: NavigateToPath;
}) {
  const { containerRef, sessions } = useWorkspaceSessions<HTMLUListElement>(
    group.jid,
  );
  const requestBinding = useShellStore((s) => s.requestBinding);
  const { deleteSession } = useSessionActions();
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [renameTarget, setRenameTarget] = useState<AgentInfo | null>(null);

  const canModify = !!group.can_modify;
  const mainLabel = group.is_my_home ? '直接对话' : '当前对话';
  const hidden = sessions.length - visibleCount;
  const open = (sessionId: string | null) =>
    openWorkspaceSession(navigate, group, sessionId);
  // Binding lives in ChatView, which stays mounted behind this list for the
  // current workspace: make this one current and let it open the dialog.
  const openBinding = (target: string) => {
    useChatStore.getState().selectGroup(group.jid);
    requestBinding(group.jid, target);
  };

  return (
    <ul ref={containerRef}>
      <PhoneSessionRow
        title={mainLabel}
        preview={previewText(group.lastMessage) || '暂无消息'}
        time={
          group.lastMessageTime ? formatSessionTime(group.lastMessageTime) : ''
        }
        onOpen={() => open(null)}
        menu={
          canModify ? (
            <SessionMenuItems onBind={() => openBinding(MAIN_BINDING)} />
          ) : undefined
        }
      />
      {sessions.slice(0, visibleCount).map((session) => {
        const running = session.status === 'running';
        return (
          <PhoneSessionRow
            key={session.id}
            title={session.name || '新会话'}
            preview={
              running ? '正在生成回复' : messagePreview(session) || '暂无消息'
            }
            time={formatSessionTime(sessionActivityAt(session))}
            busy={
              session.title_generating
                ? '正在生成标题'
                : running
                  ? '正在生成回复'
                  : undefined
            }
            linked={(session.linked_im_groups?.length ?? 0) > 0}
            worktree={session.worktree}
            onOpen={() => open(session.id)}
            menu={
              canModify && !isNativeManagedSession(session) ? (
                <SessionMenuItems
                  onBind={() => openBinding(session.id)}
                  onRename={() => setRenameTarget(session)}
                  onDelete={() =>
                    deleteSession(group.jid, session.id, openBinding)
                  }
                />
              ) : undefined
            }
          />
        );
      })}
      {hidden > 0 && (
        <li className="list-none">
          <button
            type="button"
            onClick={() => setVisibleCount((n) => n + 20)}
            className="flex h-12 w-full cursor-pointer items-center pl-13 text-body-lg text-muted-foreground outline-none active:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            显示更多（{hidden}）
          </button>
        </li>
      )}
      <RenameSessionDialog
        groupJid={group.jid}
        session={renameTarget}
        onClose={() => setRenameTarget(null)}
      />
    </ul>
  );
}

/**
 * A 78px conversation row: title (18/28) with the time at the top right,
 * a one-line preview (15/26) under it, and the ⋯ menu at the end of the
 * preview line. The whole row opens the conversation.
 */
function PhoneSessionRow({
  title,
  preview,
  time,
  busy,
  linked = false,
  worktree,
  onOpen,
  menu,
}: {
  title: string;
  preview: string;
  time: string;
  /** Shown as a spinner in place of the time while the session works. */
  busy?: string;
  linked?: boolean;
  worktree?: SessionWorktreeInfo | null;
  onOpen: () => void;
  menu?: ReactNode;
}) {
  const previewId = useId();
  return (
    // Indented to the workspace name, so the row reads as part of it.
    <li className="relative list-none pl-13 active:bg-surface-hover">
      <div className="grid h-[78px] grid-cols-[minmax(0,1fr)_auto] grid-rows-[28px_26px] content-center items-center gap-x-2 border-b border-surface-border pr-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {/* The button's box covers the row, so tapping anywhere opens it;
              only the menu sits above. */}
          <button
            type="button"
            onClick={onOpen}
            aria-describedby={previewId}
            className="min-w-0 cursor-pointer truncate text-left text-lg font-medium text-foreground outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/40 focus-visible:after:ring-inset"
          >
            {title}
          </button>
          {worktree && (
            <WorktreeBranchTag
              worktree={worktree}
              compact
              className="max-w-28"
            />
          )}
          {linked && (
            <Link2
              className="size-3.5 shrink-0 text-faint-foreground"
              aria-label="已绑定消息渠道"
            />
          )}
        </span>
        {busy ? (
          <Spinner
            className="mr-1 size-3.5 justify-self-end text-muted-foreground"
            aria-label={busy}
          />
        ) : (
          <span className="mr-1 justify-self-end text-label text-faint-foreground tabular-nums">
            {time}
          </span>
        )}
        <span
          id={previewId}
          className="truncate text-body-lg text-muted-foreground"
        >
          {preview}
        </span>
        <span className="relative z-10 -my-2 justify-self-end">
          {menu && (
            <RowMenu label={`${title}的更多操作`} touch>
              {menu}
            </RowMenu>
          )}
        </span>
      </div>
    </li>
  );
}
