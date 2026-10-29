import type { ApiError } from '../api/client';
import { confirmDialog } from '../stores/confirm';
import type { WorktreeIncludeIncomplete } from '../types';

/** What removing a session's worktree would lose (409 WORKTREE_DIRTY). */
export interface WorktreeDirtyInfo {
  branch: string;
  changedFiles: number;
  /** Its status could not be read; changes may remain. */
  unreadable?: boolean;
  /** It has initialized submodules, whose local commits go with it. */
  submodules?: boolean;
  /** It holds an embedded git repository whose commits go with it. */
  embeddedRepos?: boolean;
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
      embedded_repos?: unknown;
    }) => ({
      branch: String(item.branch ?? ''),
      changedFiles: Number(item.changed_files ?? 0),
      ...(item.unreadable === true ? { unreadable: true } : {}),
      ...(item.submodules === true ? { submodules: true } : {}),
      ...(item.embedded_repos === true ? { embeddedRepos: true } : {}),
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
    ...(dirty.some((item) => item.embeddedRepos)
      ? ['包含嵌入的 git 仓库，删除会一并删除其中的提交和改动']
      : []),
  ];
  return confirmDialog({
    title: '丢弃未提交的改动？',
    message: `${owner}的独立 worktree（分支 ${branches}）${risks.join('；')}。继续会移除 worktree 目录；分支本身会保留，已提交到分支的内容不受影响。${WORKTREE_IGNORED_FILES_NOTE}`,
    confirmText,
    variant: 'danger',
  });
}

/**
 * What a new worktree is missing from `.worktreeinclude` and why, for the
 * notice shown after the session is created.
 */
export function describeIncludeIncomplete(
  incomplete: WorktreeIncludeIncomplete,
): string {
  const why = {
    include_file_too_large:
      '.worktreeinclude 文件超过 64 KB，未读取，没有复制任何文件',
    list_truncated: '匹配的文件列表超过 256 KB，没有复制任何文件',
    file_limit: `匹配的文件超过 100 个，只复制了 ${incomplete.copied_files} 个`,
    size_limit: `有文件超过 10 MB 或合计超过 50 MB，这些文件没有复制（已复制 ${incomplete.copied_files} 个）`,
  }[incomplete.reason];
  const skipped = incomplete.skipped_files.length
    ? `未复制的文件包括：${incomplete.skipped_files.join('、')}。`
    : '';
  return `${why}。${skipped}需要时请从主仓库手动复制到 worktree。`;
}
