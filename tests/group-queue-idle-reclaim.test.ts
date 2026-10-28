import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock('../src/container-runner.js', () => ({ killProcessTree: () => {} }));
const settings = vi.hoisted(() => ({ maxConcurrentContainers: 1 }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => settings,
}));
vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));

const { GroupQueue } = await import('../src/group-queue.js');
type Queue = InstanceType<typeof GroupQueue>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  for (let index = 0; index < 4; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await tick();
  settings.maxConcurrentContainers = 1;
});

/**
 * A queue whose message runs stay alive until released, like a warm runner
 * that went idle after its query. `exits` resolves a lane's run.
 */
function harness(host = false) {
  const queue = new GroupQueue();
  queue.setHostModeChecker(() => host);
  const exits = new Map<string, () => void>();
  const started: string[] = [];
  queue.setProcessMessagesFn(async (jid) => {
    started.push(jid);
    queue.registerProcess(jid, {} as never, {
      containerName: host ? null : `c-${jid}`,
      groupFolder: jid.replace('web:', ''),
    });
    const exit = deferred();
    exits.set(jid, exit.resolve);
    releases.push(exit.resolve);
    await exit.promise;
    return true;
  });
  const closed = vi
    .spyOn(queue, 'closeStdin')
    .mockImplementation((jid: string) => {
      // The runner honours _close by exiting.
      exits.get(jid)?.();
    });
  return { queue, started, closed, exits };
}

async function idleRunner(queue: Queue, jid: string): Promise<void> {
  queue.enqueueMessageCheck(jid);
  await tick();
  queue.markRunnerQueryIdle(jid);
}

describe('reclaiming idle warm container runners', () => {
  test('waiting work takes the slot of the idle runner', async () => {
    const { queue, started, closed } = harness();
    await idleRunner(queue, 'web:a');
    expect(closed).not.toHaveBeenCalled();

    queue.enqueueMessageCheck('web:b');
    expect(closed).toHaveBeenCalledWith('web:a');
    await tick();
    expect(started).toEqual(['web:a', 'web:b']);
    expect(queue.getStatus().activeContainerCount).toBe(1);
  });

  test('a runner going idle while work waits is reclaimed at once', async () => {
    const { queue, started, closed } = harness();
    queue.enqueueMessageCheck('web:a');
    await tick();
    queue.enqueueMessageCheck('web:b');
    // Mid-query: never reclaimed.
    expect(closed).not.toHaveBeenCalled();
    expect(queue.getStatus().waitingCount).toBe(1);

    queue.markRunnerQueryIdle('web:a');
    expect(closed).toHaveBeenCalledWith('web:a');
    await tick();
    expect(started).toEqual(['web:a', 'web:b']);
  });

  test('a runner whose lane has queued input or background work keeps its slot', async () => {
    const { queue, started, closed } = harness();
    const owesWork = new Set(['web:a']);
    queue.setIdleRunnerReclaimBlocker((jid) => owesWork.has(jid));
    await idleRunner(queue, 'web:a');

    queue.enqueueMessageCheck('web:b');
    await tick();
    expect(closed).not.toHaveBeenCalled();
    expect(started).toEqual(['web:a']);

    // Once the queue drained, the next idle reclaims it.
    owesWork.clear();
    queue.markRunnerQueryIdle('web:a');
    expect(closed).not.toHaveBeenCalled(); // no query was in flight
    queue.enqueueMessageCheck('web:c');
    expect(closed).toHaveBeenCalledWith('web:a');
  });

  test('the longest-idle runner goes first, and only as many as are needed', async () => {
    settings.maxConcurrentContainers = 2;
    const { queue, closed } = harness();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    await idleRunner(queue, 'web:old');
    now.mockReturnValue(5_000);
    await idleRunner(queue, 'web:recent');
    now.mockRestore();

    queue.enqueueMessageCheck('web:new');
    expect(closed.mock.calls.map(([jid]) => jid)).toEqual(['web:old']);
  });

  test('Host runners are never reclaimed and never wait for a slot', async () => {
    const { queue, started, closed } = harness(true);
    await idleRunner(queue, 'web:a');
    queue.enqueueMessageCheck('web:b');
    await tick();
    expect(closed).not.toHaveBeenCalled();
    expect(started).toEqual(['web:a', 'web:b']);
    expect(queue.getStatus().activeHostProcessCount).toBe(2);
  });
});

describe('deferring a mutation stop to the end of the current query', () => {
  test('the runner that committed the change finishes its turn, then closes and settles', async () => {
    const { queue, closed, exits } = harness();
    queue.enqueueMessageCheck('web:self');
    await tick();
    const settled: string[] = [];

    const token = queue.pauseGroupsForMutation(['web:self']);
    await queue.deferStopsToQueryEnd(
      'web:self',
      (jid) => settled.push(jid),
      async () => {
        await queue.stopGroup('web:self', {
          force: true,
          preserveQueuedWork: true,
        });
      },
    );
    queue.resumeGroupsAfterMutation(token);
    // Not killed mid-turn.
    expect(closed).not.toHaveBeenCalled();
    expect(queue.getStatus().activeContainerCount).toBe(1);

    // The turn ends: no further query is accepted, the runner closes.
    queue.markRunnerQueryIdle('web:self');
    expect(queue.reserveNextQuery('web:self')).toBeNull();
    expect(queue.sendMessage('web:self', 'next')).toBe('no_active');
    expect(closed).toHaveBeenCalledWith('web:self');
    expect(exits.has('web:self')).toBe(true);
    await tick();
    expect(settled).toEqual(['web:self']);
    expect(queue.getStatus().activeContainerCount).toBe(0);
  });

  test('outside the deferral, a mutation stop still stops the runner', async () => {
    const { queue, started, closed } = harness();
    queue.enqueueMessageCheck('web:other');
    await tick();
    const token = queue.pauseGroupsForMutation(['web:other']);
    await queue.stopGroup('web:other', {
      force: true,
      preserveQueuedWork: true,
    });
    expect(closed).toHaveBeenCalledWith('web:other');
    queue.resumeGroupsAfterMutation(token);
    await tick();
    // The preserved work replays on a fresh runner.
    expect(started).toEqual(['web:other', 'web:other']);
  });
});
