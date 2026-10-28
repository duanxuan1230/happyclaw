import { describe, expect, it, vi } from 'vitest';

const confirmDialog = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../stores/confirm', () => ({ confirmDialog }));

const { confirmDiscardWorktreeChanges, dirtyWorktreesFromError } =
  await import('./session-worktree');

describe('discarding worktree changes', () => {
  it('names submodule commits, unreadable status and ignored files', async () => {
    const dirty = dirtyWorktreesFromError({
      status: 409,
      message: 'dirty',
      body: {
        code: 'WORKTREE_DIRTY',
        dirty_worktrees: [
          {
            session_id: 's1',
            branch: 'happyclaw/s1',
            changed_files: 0,
            unreadable: true,
            submodules: true,
          },
        ],
      },
    });
    expect(dirty).toEqual([
      {
        branch: 'happyclaw/s1',
        changedFiles: 0,
        unreadable: true,
        submodules: true,
      },
    ]);
    await confirmDiscardWorktreeChanges(dirty!, '丢弃并删除');
    const { message } = (
      confirmDialog.mock.calls.at(-1) as unknown as [{ message: string }]
    )[0];
    expect(message).toContain('子模块中的本地提交会随 worktree 一起丢失');
    expect(message).toContain('状态无法读取');
    expect(message).toContain('被 .gitignore 忽略的文件');
  });
});
