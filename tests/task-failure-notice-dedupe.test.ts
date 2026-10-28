import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-failure-notice-'));
fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  DATA_DIR: tmpDir,
  STORE_DIR: path.join(tmpDir, 'db'),
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { runContainerAgentMock, runScriptMock } = vi.hoisted(() => ({
  runContainerAgentMock: vi.fn(),
  runScriptMock: vi.fn(),
}));
vi.mock('../src/container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/container-runner.js')>()),
  runContainerAgent: runContainerAgentMock,
}));
vi.mock('../src/script-runner.js', () => ({ runScript: runScriptMock }));

const db = await import('../src/db.js');
const {
  enqueueIsolatedScheduledTask,
  notifyTaskSchedulerChanged,
  startSchedulerLoop,
  stopSchedulerLoop,
} = await import('../src/task-scheduler.js');
const { decideTaskRunNotice, normalizeTaskFailureError } =
  await import('../src/task-failure-notice.js');

const GROUP_JID = 'web:failure-notice';
const GROUP_FOLDER = 'failure-notice';
const OWNER = 'failure-notice-owner';

function makeDeps() {
  let runPromise: Promise<void> | null = null;
  const deps = {
    registeredGroups: () => ({
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    }),
    getSessions: () => ({}),
    queue: {
      enqueueTask: vi.fn(
        (_jid: string, _id: string, fn: () => Promise<void>) => {
          runPromise = fn();
          return true;
        },
      ),
      closeStdin: vi.fn(),
      enqueueMessageCheck: vi.fn(),
      isShuttingDown: () => false,
      isGroupMutationPaused: () => false,
    },
    onProcess: vi.fn(),
    sendMessage: vi.fn(async () => undefined),
    storePromptMessage: vi.fn(),
    storeResultAndNotify: vi.fn(async () => undefined),
    assistantName: 'HappyClaw',
  } as any;
  return { deps, wait: () => runPromise };
}

function createDueTask(
  id: string,
  overrides: Partial<Parameters<typeof db.createTask>[0]> = {},
): string {
  db.createTask({
    id,
    group_folder: GROUP_FOLDER,
    chat_jid: GROUP_JID,
    prompt: `report for ${id}`,
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    script_command: null,
    next_run: new Date(Date.now() - 60_000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
    notify_channels: null,
    created_by: OWNER,
    ...overrides,
  });
  return id;
}

async function runDue(taskId: string, deps: any, wait: () => unknown) {
  db.updateTask(taskId, {
    next_run: new Date(Date.now() - 60_000).toISOString(),
  });
  expect(enqueueIsolatedScheduledTask(db.getTaskById(taskId)!, deps)).toBe(
    true,
  );
  await wait();
}

/** The owner-notifying calls: a notification reaches IM only with ownerId. */
function ownerNotices(deps: any): string[] {
  return deps.storeResultAndNotify.mock.calls
    .filter((call: any[]) => call[2]?.ownerId === OWNER)
    .map((call: any[]) => String(call[1]));
}

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: OWNER,
    username: OWNER,
    password_hash: 'hash',
    display_name: OWNER,
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
});

beforeEach(() => {
  runContainerAgentMock.mockReset();
  runScriptMock.mockReset();
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Failure Notice Workspace',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    is_home: false,
    created_by: OWNER,
  } as any);
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scheduled task failure notice de-duplication', () => {
  test('normalizes run-specific numbers and ids out of the error', () => {
    expect(normalizeTaskFailureError('脚本执行超时 (12s)')).toBe(
      normalizeTaskFailureError('脚本执行超时 (300s)'),
    );
    expect(
      normalizeTaskFailureError(
        'request 0b5e2c1a-1111-4222-8333-444455556666 failed',
      ),
    ).toBe(
      normalizeTaskFailureError(
        'request 9f9e2c1a-1111-4222-8333-444455556666 failed',
      ),
    );
    expect(normalizeTaskFailureError('connection refused')).not.toBe(
      normalizeTaskFailureError('permission denied'),
    );
  });

  test('notifies once per streak, again on a new error, and once on recovery', () => {
    const id = 'decision-task';
    expect(decideTaskRunNotice({ taskId: id, error: 'boom after 3s' })).toEqual(
      { kind: 'notify_failure' },
    );
    expect(decideTaskRunNotice({ taskId: id, error: 'boom after 9s' })).toEqual(
      { kind: 'suppress_failure', failureCount: 2 },
    );
    // Someone who pressed Run Now always gets the answer.
    expect(
      decideTaskRunNotice({
        taskId: id,
        error: 'boom after 1s',
        manualRun: true,
      }),
    ).toEqual({ kind: 'notify_failure' });
    expect(decideTaskRunNotice({ taskId: id, error: 'disk full' })).toEqual({
      kind: 'notify_failure',
    });
    const recovered = decideTaskRunNotice({ taskId: id, error: null });
    expect(recovered).toMatchObject({
      kind: 'notify_recovery',
      streak: { failureCount: 1, errorText: 'disk full' },
    });
    expect(decideTaskRunNotice({ taskId: id, error: null })).toEqual({
      kind: 'none',
    });
  });

  test('an isolated Agent task that keeps failing notifies the owner once, then announces recovery', async () => {
    const taskId = createDueTask('isolated-flaky');
    const { deps, wait } = makeDeps();
    const fail = (error: string) =>
      runContainerAgentMock.mockImplementationOnce(
        async (_group, input, onProcess) => {
          onProcess?.({} as never, `container-${input.taskRunId}`, null);
          return { status: 'error', result: null, error };
        },
      );

    fail('upstream timeout after 31s');
    await runDue(taskId, deps, wait);
    fail('upstream timeout after 45s');
    await runDue(taskId, deps, wait);
    expect(ownerNotices(deps)).toEqual([
      '执行出错: upstream timeout after 31s',
    ]);
    // The repeat still lands in the task session for audit, without IM.
    expect(deps.storeResultAndNotify).toHaveBeenCalledWith(
      expect.any(String),
      '执行出错: upstream timeout after 45s',
      expect.objectContaining({ ownerId: undefined }),
    );

    runContainerAgentMock.mockImplementationOnce(
      async (_group, input, onProcess) => {
        onProcess?.({} as never, `container-${input.taskRunId}`, null);
        return {
          status: 'success',
          result: 'all good',
          inputTurnCompleted: true,
        };
      },
    );
    await runDue(taskId, deps, wait);
    const notices = ownerNotices(deps);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain(
      '✅ 定时任务已恢复：report for isolated-flaky',
    );
    expect(notices[1]).toContain('此前连续失败 2 次');

    // A healthy run after the recovery stays quiet.
    runContainerAgentMock.mockImplementationOnce(
      async (_group, input, onProcess) => {
        onProcess?.({} as never, `container-${input.taskRunId}`, null);
        return {
          status: 'success',
          result: 'still good',
          inputTurnCompleted: true,
        };
      },
    );
    await runDue(taskId, deps, wait);
    expect(ownerNotices(deps)).toHaveLength(2);
  });

  test('a script failing the same way posts the failure once and the recovery once', async () => {
    // Scripts run only in an administrator's host workspace.
    db.setRegisteredGroup(GROUP_JID, {
      ...db.getRegisteredGroup(GROUP_JID)!,
      executionMode: 'host',
    });
    const taskId = createDueTask('script-flaky', {
      execution_type: 'script',
      execution_mode: 'host',
      script_command: 'check.sh',
      // Only the occurrences created below may run.
      next_run: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const { deps } = makeDeps();
    const scriptResult = (exitCode: number, stderr: string) => ({
      stdout: exitCode === 0 ? 'ok' : '',
      stderr,
      exitCode,
      signal: null,
      timedOut: false,
      aborted: false,
      durationMs: 5,
    });
    runScriptMock
      .mockResolvedValueOnce(scriptResult(1, 'probe 10.0.0.7 unreachable'))
      .mockResolvedValueOnce(scriptResult(1, 'probe 10.0.0.9 unreachable'))
      .mockResolvedValueOnce(scriptResult(0, ''));

    // Scheduled (not manual) occurrences go through the durable executor.
    startSchedulerLoop(deps);
    try {
      for (let index = 0; index < 3; index++) {
        const { run } = db.createTaskRun({
          task: db.getTaskById(taskId)!,
          triggerType: 'scheduled',
          scheduledFor: new Date(Date.now() - 1_000 - index).toISOString(),
        });
        notifyTaskSchedulerChanged();
        await vi.waitFor(
          () => {
            const status = db.getTaskRunById(run.id)?.status;
            expect(['success', 'failed']).toContain(status);
          },
          { timeout: 3_000, interval: 20 },
        );
      }
    } finally {
      await stopSchedulerLoop();
    }

    const posted = deps.sendMessage.mock.calls.map((call: any[]) =>
      String(call[1]),
    );
    expect(posted.filter((text: string) => text.includes('执行失败'))).toEqual([
      'HappyClaw: [脚本] 执行失败: probe 10.0.0.7 unreachable',
    ]);
    expect(
      posted.filter((text: string) => text.includes('已恢复')),
    ).toHaveLength(1);
    expect(posted.at(-2)).toBe('HappyClaw: [脚本] ok');
  });
});
