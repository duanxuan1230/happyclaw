/**
 * Host-side git reads never execute what a repository's config names. A
 * container Agent can write data/groups/<folder>/.git/config, so the fresh
 * window snapshot, the Review panel and the worktree dirty check must not
 * run its fsmonitor, filter drivers, textconv or external diff.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { captureWorkspaceSnapshot } from '../src/fresh-window.js';
import { readGitFileDiff, readGitStatus } from '../src/git-review.js';
import { countWorktreeChanges } from '../src/session-worktree.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-read-hardening-'));
const repo = path.join(root, 'repo');
const markers = path.join(root, 'markers');
const MARKERS = ['fsmonitor', 'clean', 'process', 'textconv', 'extdiff'];

function git(...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd: repo, stdio: 'ignore' },
  );
}

/** A script that leaves `markers/<name>` behind when anything runs it. */
function planted(name: string, body: string): string {
  const script = path.join(root, `${name}.sh`);
  fs.writeFileSync(
    script,
    `#!/bin/sh\ntouch ${JSON.stringify(path.join(markers, name))}\n${body}\n`,
  );
  fs.chmodSync(script, 0o755);
  return script;
}

beforeAll(() => {
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(markers);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(
    path.join(repo, '.gitattributes'),
    '*.txt filter=evil diff=evil\n',
  );
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  git('-c', 'filter.evil.clean=cat', 'add', '.');
  git('commit', '-qm', 'init');

  // What an Agent could plant in the repository's own config.
  git('config', 'core.fsmonitor', planted('fsmonitor', 'exit 0'));
  git('config', 'filter.evil.clean', planted('clean', 'cat'));
  git('config', 'filter.evil.process', planted('process', 'exit 1'));
  git('config', 'diff.evil.textconv', planted('textconv', 'cat "$1"'));
  git('config', 'diff.evil.command', planted('extdiff', 'exit 0'));

  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ran = () =>
  MARKERS.filter((name) => fs.existsSync(path.join(markers, name)));

describe('host git reads with a hostile repository config', () => {
  test('the fresh window snapshot runs nothing the repository configures', async () => {
    const snapshot = await captureWorkspaceSnapshot(repo);
    expect(snapshot).toMatchObject({ available: true, branch: 'main' });
    expect(snapshot.statusLines?.join('\n')).toContain('a.txt');
    expect(ran()).toEqual([]);
  });

  test('the Review panel status and diffs run nothing either', async () => {
    const status = await readGitStatus(repo);
    expect(status.files.map((file) => file.path).sort()).toEqual([
      'a.txt',
      'new.txt',
    ]);
    const tracked = await readGitFileDiff(repo, 'a.txt');
    expect(tracked.diff).toContain('+changed');
    const untracked = await readGitFileDiff(repo, 'new.txt');
    expect(untracked.diff).toContain('+new');
    expect(ran()).toEqual([]);
  });

  test('the worktree dirty check runs nothing either', async () => {
    await expect(countWorktreeChanges(repo)).resolves.toBe(2);
    expect(ran()).toEqual([]);
  });
});
