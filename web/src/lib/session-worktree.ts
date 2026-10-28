import type { ApiError } from '../api/client';
import { confirmDialog } from '../stores/confirm';

/** A session's worktree that still holds uncommitted changes (409). */
export interface WorktreeDirtyInfo {
  branch: string;
  changedFiles: number;
}

/**
 * Session worktrees with uncommitted changes behind a refused session
 * delete, workspace delete or rebuild; null when that was not the reason.
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
  return dirty.map((item: { branch?: unknown; changed_files?: unknown }) => ({
    branch: String(item.branch ?? ''),
    changedFiles: Number(item.changed_files ?? 0),
  }));
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
  return confirmDialog({
    title: '丢弃未提交的改动？',
    message: `${owner}的独立 worktree 中还有 ${files} 个未提交的改动（分支 ${branches}）。继续会移除 worktree 目录并丢弃这些改动；分支本身会保留，已提交的内容不受影响。`,
    confirmText,
    variant: 'danger',
  });
}
