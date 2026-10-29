/**
 * Removing a session worktree never silently loses work: a damaged checkout
 * is still checked for changes, a status git cannot read counts as at risk,
 * initialized submodules (whose local commits live in the worktree's admin
 * dir) need confirmation, and a broken worktree that is back becomes active.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-removal-'));
const dataDir = path.join(root, 'data');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/session-worktree-store.js');
const worktrees = await import('../src/session-worktree.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

let seq = 0;
function makeRepo(files: Record<string, string>): string {
  const dir = path.join(root, `repo-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return fs.realpathSync(dir);
}

async function worktreeFor(
  repo: string,
  customCwd = repo,
  folder = `ws-${seq + 1}`,
) {
  const id = `${String(++seq).padStart(8, '0')}-0000-0000-0000-000000000000`;
  return worktrees.createSessionWorktree({
    group: { folder, executionMode: 'host', customCwd },
    chatJid: `web:${folder}`,
    agentId: id,
  });
}

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a damaged worktree is still checked before removal', () => {
  test('a moved workspace subdirectory keeps its uncommitted changes', async () => {
    const repo = makeRepo({ 'packages/app/index.ts': 'export {};\n' });
    const record = await worktreeFor(repo, path.join(repo, 'packages', 'app'));
    git(record.worktree_path, 'mv', 'packages/app', 'packages/renamed');
    fs.writeFileSync(
      path.join(record.worktree_path, 'packages', 'renamed', 'wip.ts'),
      'wip\n',
    );
    expect(worktrees.resolveSessionWorkingDirectory(record.agent_id).kind).toBe(
      'broken',
    );

    const refused = await worktrees.removeSessionWorktree(record.agent_id);
    expect(refused).toMatchObject({
      removed: false,
      risk: { unreadable: false, submodules: false },
    });
    expect(
      refused && !refused.removed ? refused.risk.dirtyFiles : 0,
    ).toBeGreaterThan(0);
    expect(fs.existsSync(record.worktree_path)).toBe(true);
    await expect(
      worktrees.findDirtySessionWorktrees([
        store.getSessionWorktree(record.agent_id)!,
      ]),
    ).resolves.toHaveLength(1);

    await expect(
      worktrees.removeSessionWorktree(record.agent_id, { force: true }),
    ).resolves.toMatchObject({ removed: true });
  });

  test('a worktree without its .git file counts as unreadable, not clean', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n' });
    const record = await worktreeFor(repo);
    fs.writeFileSync(path.join(record.worktree_path, 'a.txt'), 'changed\n');
    fs.rmSync(path.join(record.worktree_path, '.git'));

    await expect(
      worktrees.removeSessionWorktree(record.agent_id),
    ).resolves.toMatchObject({
      removed: false,
      risk: { unreadable: true, dirtyFiles: 0 },
    });
    expect(
      fs.readFileSync(path.join(record.worktree_path, 'a.txt'), 'utf8'),
    ).toBe('changed\n');
    expect(
      worktrees.dirtyWorktreesConflict([
        {
          agentId: record.agent_id,
          branch: record.branch,
          dirtyFiles: 0,
          unreadable: true,
          submodules: false,
        },
      ]),
    ).toMatchObject({
      code: 'WORKTREE_DIRTY',
      error: expect.stringContaining('无法读取状态'),
      dirty_worktrees: [{ unreadable: true }],
    });
  });

  test('a vanished directory has nothing left to lose', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n' });
    const record = await worktreeFor(repo);
    fs.rmSync(record.worktree_path, { recursive: true, force: true });
    await expect(
      worktrees.removeSessionWorktree(record.agent_id),
    ).resolves.toMatchObject({ removed: true });
  });
});

describe('initialized submodules need confirmation', () => {
  test('a clean worktree with a submodule is not removed without force', async () => {
    const sub = makeRepo({ 'lib.txt': 'lib\n' });
    const repo = makeRepo({ 'a.txt': 'a\n' });
    git(repo, 'submodule', 'add', '-q', sub, 'vendor/sub');
    git(repo, 'commit', '-qm', 'add submodule');
    const record = await worktreeFor(repo);
    git(record.worktree_path, 'submodule', 'update', '--init', '-q');
    // A local commit that exists only in the worktree's submodule store.
    const submoduleDir = path.join(record.worktree_path, 'vendor', 'sub');
    fs.writeFileSync(path.join(submoduleDir, 'local.txt'), 'local\n');
    git(submoduleDir, 'add', '.');
    git(submoduleDir, 'commit', '-qm', 'local only');
    git(record.worktree_path, 'add', 'vendor/sub');
    git(record.worktree_path, 'commit', '-qm', 'bump submodule');
    await expect(
      worktrees.countWorktreeChanges(record.worktree_path),
    ).resolves.toBe(0);

    const refused = await worktrees.removeSessionWorktree(record.agent_id);
    expect(refused).toMatchObject({
      removed: false,
      // Its .git is a file into the admin dir, not an embedded repository.
      risk: { dirtyFiles: 0, submodules: true, embeddedRepos: false },
    });
    expect(fs.existsSync(submoduleDir)).toBe(true);
    expect(
      worktrees.dirtyWorktreesConflict(
        refused && !refused.removed ? [refused.risk] : [],
      ).error,
    ).toContain('子模块');
  });
});

describe('a broken worktree that is back becomes active', () => {
  test('on the next run and at startup', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n' });
    const record = await worktreeFor(repo);
    const aside = `${record.worktree_path}-aside`;

    fs.renameSync(record.worktree_path, aside);
    expect(worktrees.resolveSessionWorkingDirectory(record.agent_id).kind).toBe(
      'broken',
    );
    expect(store.getSessionWorktree(record.agent_id)?.status).toBe('broken');

    fs.renameSync(aside, record.worktree_path);
    expect(
      worktrees.resolveSessionWorkingDirectory(record.agent_id),
    ).toMatchObject({ kind: 'worktree', cwd: record.worktree_path });
    expect(store.getSessionWorktree(record.agent_id)).toMatchObject({
      status: 'active',
      broken_reason: null,
    });

    fs.renameSync(record.worktree_path, aside);
    worktrees.reconcileSessionWorktrees();
    expect(store.getSessionWorktree(record.agent_id)?.status).toBe('broken');
    fs.renameSync(aside, record.worktree_path);
    worktrees.reconcileSessionWorktrees();
    expect(store.getSessionWorktree(record.agent_id)?.status).toBe('active');
  });
});

describe('an embedded repository counts as a change', () => {
  // `git add` of a repository inside the checkout records only a gitlink;
  // the nested repository's history lives in its own .git inside the
  // worktree and goes with it.
  function embeddedRepo(worktreePath: string): string {
    const nested = path.join(worktreePath, 'nested');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(nested, 'n.txt'), 'n\n');
    git(nested, 'add', '.');
    git(nested, 'commit', '-qm', 'nested');
    return nested;
  }

  async function expectRefused(agentId: string) {
    await expect(
      worktrees.removeSessionWorktree(agentId),
    ).resolves.toMatchObject({
      removed: false,
      risk: { dirtyFiles: 1, unreadable: false },
    });
    expect(
      fs.existsSync(store.getSessionWorktree(agentId)!.worktree_path),
    ).toBe(true);
  }

  test('untracked, staged, and moved to a new commit', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n' });
    const record = await worktreeFor(repo);
    const nested = embeddedRepo(record.worktree_path);
    await expectRefused(record.agent_id);

    git(record.worktree_path, 'add', 'nested');
    expect(git(record.worktree_path, 'status', '--porcelain')).toBe(
      'A  nested',
    );
    await expectRefused(record.agent_id);

    // Committed, then the nested repository moves on: an unstaged gitlink.
    git(record.worktree_path, 'commit', '-qm', 'embed');
    await expect(
      worktrees.countWorktreeChanges(record.worktree_path),
    ).resolves.toBe(0);
    git(nested, 'commit', '-q', '--allow-empty', '-m', 'local only');
    await expectRefused(record.agent_id);

    await expect(
      worktrees.removeSessionWorktree(record.agent_id, { force: true }),
    ).resolves.toMatchObject({ removed: true });
  });

  test('a committed, unchanged gitlink still holds the nested history and work', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n' });
    const record = await worktreeFor(repo);
    const nested = embeddedRepo(record.worktree_path);
    git(record.worktree_path, 'add', 'nested');
    git(record.worktree_path, 'commit', '-qm', 'embed');
    await expect(
      worktrees.countWorktreeChanges(record.worktree_path),
    ).resolves.toBe(0);
    const embedded = {
      removed: false,
      risk: {
        dirtyFiles: 0,
        unreadable: false,
        submodules: false,
        embeddedRepos: true,
      },
    };

    // Clean, but its commits exist only in nested/.git.
    const refused = await worktrees.removeSessionWorktree(record.agent_id);
    expect(refused).toMatchObject(embedded);
    expect(
      worktrees.dirtyWorktreesConflict(
        refused && !refused.removed ? [refused.risk] : [],
      ),
    ).toMatchObject({
      error: expect.stringContaining(
        '包含嵌入的 git 仓库，删除会一并删除其中的提交和改动',
      ),
      dirty_worktrees: [{ changed_files: 0, embedded_repos: true }],
    });

    // Uncommitted work inside it, under a config that runs a command if git
    // is ever started there: found without running it.
    const marker = path.join(root, `embedded-ran-${seq}`);
    const hook = path.join(root, `embedded-hook-${seq}.sh`);
    fs.writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat\n`);
    fs.chmodSync(hook, 0o755);
    git(nested, 'config', 'core.fsmonitor', hook);
    git(nested, 'config', 'filter.x.clean', hook);
    fs.writeFileSync(path.join(nested, '.gitattributes'), '*.txt filter=x\n');
    fs.writeFileSync(path.join(nested, 'n.txt'), 'm\n');
    await expect(
      worktrees.removeSessionWorktree(record.agent_id),
    ).resolves.toMatchObject(embedded);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(nested, 'n.txt'), 'utf8')).toBe('m\n');
  });
});

describe('data/worktrees keeps no empty folders', () => {
  const worktreesDir = path.join(dataDir, 'worktrees');

  test('the folder goes with the last worktree in it', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n' });
    const first = await worktreeFor(repo);
    const folderDir = path.dirname(first.worktree_path);
    const second = await worktreeFor(repo, repo, first.group_folder);
    expect(path.dirname(second.worktree_path)).toBe(folderDir);

    await worktrees.removeSessionWorktree(first.agent_id);
    expect(fs.readdirSync(folderDir)).toEqual([second.agent_id]);
    await worktrees.removeSessionWorktree(second.agent_id);
    expect(fs.existsSync(folderDir)).toBe(false);
    expect(fs.existsSync(worktreesDir)).toBe(true);
  });

  test('a failed worktree add leaves no folder behind', async () => {
    const repo = makeRepo({
      '.gitattributes': '*.txt filter=fail\n',
      'a.txt': 'a\n',
    });
    git(repo, 'config', 'filter.fail.smudge', 'false');
    git(repo, 'config', 'filter.fail.required', 'true');
    await expect(worktreeFor(repo)).rejects.toMatchObject({
      code: 'GIT_WORKTREE_ADD_FAILED',
    });
    expect(fs.existsSync(path.join(worktreesDir, `ws-${seq}`))).toBe(false);
  });

  test('startup removes empty folders no record lives in, and nothing else', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n' });
    const kept = await worktreeFor(repo);
    // A record whose checkout vanished keeps its (now empty) folder.
    const vanished = await worktreeFor(repo);
    fs.rmSync(vanished.worktree_path, { recursive: true, force: true });
    const stale = path.join(worktreesDir, 'stale-empty');
    fs.mkdirSync(stale, { recursive: true });
    const content = path.join(worktreesDir, 'stale-with-content');
    fs.mkdirSync(path.join(content, 'leftover'), { recursive: true });
    fs.writeFileSync(path.join(content, 'leftover', 'keep.txt'), 'keep\n');
    const nestedEmpty = path.join(worktreesDir, 'stale-nested', 'empty');
    fs.mkdirSync(nestedEmpty, { recursive: true });
    fs.writeFileSync(path.join(worktreesDir, 'stray-file'), 'x\n');

    expect(worktrees.reconcileSessionWorktrees()).toMatchObject({
      emptyFoldersRemoved: 1,
    });
    expect(fs.existsSync(stale)).toBe(false);
    expect(
      fs.readFileSync(path.join(content, 'leftover', 'keep.txt'), 'utf8'),
    ).toBe('keep\n');
    expect(fs.existsSync(nestedEmpty)).toBe(true);
    expect(fs.existsSync(path.join(worktreesDir, 'stray-file'))).toBe(true);
    expect(fs.existsSync(path.dirname(vanished.worktree_path))).toBe(true);
    expect(fs.existsSync(kept.worktree_path)).toBe(true);
    expect(worktrees.reconcileSessionWorktrees().emptyFoldersRemoved).toBe(0);
  });
});
