import type { ApiError } from '../api/client';

/** A session's worktree that still holds uncommitted changes (409). */
export interface WorktreeDirtyInfo {
  branch: string;
  changedFiles: number;
}

function conflictBody(err: unknown): Record<string, unknown> | null {
  const error = err as Partial<ApiError> | null;
  if (error?.status !== 409 || error.body?.code !== 'WORKTREE_DIRTY') {
    return null;
  }
  return error.body;
}

/** The dirty worktree behind a refused session delete, if that was why. */
export function worktreeDirtyFromError(err: unknown): WorktreeDirtyInfo | null {
  const worktree = conflictBody(err)?.worktree as
    | { branch?: unknown; changed_files?: unknown }
    | undefined;
  if (!worktree) return null;
  return {
    branch: String(worktree.branch ?? ''),
    changedFiles: Number(worktree.changed_files ?? 0),
  };
}

/**
 * Session worktrees with uncommitted changes behind a refused workspace
 * delete or rebuild.
 */
export function workspaceWorktreesDirtyFromError(
  err: unknown,
): WorktreeDirtyInfo[] | null {
  const dirty = conflictBody(err)?.dirty_worktrees;
  if (!Array.isArray(dirty)) return null;
  return dirty.map((item: { branch?: unknown; changed_files?: unknown }) => ({
    branch: String(item.branch ?? ''),
    changedFiles: Number(item.changed_files ?? 0),
  }));
}

/** Confirmation text naming what discarding the worktrees would lose. */
export function describeDirtyWorktrees(dirty: WorktreeDirtyInfo[]): string {
  const files = dirty.reduce((sum, item) => sum + item.changedFiles, 0);
  const branches = dirty.map((item) => item.branch).join('、');
  return `${dirty.length} 个会话的独立 worktree 中还有 ${files} 个未提交的改动（分支 ${branches}）。继续会移除这些 worktree 目录并丢弃未提交的改动；分支本身会保留，已提交的内容不受影响。`;
}
