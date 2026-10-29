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
function harness(host: boolean | ((jid: string) => boolean) = false) {
  const isHost = typeof host === 'function' ? host : () => host;
  const queue = new GroupQueue();
  queue.setHostModeChecker(isHost);
  const exits = new Map<string, () => void>();
  const started: string[] = [];
  queue.setProcessMessagesFn(async (jid) => {
    started.push(jid);
    queue.registerProcess(jid, {} as never, {
      containerName: isHost(jid) ? null : `c-${jid}`,
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

  test('an idle Host runner never gives up its process for a container lane', async () => {
    const { queue, started, closed } = harness((jid) =>
      jid.startsWith('web:host'),
    );
    await idleRunner(queue, 'web:host-idle');
    queue.enqueueMessageCheck('web:busy');
    await tick();
    queue.enqueueMessageCheck('web:waiting');
    expect(closed).not.toHaveBeenCalled();
    expect(started).toEqual(['web:host-idle', 'web:busy']);
    expect(queue.getStatus().waitingCount).toBe(1);
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

  test('reclaims the same user’s idle container when per-user container limit is reached below global limit', async () => {
    settings.maxConcurrentContainers = 5;
    const { queue, started, closed } = harness();
    const userOf = (jid: string) => (jid.startsWith('web:u1-') ? 'u1' : 'u2');
    const activeByUser = new Map<string, number>();
    queue.setUserConcurrentLimitChecker((jid) => {
      const userId = userOf(jid);
      return {
        allowed: (activeByUser.get(userId) ?? 0) < 1,
        userId,
      };
    });

    // u2 has an older idle container; u1 has a newer idle container
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    await idleRunner(queue, 'web:u2-idle');
    activeByUser.set('u2', 1);
    now.mockReturnValue(2_000);
    await idleRunner(queue, 'web:u1-idle');
    activeByUser.set('u1', 1);
    now.mockRestore();

    // u1 enqueues a second workspace: u1 is at per-user limit (1), global is 2 < 5
    closed.mockImplementationOnce((jid: string) => {
      activeByUser.set(userOf(jid), 0);
      queue.stopGroup(jid);
    });
    queue.enqueueMessageCheck('web:u1-next');
    expect(closed).toHaveBeenCalledWith('web:u1-idle');
    expect(closed).not.toHaveBeenCalledWith('web:u2-idle');
    expect(started).toContain('web:u1-idle');
  });

  test('picking a runner for a user at their limit checks each lane’s owner once', async () => {
    settings.maxConcurrentContainers = 20;
    const { queue, closed } = harness();
    const userOf = (jid: string) => (jid.startsWith('web:u1-') ? 'u1' : 'u2');
    const active = { u1: 0 };
    // Like the real checker, every call walks all workspaces of the owner.
    const calls = new Map<string, number>();
    queue.setUserConcurrentLimitChecker((jid) => {
      calls.set(jid, (calls.get(jid) ?? 0) + 1);
      const userId = userOf(jid);
      return { allowed: userId === 'u2' || active.u1 < 2, userId };
    });
    const now = vi.spyOn(Date, 'now');
    const idleJids = [
      'web:u2-a',
      'web:u1-old',
      'web:u2-b',
      'web:u2-c',
      'web:u1-new',
      'web:u2-d',
      'web:u2-e',
    ];
    for (const [index, jid] of idleJids.entries()) {
      now.mockReturnValue(1_000 * (index + 1));
      await idleRunner(queue, jid);
      if (userOf(jid) === 'u1') active.u1++;
    }
    now.mockRestore();
    calls.clear();

    queue.enqueueMessageCheck('web:u1-next');

    expect(closed.mock.calls.map(([jid]) => jid)).toEqual(['web:u1-old']);
    for (const jid of idleJids) {
      expect(calls.get(jid) ?? 0, jid).toBeLessThanOrEqual(1);
    }
  });

  test('hasActiveMainRunnerForMessage returns false while a runner is closing', async () => {
    settings.maxConcurrentContainers = 1;
    const { queue, closed } = harness();
    // Do not auto-exit on closeStdin so state.closing stays set
    closed.mockImplementation(() => {});
    await idleRunner(queue, 'web:closing-test');
    expect(queue.hasActiveMainRunnerForMessage('web:closing-test')).toBe(true);

    queue.enqueueMessageCheck('web:waiting-peer');
    expect(closed).toHaveBeenCalledWith('web:closing-test');
    expect(queue.hasActiveMainRunnerForMessage('web:closing-test')).toBe(false);
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

describe('an ordinary stop discards lane work kept outside GroupQueue', () => {
  test('stop, reset and delete report the lane; a mutation stop does not', async () => {
    const { queue } = harness();
    const discarded: string[] = [];
    queue.setOnLaneDiscarded((jid) => discarded.push(jid));

    await queue.stopGroup('web:idle-lane');
    expect(discarded).toEqual(['web:idle-lane']);

    queue.enqueueMessageCheck('web:busy');
    await tick();
    const token = queue.pauseGroupsForMutation(['web:busy']);
    await queue.stopGroup('web:busy', {
      force: true,
      preserveQueuedWork: true,
    });
    queue.resumeGroupsAfterMutation(token);
    expect(discarded).toEqual(['web:idle-lane']);
  });
});
