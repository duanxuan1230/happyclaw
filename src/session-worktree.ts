/**
 * Session-level git worktrees and the workspace "project root" every
 * consumer shares.
 *
 * A Runtime Session in a Host workspace whose directory is a git repository
 * can own a worktree: HappyClaw adds it under data/worktrees/<folder>/<id> on
 * a new `happyclaw/<short id>` branch and runs that session there, so
 * parallel sessions stop overwriting each other's files. The host creates
 * and removes worktrees; the Agent never gets EnterWorktree (the CLI is
 * closed after every turn, so a CLI-owned worktree would silently vanish).
 *
 * Invariants: branches are never deleted, the main checkout's files are never
 * touched, a missing or damaged worktree fails the run instead of falling
 * back to the main checkout, and nothing is removed outside data/worktrees.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import {
  GitCommandError,
  locateGitRepo,
  resolveHeadCommit,
  runGit,
} from './git-review.js';
import { logger } from './logger.js';
import {
  deleteSessionWorktreeRecord,
  getSessionWorktree,
  insertSessionWorktree,
  listAllSessionWorktrees,
  markSessionWorktreeBroken,
  type SessionWorktree,
} from './session-worktree-store.js';
import type { RegisteredGroup } from './types.js';

export const WORKTREES_DIR = path.join(DATA_DIR, 'worktrees');

const BRANCH_PREFIX = 'happyclaw/';

type WorkspaceLike = Pick<
  RegisteredGroup,
  'folder' | 'executionMode' | 'customCwd'
>;

function isHostWorkspace(group: WorkspaceLike): boolean {
  return (group.executionMode || 'container') === 'host';
}

/**
 * The directory a run of this workspace (or of one of its sessions) works in,
 * which is also its Claude project context root (`.claude/skills`, MCP) and
 * the file panel root: the session's worktree when it has one, a Host
 * workspace's custom directory, otherwise data/groups/<folder>.
 *
 * A broken worktree still resolves to its own path so callers report the
 * missing directory instead of quietly switching to the main checkout.
 */
export function resolveWorkspaceProjectRoot(
  group: WorkspaceLike,
  options: { agentId?: string | null } = {},
): string {
  const worktree = getSessionWorktree(options.agentId);
  if (worktree) return path.join(worktree.worktree_path, worktree.cwd_subpath);
  if (isHostWorkspace(group) && group.customCwd) return group.customCwd;
  return path.join(GROUPS_DIR, group.folder);
}

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function hasGitEntry(dir: string): boolean {
  try {
    fs.lstatSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The `.claude/skills` directories Claude Code discovers natively from `cwd`
 * (settingSources includes 'project'), lowest precedence first: it walks up
 * to the git root (inclusive) and stops before the home directory. A linked
 * worktree whose root has no `.claude/skills` also reads the main
 * checkout's, as the CLI does. `cwd`'s own directory is always last, even
 * before it exists, so callers can show where workspace Skills belong.
 *
 * HappyClaw hands the CLI an exact Skill name list, so the resolver must scan
 * these same directories: a native project Skill missing from the list is
 * hidden, while one that is also linked into the session config dir is the
 * same file twice, which the CLI loads once.
 */
export function projectSkillRoots(
  cwd: string,
  options: { mainRepoRoot?: string } = {},
): string[] {
  const home = realpathOrSelf(os.homedir());
  const start = realpathOrSelf(cwd);
  const own = path.join(start, '.claude', 'skills');
  const nearestFirst: string[] = [];
  let gitRoot: string | null = null;
  for (let dir = start; dir !== home; ) {
    const root = path.join(dir, '.claude', 'skills');
    if (root === own || fs.existsSync(root)) nearestFirst.push(root);
    if (hasGitEntry(dir)) {
      gitRoot = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (options.mainRepoRoot && gitRoot) {
    const gitRootSkills = path.join(gitRoot, '.claude', 'skills');
    const mainSkills = path.join(
      realpathOrSelf(options.mainRepoRoot),
      '.claude',
      'skills',
    );
    if (
      mainSkills !== gitRootSkills &&
      !fs.existsSync(gitRootSkills) &&
      fs.existsSync(mainSkills)
    ) {
      nearestFirst.push(mainSkills);
    }
  }
  return nearestFirst.reverse();
}

/**
 * Project Skill roots for a run or a capability preview, lowest precedence
 * first. data/groups/<folder> is its own git root (the host initializes it
 * before every run) and is all a container sees at /workspace/group, so it
 * keeps a single root; a custom directory or worktree mirrors the CLI walk.
 */
export function resolveWorkspaceSkillRoots(
  group: WorkspaceLike,
  options: { agentId?: string | null } = {},
): string[] {
  const root = resolveWorkspaceProjectRoot(group, options);
  const worktree = getSessionWorktree(options.agentId);
  if (!isHostWorkspace(group) || (!group.customCwd && !worktree)) {
    return [path.join(root, '.claude', 'skills')];
  }
  return projectSkillRoots(root, { mainRepoRoot: worktree?.repo_path });
}

export type WorktreeUnavailableReason =
  | 'container_mode'
  | 'directory_missing'
  | 'not_git_repo'
  | 'repo_has_no_commits';

export const WORKTREE_UNAVAILABLE_MESSAGES: Record<
  WorktreeUnavailableReason,
  string
> = {
  container_mode: '独立 worktree 目前只支持宿主机模式的工作区',
  directory_missing: '工作目录不存在或无法访问',
  not_git_repo: '工作目录不是 git 仓库',
  repo_has_no_commits: 'git 仓库还没有任何提交，无法创建 worktree',
};

export type WorktreeSupport =
  | {
      available: true;
      repoRoot: string;
      subpath: string;
      baseCommit: string;
    }
  | { available: false; reason: WorktreeUnavailableReason };

export async function getWorktreeSupport(
  group: WorkspaceLike,
): Promise<WorktreeSupport> {
  if (!isHostWorkspace(group)) {
    return { available: false, reason: 'container_mode' };
  }
  const dir = resolveWorkspaceProjectRoot(group);
  if (!fs.existsSync(dir)) {
    return { available: false, reason: 'directory_missing' };
  }
  // data/groups/<folder> sits inside the HappyClaw checkout; only its own
  // repository (the one the host initializes there) counts.
  const repo = await locateGitRepo(dir, { requireTopLevel: !group.customCwd });
  if (!repo) return { available: false, reason: 'not_git_repo' };
  const baseCommit = await resolveHeadCommit(repo.topLevel);
  if (!baseCommit) return { available: false, reason: 'repo_has_no_commits' };
  return {
    available: true,
    repoRoot: repo.topLevel,
    subpath: repo.subpath,
    baseCommit,
  };
}

export class WorktreeUnavailableError extends Error {
  constructor(readonly reason: WorktreeUnavailableReason) {
    super(WORKTREE_UNAVAILABLE_MESSAGES[reason]);
    this.name = 'WorktreeUnavailableError';
  }
}

function worktreePathFor(folder: string, agentId: string): string {
  return path.join(WORKTREES_DIR, folder, agentId);
}

/**
 * True only for a path strictly below data/worktrees whose real location is
 * also below it, so a removal can never reach a directory outside.
 */
export function isManagedWorktreePath(target: string): boolean {
  const root = path.resolve(WORKTREES_DIR);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) return false;
  } catch {
    return true; // nothing on disk to escape through
  }
  const realRelative = path.relative(
    realpathOrSelf(root),
    realpathOrSelf(resolved),
  );
  return (
    !!realRelative &&
    !realRelative.startsWith('..') &&
    !path.isAbsolute(realRelative)
  );
}

async function branchExists(
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  try {
    await runGit(
      repoRoot,
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { maxBytes: 1024 },
    );
    return true;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return false;
    throw error;
  }
}

async function pickBranchName(
  repoRoot: string,
  agentId: string,
): Promise<string> {
  const compact = agentId.replace(/[^a-zA-Z0-9]/g, '');
  for (const length of [8, 12, compact.length]) {
    const candidate = `${BRANCH_PREFIX}${compact.slice(0, length)}`;
    if (!(await branchExists(repoRoot, candidate))) return candidate;
  }
  throw new Error(`branch ${BRANCH_PREFIX}${compact} already exists`);
}

/**
 * Add a worktree for a new session on a fresh branch at the repository's
 * current HEAD and record it. Throws WorktreeUnavailableError when the
 * workspace cannot have one.
 */
export async function createSessionWorktree(input: {
  group: WorkspaceLike;
  chatJid: string;
  agentId: string;
}): Promise<SessionWorktree> {
  const support = await getWorktreeSupport(input.group);
  if (!support.available) throw new WorktreeUnavailableError(support.reason);
  const worktreePath = worktreePathFor(input.group.folder, input.agentId);
  if (!isManagedWorktreePath(worktreePath) || fs.existsSync(worktreePath)) {
    throw new Error(`worktree path is not available: ${worktreePath}`);
  }
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const branch = await pickBranchName(support.repoRoot, input.agentId);
  await runGit(
    support.repoRoot,
    ['worktree', 'add', '-b', branch, worktreePath, support.baseCommit],
    { timeoutMs: 120_000, maxBytes: 256 * 1024 },
  );
  try {
    return insertSessionWorktree({
      agent_id: input.agentId,
      group_folder: input.group.folder,
      chat_jid: input.chatJid,
      repo_path: support.repoRoot,
      cwd_subpath: support.subpath,
      worktree_path: worktreePath,
      branch,
      base_commit: support.baseCommit,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    await detachWorktreeDirectory(support.repoRoot, worktreePath);
    throw error;
  }
}

/** Why a recorded worktree cannot be used, or null when it looks intact. */
export function inspectSessionWorktree(record: SessionWorktree): string | null {
  try {
    if (!fs.statSync(record.worktree_path).isDirectory()) {
      return 'worktree path is not a directory';
    }
  } catch {
    return 'worktree directory is missing';
  }
  if (!hasGitEntry(record.worktree_path)) {
    return 'worktree has no .git entry';
  }
  const cwd = path.join(record.worktree_path, record.cwd_subpath);
  if (record.cwd_subpath && !fs.existsSync(cwd)) {
    return `worktree has no ${record.cwd_subpath} directory`;
  }
  return null;
}

export type SessionWorkingDirectory =
  | { kind: 'none' }
  | { kind: 'worktree'; cwd: string; worktree: SessionWorktree }
  | { kind: 'broken'; worktree: SessionWorktree; reason: string };

/**
 * The run directory for a session that owns a worktree. A missing or damaged
 * checkout is recorded as broken and reported; callers must fail the run
 * rather than use the workspace directory.
 */
export function resolveSessionWorkingDirectory(
  agentId: string | null | undefined,
): SessionWorkingDirectory {
  const worktree = getSessionWorktree(agentId);
  if (!worktree) return { kind: 'none' };
  const reason =
    worktree.status === 'broken'
      ? (worktree.broken_reason ?? 'worktree is marked broken')
      : inspectSessionWorktree(worktree);
  if (reason) {
    if (worktree.status !== 'broken') {
      markSessionWorktreeBroken(worktree.agent_id, reason);
    }
    return { kind: 'broken', worktree, reason };
  }
  return {
    kind: 'worktree',
    cwd: path.join(worktree.worktree_path, worktree.cwd_subpath),
    worktree,
  };
}

export function sessionWorktreeRunError(
  worktree: SessionWorktree,
  reason: string,
): string {
  return `会话的独立 worktree 不可用（${reason}）：${worktree.worktree_path}，分支 ${worktree.branch}。为避免改动落到主仓库，本次运行已停止；请删除该会话后重新创建。`;
}

/** Uncommitted changes (including untracked files) in a worktree. */
export async function countWorktreeChanges(
  worktreePath: string,
): Promise<number> {
  const result = await runGit(
    worktreePath,
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    { maxBytes: 2 * 1024 * 1024 },
  );
  // Renames carry their source as an extra NUL field; count entries only.
  let count = 0;
  const records = result.stdout.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    count++;
    if (record[0] === 'R' || record[0] === 'C') i++;
  }
  return count;
}

async function detachWorktreeDirectory(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  if (!isManagedWorktreePath(worktreePath)) {
    throw new Error(`refusing to remove unmanaged path: ${worktreePath}`);
  }
  try {
    await runGit(repoRoot, ['worktree', 'remove', '--force', worktreePath], {
      timeoutMs: 60_000,
      maxBytes: 64 * 1024,
    });
  } catch (error) {
    // The repository may be gone or no longer know this worktree. Removing
    // the directory below data/worktrees is still safe; prune is best effort.
    logger.warn(
      { err: error, worktreePath },
      'git worktree remove failed; removing the directory directly',
    );
  }
  if (fs.existsSync(worktreePath)) {
    if (!isManagedWorktreePath(worktreePath)) {
      throw new Error(`refusing to remove unmanaged path: ${worktreePath}`);
    }
    fs.rmSync(worktreePath, { recursive: true, force: true });
    try {
      await runGit(repoRoot, ['worktree', 'prune'], { maxBytes: 64 * 1024 });
    } catch {
      /* repository unavailable; nothing left to prune */
    }
  }
}

export type RemoveSessionWorktreeResult =
  | { removed: true; branch: string }
  | { removed: false; dirtyFiles: number; branch: string };

/**
 * Remove a session's worktree directory and record. The branch stays. With
 * uncommitted changes the worktree is kept and the change count returned,
 * unless `force` confirms discarding them.
 */
export async function removeSessionWorktree(
  agentId: string,
  options: { force?: boolean } = {},
): Promise<RemoveSessionWorktreeResult | null> {
  const worktree = getSessionWorktree(agentId);
  if (!worktree) return null;
  if (!options.force && inspectSessionWorktree(worktree) === null) {
    const dirtyFiles = await countWorktreeChanges(worktree.worktree_path);
    if (dirtyFiles > 0) {
      return { removed: false, dirtyFiles, branch: worktree.branch };
    }
  }
  await detachWorktreeDirectory(worktree.repo_path, worktree.worktree_path);
  deleteSessionWorktreeRecord(agentId);
  logger.info(
    { agentId, worktreePath: worktree.worktree_path, branch: worktree.branch },
    'Session worktree removed; branch kept',
  );
  return { removed: true, branch: worktree.branch };
}

/**
 * Sessions of `records` whose worktrees hold uncommitted changes. Damaged
 * worktrees have nothing to lose and are skipped.
 */
export async function findDirtySessionWorktrees(
  records: SessionWorktree[],
): Promise<Array<{ agentId: string; branch: string; dirtyFiles: number }>> {
  const dirty: Array<{ agentId: string; branch: string; dirtyFiles: number }> =
    [];
  for (const record of records) {
    if (inspectSessionWorktree(record) !== null) continue;
    const dirtyFiles = await countWorktreeChanges(record.worktree_path);
    if (dirtyFiles > 0) {
      dirty.push({
        agentId: record.agent_id,
        branch: record.branch,
        dirtyFiles,
      });
    }
  }
  return dirty;
}

/**
 * Startup reconciliation: mark recorded worktrees whose directory is gone or
 * damaged as broken, so their sessions fail clearly instead of running
 * somewhere else.
 */
export function reconcileSessionWorktrees(): { broken: number } {
  let broken = 0;
  for (const record of listAllSessionWorktrees()) {
    if (record.status === 'broken') continue;
    const reason = inspectSessionWorktree(record);
    if (!reason) continue;
    markSessionWorktreeBroken(record.agent_id, reason);
    broken++;
  }
  if (broken > 0) {
    logger.warn({ broken }, 'Marked missing session worktrees as broken');
  }
  return { broken };
}

/** Public shape of a session's worktree in API responses. */
export function toSessionWorktreePayload(record: SessionWorktree | undefined): {
  branch: string;
  base_commit: string;
  status: SessionWorktree['status'];
  broken_reason: string | null;
} | null {
  if (!record) return null;
  return {
    branch: record.branch,
    base_commit: record.base_commit,
    status: record.status,
    broken_reason: record.broken_reason,
  };
}
