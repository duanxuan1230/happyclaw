import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-wait-task-'));
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

const { runContainerAgentMock } = vi.hoisted(() => ({
  runContainerAgentMock: vi.fn(),
}));
vi.mock('../src/container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/container-runner.js')>()),
  runContainerAgent: runContainerAgentMock,
}));

const db = await import('../src/db.js');
const { notifyTaskSchedulerChanged, startSchedulerLoop, stopSchedulerLoop } =
  await import('../src/task-scheduler.js');

const GROUP_JID = 'web:usage-wait-task';
const OWNER = 'usage-wait-owner';
const HOUR = 60 * 60 * 1000;

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
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Usage Wait Workspace',
    folder: 'usage-wait-task',
    added_at: now,
    executionMode: 'container',
    is_home: false,
    created_by: OWNER,
  } as any);
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createWaitTask(id: string): void {
  db.createTask({
    id,
    group_folder: 'usage-wait-task',
    chat_jid: GROUP_JID,
    prompt: `digest for ${id}`,
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    script_command: null,
    next_run: new Date(Date.now() + 24 * HOUR).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
    notify_channels: null,
    created_by: OWNER,
  });
}

/** What the disposition hands back once every connection is walled. */
function waitingOutput(resumeAt: number) {
  return {
    status: 'success',
    result: null,
    providerFailure: true,
    providerFailureClass: 'account',
    providerFailureTerminal: false,
    inputTurnCompleted: false,
    providerUsageLimitResumeAt: resumeAt,
  };
}

function schedulerDeps() {
  return {
    registeredGroups: () => ({
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    }),
    getSessions: () => ({}),
    queue: {
      enqueueTask: (_jid: string, _id: string, fn: () => Promise<void>) => {
        void fn();
        return true;
      },
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
}

/** Run one scheduled occurrence through the durable scheduler loop. */
async function runOccurrence(
  taskId: string,
  deps: ReturnType<typeof schedulerDeps>,
  until: (runId: string) => Promise<void>,
): Promise<string> {
  startSchedulerLoop(deps);
  try {
    const { run } = db.createTaskRun({
      task: db.getTaskById(taskId)!,
      triggerType: 'scheduled',
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
    });
    notifyTaskSchedulerChanged();
    await until(run.id);
    return run.id;
  } finally {
    await stopSchedulerLoop();
  }
}

const reaches = (runId: string, status: string) =>
  vi.waitFor(() => expect(db.getTaskRunById(runId)?.status).toBe(status), {
    timeout: 4_000,
    interval: 10,
  });

describe('a scheduled run out of usage everywhere waits for the reset', () => {
  test('goes back to retry_wait at the resume time, without spending an attempt or notifying', async () => {
    createWaitTask('usage-wait-task');
    const resumeAt = Date.now() + 2 * HOUR;
    runContainerAgentMock.mockReset();
    runContainerAgentMock.mockImplementation(
      async (_group, input, onProcess) => {
        onProcess?.({} as never, `container-${input.taskRunId}`, null);
        return waitingOutput(resumeAt);
      },
    );
    const deps = schedulerDeps();

    const runId = await runOccurrence('usage-wait-task', deps, (id) =>
      reaches(id, 'retry_wait'),
    );

    const run = db.getTaskRunById(runId)!;
    expect(run.available_at).toBe(new Date(resumeAt).toISOString());
    // The wait is not the run's failure: its claim budget is given back.
    expect(run.attempt).toBe(0);
    expect(run.error).toBe('Usage limit reached; waiting for the reset');
    // One attempt: no other connection was tried for a pool that is out.
    expect(runContainerAgentMock).toHaveBeenCalledTimes(1);
    expect(deps.storeResultAndNotify).not.toHaveBeenCalled();
    // The pause leaves no log line: the run has not ended.
    expect(db.getTaskRunLogs('usage-wait-task', 10)).toEqual([]);
  });

  test('after the reset the resumed attempt writes the only log line, as a success', async () => {
    createWaitTask('usage-wait-resume');
    runContainerAgentMock.mockReset();
    runContainerAgentMock
      .mockImplementationOnce(async (_group, input, onProcess) => {
        onProcess?.({} as never, `container-${input.taskRunId}`, null);
        // A reset just ahead, so the scheduler claims the run again.
        return waitingOutput(Date.now() + 300);
      })
      .mockImplementationOnce(async (_group, input, onProcess) => {
        onProcess?.({} as never, `container-${input.taskRunId}`, null);
        return {
          status: 'success',
          result: 'digest ready',
          inputTurnCompleted: true,
        };
      });

    await runOccurrence('usage-wait-resume', schedulerDeps(), async (id) => {
      await reaches(id, 'retry_wait');
      expect(db.getTaskRunLogs('usage-wait-resume', 10)).toEqual([]);
      await reaches(id, 'success');
    });

    expect(runContainerAgentMock).toHaveBeenCalledTimes(2);
    const logs = db.getTaskRunLogs('usage-wait-resume', 10);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      status: 'success',
      result: 'digest ready',
      error: null,
    });
  });
});
