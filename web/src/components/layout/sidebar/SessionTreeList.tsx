import { memo, useMemo, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Link2, Search, Trash2 } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useShellStore } from '../../../stores/shell';
import { useSessionActions } from '../../../hooks/useSessionActions';
import {
  chatHref,
  openWorkspaceSession,
  type NavigateToPath,
} from '../../../lib/chat-navigation';
import {
  formatSessionTime,
  isNativeManagedSession,
  messagePreview,
  sessionActivityAt,
} from '../../../lib/session-presentation';
import type { AgentInfo, SessionWorktreeInfo } from '../../../types';
import { WorktreeBranchTag } from '../../chat/WorktreeBranchTag';
import type { GroupEntry } from '../../../utils/group-utils';
import { sidebarRowClass } from './SidebarItem';
import { RowMenu, revealOnRowHover, rowIconButtonClass } from './WorkspaceTree';
import {
  MAIN_BINDING,
  RenameSessionDialog,
  SessionMenuItems,
  useWorkspaceSessions,
} from './workspace-sessions';

const INITIAL_VISIBLE = 8;
const SEARCH_THRESHOLD = 8;

interface SessionTreeListProps {
  group: GroupEntry;
  /** Whether this workspace is the one open in the canvas. */
  isCurrent: boolean;
  /** Session open in the canvas (null = main conversation). */
  activeSessionId: string | null;
  /** Nesting depth of the workspace row, so sessions align with its name. */
  depth?: number;
  /**
   * Stable navigation from the sidebar. `useNavigate()` here would re-render
   * every expanded list on each route change.
   */
  navigate: NavigateToPath;
}

/** Sessions nested under an expanded workspace in the desktop sidebar. */
export const SessionTreeList = memo(function SessionTreeList({
  group,
  isCurrent,
  activeSessionId,
  depth = 0,
  navigate,
}: SessionTreeListProps) {
  const { containerRef, sessions } = useWorkspaceSessions<HTMLDivElement>(
    group.jid,
  );
  const requestBinding = useShellStore((s) => s.requestBinding);
  const { deleteSession } = useSessionActions();
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [query, setQuery] = useState('');
  const [renameTarget, setRenameTarget] = useState<AgentInfo | null>(null);

  const canModify = !!group.can_modify;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  // Lowercased name and preview per session, built once per list while
  // searching instead of for every session on every keystroke.
  const searching = normalizedQuery.length > 0;
  const searchText = useMemo(
    () =>
      searching
        ? new Map(
            sessions.map((session) => [
              session.id,
              `${session.name}\n${messagePreview(session)}`.toLocaleLowerCase(),
            ]),
          )
        : null,
    [sessions, searching],
  );
  const filtered = searchText
    ? sessions.filter((session) =>
        searchText.get(session.id)?.includes(normalizedQuery),
      )
    : sessions;
  const visible = filtered.slice(0, visibleCount);
  const mainLabel = group.is_my_home ? '直接对话' : '当前对话';

  // Binding lives in ChatView; open the workspace first so it can react.
  const openBinding = (target: string) => {
    if (!isCurrent) navigate(chatHref(group.folder));
    requestBinding(group.jid, target);
  };

  return (
    <div
      ref={containerRef}
      className={cn('relative pt-0.5 pb-1', depth > 0 ? 'pl-7' : 'pl-3.5')}
    >
      {/* Tree guide line under the workspace row's icon. */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute top-0 bottom-1 w-px bg-surface-border',
          depth > 0 ? 'left-[1.625rem]' : 'left-3.5',
        )}
      />
      {sessions.length >= SEARCH_THRESHOLD && (
        <label className="mb-0.5 ml-2 flex h-7 items-center gap-1.5 rounded-md px-2 text-caption text-muted-foreground focus-within:bg-surface-hover">
          <Search className="size-3.5 shrink-0" />
          <span className="sr-only">搜索会话</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`搜索 ${sessions.length + 1} 个会话…`}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint-foreground"
          />
        </label>
      )}
      <ul>
        <SessionRow
          name={mainLabel}
          active={isCurrent && activeSessionId === null}
          onSelect={() => openWorkspaceSession(navigate, group, null)}
          menu={
            canModify ? (
              <SessionMenuItems onBind={() => openBinding(MAIN_BINDING)} />
            ) : undefined
          }
          menuLabel={`${mainLabel}的更多操作`}
        />
        <AnimatePresence initial={false}>
          {visible.map((session) => {
            const nativeManaged = isNativeManagedSession(session);
            return (
              <m.li
                key={session.id}
                // Search results appear and disappear instantly: animating
                // dozens of rows in and out on every keystroke was a third of
                // the per-key cost in long lists.
                initial={searching ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={searching ? undefined : { opacity: 0, height: 0 }}
                className="list-none overflow-hidden"
              >
                <SessionRow
                  asListItem={false}
                  name={session.name || '新会话'}
                  active={isCurrent && activeSessionId === session.id}
                  running={session.status === 'running'}
                  titleGenerating={session.title_generating}
                  linked={(session.linked_im_groups?.length ?? 0) > 0}
                  worktree={session.worktree}
                  time={formatSessionTime(sessionActivityAt(session))}
                  onSelect={() =>
                    openWorkspaceSession(navigate, group, session.id)
                  }
                  onDelete={
                    canModify && !nativeManaged
                      ? () => deleteSession(group.jid, session.id, openBinding)
                      : undefined
                  }
                  deleteLabel={`删除${session.name || '新会话'}`}
                  menuLabel={`${session.name}的更多操作`}
                  menu={
                    canModify && !nativeManaged ? (
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
              </m.li>
            );
          })}
        </AnimatePresence>
      </ul>
      {filtered.length > visibleCount && (
        <button
          type="button"
          onClick={() => setVisibleCount((n) => n + 30)}
          className={cn(sidebarRowClass, 'ml-2 h-7 w-auto text-caption')}
        >
          显示更多（{filtered.length - visibleCount}）
        </button>
      )}
      {normalizedQuery && filtered.length === 0 && (
        <p className="px-4 py-1.5 text-caption text-faint-foreground">
          没有匹配的会话
        </p>
      )}
      <RenameSessionDialog
        groupJid={group.jid}
        session={renameTarget}
        onClose={() => setRenameTarget(null)}
      />
    </div>
  );
});

function SessionRow({
  name,
  active,
  running = false,
  titleGenerating = false,
  linked = false,
  worktree,
  time,
  onSelect,
  onDelete,
  deleteLabel,
  menu,
  menuLabel,
  asListItem = true,
}: {
  name: string;
  active: boolean;
  running?: boolean;
  titleGenerating?: boolean;
  linked?: boolean;
  worktree?: SessionWorktreeInfo | null;
  time?: string;
  onSelect: () => void;
  /** Shown next to the menu on hover; the handler asks for confirmation. */
  onDelete?: () => void;
  deleteLabel?: string;
  menu?: React.ReactNode;
  menuLabel: string;
  asListItem?: boolean;
}) {
  const hasActions = !!menu || !!onDelete;
  const row = (
    <div
      data-active={active || undefined}
      className={cn(
        sidebarRowClass,
        'ml-2 h-7 w-[calc(100%-0.5rem)] gap-1.5 pr-1',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left outline-none"
      >
        <span className="truncate">{name}</span>
        {worktree && (
          <WorktreeBranchTag worktree={worktree} compact className="max-w-24" />
        )}
        {linked && (
          <Link2
            className="size-3 shrink-0 text-faint-foreground"
            aria-label="已绑定消息渠道"
          />
        )}
      </button>
      {running || titleGenerating ? (
        <Spinner
          className="size-3 shrink-0 text-muted-foreground"
          aria-label={titleGenerating ? '正在生成标题' : '正在生成回复'}
        />
      ) : (
        time && (
          <span
            className={cn(
              'shrink-0 text-micro text-faint-foreground tabular-nums',
              hasActions &&
                'pointer-fine:group-hover/sidebar-row:hidden pointer-fine:group-has-[:focus-visible]/sidebar-row:hidden pointer-fine:group-has-[[aria-expanded=true]]/sidebar-row:hidden',
            )}
          >
            {time}
          </span>
        )
      )}
      {hasActions && (
        // The time gives way to the actions on hover, keyboard focus, or
        // while the menu is open.
        <span
          className={cn(
            'flex shrink-0 items-center',
            time &&
              'pointer-fine:hidden pointer-fine:group-hover/sidebar-row:flex pointer-fine:group-has-[:focus-visible]/sidebar-row:flex pointer-fine:has-[[aria-expanded=true]]:flex',
          )}
        >
          {onDelete && (
            <button
              type="button"
              aria-label={deleteLabel}
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              className={cn(
                rowIconButtonClass,
                revealOnRowHover,
                'hover:text-destructive',
              )}
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
          {menu && <RowMenu label={menuLabel}>{menu}</RowMenu>}
        </span>
      )}
    </div>
  );
  return asListItem ? <li className="list-none">{row}</li> : row;
}
