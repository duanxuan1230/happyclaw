/**
 * Interrupt semantics end to end, minus the SDK: the Host's GroupQueue writes
 * the real sentinel files, the runner's reader consumes them, and the
 * runner's ActiveTurnStopper acts on a real StreamEventProcessor's task state
 * against a fake Query that records interrupt / close (and a stopTask that
 * must stay unused).
 *
 * Every interrupt calls interrupt(), which already ends Claude Code's
 * sub-agents. Only an explicit stop (/break, a stop button, a recall) adds a
 * deadline that closes the query if a sub-agent outlasts it; steer, 「发送」
 * and the runner's own interrupts (usage limit, model switch, model limit,
 * sub-agent provider error, shutdown) never close. Background shells,
 * monitors and MCP tasks never count toward that deadline.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import { StreamEventProcessor } from '../container/agent-runner/src/stream-processor.js';
import {
  ActiveTurnStopper,
  SUB_AGENT_STOP_CLOSE_DELAY_MS,
  consumeInterruptSentinel,
  type InterruptReason,
} from '../container/agent-runner/src/turn-interrupt.js';

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-turn-interrupt-'),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/container-runner.js', () => ({ killProcessTree: vi.fn() }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({ maxConcurrentContainers: 20 }),
}));
vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));

const { GroupQueue } = await import('../src/group-queue.js');
const { isIpcInputPayloadFilename } =
  await import('../src/ipc-delivery-recovery.js');

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let folderSeq = 0;

/** A Host lane whose runner is registered and running query `run-1`. */
function runningLane() {
  const folder = `lane-${++folderSeq}`;
  const jid = `web:${folder}`;
  const queue = new GroupQueue();
  const state = (queue as any).getGroup(jid);
  state.active = true;
  state.process = { pid: 4242 };
  state.groupFolder = folder;
  state.queryInFlight = true;
  state.queryId = 'run-1';
  const inputDir = path.join(dataDir, 'ipc', folder, 'input');
  return { queue, state, jid, folder, inputDir };
}

/** A runner turn with one task of every kind the SDK reports. */
function runnerTurn() {
  const processor = new StreamEventProcessor(
    () => {},
    () => {},
  );
  const start = (taskId: string, taskType: string) =>
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      description: taskId,
      task_type: taskType,
    });
  start('agent-1', 'local_agent');
  start('workflow-1', 'local_workflow');
  start('dev-server', 'local_bash');
  processor.processSystemMessage({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'dev-server',
    patch: { is_backgrounded: true },
  });
  start('log-watch', 'monitor');
  start('mcp-job', 'mcp_task');

  const calls: string[] = [];
  const query = {
    stopTask: vi.fn(async (taskId: string) => {
      calls.push(`stopTask:${taskId}`);
    }),
    interrupt: vi.fn(async () => {
      calls.push('interrupt');
      return { still_queued: [] as string[] };
    }),
    close: vi.fn(() => {
      calls.push('close');
    }),
  };
  let queryFinished = false;
  const stopper = new ActiveTurnStopper({
    activeSubAgentTaskIds: () => processor.getActiveSubAgentTaskIds(),
    isQueryFinished: () => queryFinished,
    log: () => {},
  });
  const stop = (label: string, reason?: InterruptReason, queuedInCli = 0) =>
    stopper.stop(query as any, label, queuedInCli, reason);
  const settle = (taskId: string, status = 'stopped') =>
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      status,
      summary: `${taskId} ${status}`,
    });
  return {
    processor,
    calls,
    query,
    stopper,
    stop,
    settle,
    finishQuery: () => {
      queryFinished = true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Host → runner interrupt reason', () => {
  test('an explicit stop reaches the runner as stop and is consumed with the sentinel', () => {
    const lane = runningLane();
    expect(lane.queue.interruptQuery(lane.jid, 'run-1', 'stop')).toBe(true);

    expect(consumeInterruptSentinel(lane.inputDir)).toEqual({
      queryRunId: 'run-1',
      reason: 'stop',
    });
    expect(fs.readdirSync(lane.inputDir)).toEqual([]);
    expect(consumeInterruptSentinel(lane.inputDir)).toBeNull();
  });

  test('steer and 「发送」 (no reason) reach the runner as steer', () => {
    const lane = runningLane();
    expect(lane.queue.interruptQuery(lane.jid, 'run-1')).toBe(true);
    expect(consumeInterruptSentinel(lane.inputDir)).toEqual({
      queryRunId: 'run-1',
      reason: 'steer',
    });
  });

  test('a stop keeps `_interrupt` exactly as runners that predate the reason read it', () => {
    const lane = runningLane();
    lane.queue.interruptQuery(lane.jid, 'run-1', 'stop');
    // A runner from before the reason compares the trimmed file content with
    // its query id and only scans `.json` payloads.
    expect(
      fs.readFileSync(path.join(lane.inputDir, '_interrupt'), 'utf8'),
    ).toBe('run-1');
    const extra = fs
      .readdirSync(lane.inputDir)
      .filter((name) => name !== '_interrupt');
    expect(extra).toEqual(['_interrupt_reason']);
    expect(extra.some(isIpcInputPayloadFilename)).toBe(false);
  });

  test('an interrupt from a Host that predates the reason is a steer', () => {
    const lane = runningLane();
    fs.mkdirSync(lane.inputDir, { recursive: true });
    fs.writeFileSync(path.join(lane.inputDir, '_interrupt'), 'run-1');
    expect(consumeInterruptSentinel(lane.inputDir)).toEqual({
      queryRunId: 'run-1',
      reason: 'steer',
    });
  });

  test('a steer arriving before the runner read a stop keeps the stop', () => {
    const lane = runningLane();
    lane.queue.interruptQuery(lane.jid, 'run-1', 'stop');
    lane.queue.interruptQuery(lane.jid, 'run-1');
    expect(consumeInterruptSentinel(lane.inputDir)?.reason).toBe('stop');
  });

  test('a reason written for another query is neither used nor consumed', () => {
    const lane = runningLane();
    lane.queue.interruptQuery(lane.jid, 'run-1', 'stop');
    // A runner that predates the reason consumes only `_interrupt`; the next
    // query's steer must not inherit that stop.
    fs.unlinkSync(path.join(lane.inputDir, '_interrupt'));
    lane.state.queryId = 'run-2';
    lane.queue.interruptQuery(lane.jid, 'run-2');
    expect(consumeInterruptSentinel(lane.inputDir)).toEqual({
      queryRunId: 'run-2',
      reason: 'steer',
    });
    expect(fs.existsSync(path.join(lane.inputDir, '_interrupt_reason'))).toBe(
      true,
    );
    // Runner exit clears it with the other sentinels.
    (lane.queue as any).cleanupIpcSentinels(lane.folder);
    expect(fs.readdirSync(lane.inputDir)).toEqual([]);
  });

  test('a cold-boot stop is published as a stop once the runner registers, and outranks a steer', () => {
    for (const order of [
      ['stop'],
      ['stop', 'steer'],
      ['steer', 'stop'],
    ] as const) {
      const lane = runningLane();
      lane.state.groupFolder = null;
      lane.state.process = null;
      for (const reason of order) {
        expect(lane.queue.interruptQuery(lane.jid, 'run-1', reason)).toBe(true);
      }
      expect(fs.existsSync(lane.inputDir)).toBe(false);
      lane.queue.registerProcess(lane.jid, { pid: 4243 } as any, {
        containerName: null,
        groupFolder: lane.folder,
      });
      expect(consumeInterruptSentinel(lane.inputDir)).toEqual({
        queryRunId: 'run-1',
        reason: 'stop',
      });
    }
  });
});

describe('Runner turn stop', () => {
  test('/break interrupts and gives the sub-agents a deadline, never stopping a task itself', () => {
    const lane = runningLane();
    const turn = runnerTurn();
    lane.queue.interruptQuery(lane.jid, 'run-1', 'stop');
    const { reason } = consumeInterruptSentinel(lane.inputDir)!;

    turn.stop('Interrupt sentinel', reason);
    expect(turn.calls).toEqual(['interrupt']);
    // The sub-agent outlasts the interrupt: the query is closed.
    vi.advanceTimersByTime(SUB_AGENT_STOP_CLOSE_DELAY_MS);
    expect(turn.calls).toEqual(['interrupt', 'close']);
    expect(turn.query.stopTask).not.toHaveBeenCalled();
  });

  test('steer and 「发送」 only interrupt, whatever keeps running', () => {
    const lane = runningLane();
    const turn = runnerTurn();
    lane.queue.interruptQuery(lane.jid, 'run-1');
    const { reason } = consumeInterruptSentinel(lane.inputDir)!;

    turn.stop('Interrupt sentinel', reason);
    vi.advanceTimersByTime(10 * SUB_AGENT_STOP_CLOSE_DELAY_MS);

    expect(turn.calls).toEqual(['interrupt']);
  });

  test('an interrupt from an older Host only interrupts', () => {
    const lane = runningLane();
    const turn = runnerTurn();
    fs.mkdirSync(lane.inputDir, { recursive: true });
    fs.writeFileSync(path.join(lane.inputDir, '_interrupt'), 'run-1');
    const { reason } = consumeInterruptSentinel(lane.inputDir)!;

    turn.stop('Interrupt sentinel', reason);
    vi.advanceTimersByTime(10 * SUB_AGENT_STOP_CLOSE_DELAY_MS);

    expect(turn.calls).toEqual(['interrupt']);
  });

  test("the runner's own interrupts only interrupt", () => {
    for (const label of [
      'Rate-limit interrupt',
      'Model-fallback interrupt',
      'Model-limit interrupt',
      'Sub-agent provider-error interrupt',
      'Close sentinel detected during query (shutdown)',
    ]) {
      const turn = runnerTurn();
      turn.stop(label);
      vi.advanceTimersByTime(10 * SUB_AGENT_STOP_CLOSE_DELAY_MS);
      expect(turn.calls, label).toEqual(['interrupt']);
    }
  });

  test('one sub-agent still running at the deadline closes the query', () => {
    const turn = runnerTurn();
    turn.stop('Interrupt sentinel', 'stop');
    vi.advanceTimersByTime(SUB_AGENT_STOP_CLOSE_DELAY_MS - 1);
    // The interrupt ended the sub-agent; the workflow is still running.
    turn.settle('agent-1');
    expect(turn.query.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(turn.query.close).toHaveBeenCalledOnce();
  });

  test('ended sub-agents leave the query open for the shells still running', () => {
    const turn = runnerTurn();
    turn.stop('Interrupt sentinel', 'stop');
    turn.settle('agent-1');
    turn.settle('workflow-1');
    vi.advanceTimersByTime(10 * SUB_AGENT_STOP_CLOSE_DELAY_MS);
    expect(turn.calls).toEqual(['interrupt']);
    expect(turn.processor.getPendingSdkTaskCount()).toBe(3);
  });

  test('a stop with only shells, monitors and MCP tasks running never closes', () => {
    const turn = runnerTurn();
    turn.settle('agent-1', 'completed');
    turn.settle('workflow-1', 'completed');
    turn.stop('Interrupt sentinel', 'stop');
    vi.advanceTimersByTime(10 * SUB_AGENT_STOP_CLOSE_DELAY_MS);
    expect(turn.calls).toEqual(['interrupt']);
  });

  test('a query that ends, or is disposed, before the deadline is not closed', () => {
    const ended = runnerTurn();
    ended.stop('Interrupt sentinel', 'stop');
    ended.finishQuery();
    vi.advanceTimersByTime(SUB_AGENT_STOP_CLOSE_DELAY_MS);
    expect(ended.query.close).not.toHaveBeenCalled();

    const disposed = runnerTurn();
    disposed.stop('Interrupt sentinel', 'stop');
    disposed.stopper.dispose();
    vi.advanceTimersByTime(SUB_AGENT_STOP_CLOSE_DELAY_MS);
    expect(disposed.query.close).not.toHaveBeenCalled();
  });

  test('with later turns queued in Claude Code any interrupt closes at once', () => {
    for (const reason of ['stop', 'steer', undefined] as const) {
      const turn = runnerTurn();
      turn.stop('Interrupt sentinel', reason, 1);
      vi.advanceTimersByTime(10 * SUB_AGENT_STOP_CLOSE_DELAY_MS);
      expect(turn.calls, String(reason)).toEqual(['close']);
    }
  });
});
