import type { ApiError } from '../api/client';
import { confirmDialog } from '../stores/confirm';

/** What removing a session's worktree would lose (409 WORKTREE_DIRTY). */
export interface WorktreeDirtyInfo {
  branch: string;
  changedFiles: number;
  /** Its status could not be read; changes may remain. */
  unreadable?: boolean;
  /** It has initialized submodules, whose local commits go with it. */
  submodules?: boolean;
}

/** Said wherever a worktree is about to be removed. */
export const WORKTREE_IGNORED_FILES_NOTE =
  'worktree 中被 .gitignore 忽略的文件（如 .env、构建产物）不计入改动，删除后无法恢复。';

/**
 * Session worktrees that could lose work behind a refused session delete,
 * workspace delete or rebuild; null when that was not the reason.
 */
export function dirtyWorktreesFromError(
  err: unknown,
): WorktreeDirtyInfo[] | null {
  const error = err as Partial<ApiError> | null;
  const dirty = error?.body?.dirty_worktrees;
  if (
    error?.status !== 409 ||
    error.body?.code !== 'WORKTREE_DIRTY' ||
    !Array.isArray(dirty)
  ) {
    return null;
  }
  return dirty.map(
    (item: {
      branch?: unknown;
      changed_files?: unknown;
      unreadable?: unknown;
      submodules?: unknown;
    }) => ({
      branch: String(item.branch ?? ''),
      changedFiles: Number(item.changed_files ?? 0),
      ...(item.unreadable === true ? { unreadable: true } : {}),
      ...(item.submodules === true ? { submodules: true } : {}),
    }),
  );
}

/**
 * Ask whether to discard what the worktrees would lose; the caller retries
 * with the force flag when this resolves true.
 */
export function confirmDiscardWorktreeChanges(
  dirty: WorktreeDirtyInfo[],
  confirmText: string,
): Promise<boolean> {
  const files = dirty.reduce((sum, item) => sum + item.changedFiles, 0);
  const branches = dirty.map((item) => item.branch).join('、');
  const owner = dirty.length === 1 ? '会话' : `${dirty.length} 个会话`;
  const risks = [
    ...(files > 0 ? [`还有 ${files} 个未提交的改动`] : []),
    ...(dirty.some((item) => item.unreadable)
      ? ['状态无法读取，可能仍有未提交的改动']
      : []),
    ...(dirty.some((item) => item.submodules)
      ? ['有已初始化的子模块，子模块中的本地提交会随 worktree 一起丢失']
      : []),
  ];
  return confirmDialog({
    title: '丢弃未提交的改动？',
    message: `${owner}的独立 worktree（分支 ${branches}）${risks.join('；')}。继续会移除 worktree 目录；分支本身会保留，已提交到分支的内容不受影响。${WORKTREE_IGNORED_FILES_NOTE}`,
    confirmText,
    variant: 'danger',
  });
}
