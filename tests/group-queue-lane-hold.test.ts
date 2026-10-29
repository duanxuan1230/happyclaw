/**
 * GroupQueue lane holds and per-lane stop markers, on a real queue: holding
 * one session lane never delays the workspace's other lanes, a stop is
 * remembered for its own lane only, holds are counted, and the IPC
 * deliveries a work-keeping stop left unacknowledged are replayed when the
 * work resumes and committed when it is discarded.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-hold-'));
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    DATA_DIR: path.join(paths.root, 'data'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const settings = vi.hoisted(() => ({ maxConcurrentContainers: 10 }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => settings,
}));
vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));

const { GroupQueue } = await import('../src/group-queue.js');

const FOLDER = 'ws';
const MAIN = 'web:ws';
const IM = 'feishu:oc_ws';
const LANE = 'web:ws#agent:s1';
const OTHER = 'web:ws#agent:s2';

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A workspace with main (shared by its IM group) and two session lanes. */
function harness() {
  const queue = new GroupQueue();
  queue.setSerializationKeyResolver((jid: string) => {
    const agentSep = jid.indexOf('#agent:');
    if (agentSep >= 0) return `${FOLDER}#${jid.slice(agentSep + 7)}`;
    return jid === MAIN || jid === IM ? FOLDER : jid;
  });
  queue.setHostModeChecker(() => true);
  queue.setIpcDeliveryCommitEligibilityChecker(() => true);
  const runs: string[] = [];
  const exits = new Map<string, ReturnType<typeof deferred>>();
  queue.setProcessMessagesFn(async (jid: string) => {
    runs.push(jid);
    const exit = deferred();
    exits.set(jid, exit);
    queue.registerProcess(jid, {} as never, {
      containerName: null,
      groupFolder: FOLDER,
      agentId: jid.includes('#agent:') ? jid.split('#agent:')[1] : undefined,
    });
    await exit.promise;
    return true;
  });
  vi.spyOn(queue, 'closeStdin').mockImplementation((jid: string) => {
    exits.get(jid)?.resolve();
  });
  const count = (jid: string) => runs.filter((run) => run === jid).length;
  return { queue, runs, exits, count };
}

afterEach(() => {
  settings.maxConcurrentContainers = 10;
  fs.rmSync(path.join(paths.root, 'data'), { recursive: true, force: true });
});

describe('holding a session lane', () => {
  test.each(['releaseLane', 'discardHeldLane'] as const)(
    'main finishing its turn during the hold runs its queued message at once (then %s)',
    async (finish) => {
      const { queue, exits, count } = harness();
      queue.enqueueMessageCheck(MAIN);
      queue.enqueueMessageCheck(LANE);
      await settle();
      // A follow-up for main queues behind its busy runner.
      queue.enqueueMessageCheck(MAIN);
      queue.holdLane(LANE);
      await queue.stopGroup(LANE, { force: true, preserveQueuedWork: true });

      exits.get(MAIN)!.resolve();
      await settle();
      expect(count(MAIN)).toBe(2);

      queue[finish](LANE);
      await settle();
      expect(count(MAIN)).toBe(2);
      // The released lane runs again; the discarded one does not.
      expect(count(LANE)).toBe(finish === 'releaseLane' ? 2 : 1);
    },
  );

  test.each(['releaseLane', 'discardHeldLane'] as const)(
    'the container slot the held lane gave up serves main at once (then %s)',
    async (finish) => {
      const { queue, count } = harness();
      settings.maxConcurrentContainers = 1;
      queue.setHostModeChecker(() => false);
      queue.enqueueMessageCheck(LANE);
      await settle();
      // Main waits for the only container slot.
      queue.enqueueMessageCheck(MAIN);
      await settle();
      expect(count(MAIN)).toBe(0);

      queue.holdLane(LANE);
      await queue.stopGroup(LANE, { force: true, preserveQueuedWork: true });
      await settle();
      expect(count(MAIN)).toBe(1);
      queue[finish](LANE);
      await settle();
      expect(count(MAIN)).toBe(1);
    },
  );

  test('two holders: the lane stays held until both are done', async () => {
    const { queue, count } = harness();
    queue.holdLane(LANE);
    queue.holdLane(LANE);
    queue.enqueueMessageCheck(LANE);
    queue.releaseLane(LANE);
    await settle();
    expect(queue.isGroupMutationPaused(LANE)).toBe(true);
    expect(count(LANE)).toBe(0);
    queue.releaseLane(LANE);
    await settle();
    expect(queue.isGroupMutationPaused(LANE)).toBe(false);
    expect(count(LANE)).toBe(1);
  });

  test('a discard while another holder remains drops the work but keeps the hold', async () => {
    const { queue, count } = harness();
    const discarded: string[] = [];
    queue.setOnLaneDiscarded((jid) => discarded.push(jid));
    queue.holdLane(LANE);
    queue.holdLane(LANE);
    queue.enqueueMessageCheck(LANE);
    queue.discardHeldLane(LANE);
    expect(discarded).toEqual([LANE]);
    expect(queue.isGroupMutationPaused(LANE)).toBe(true);
    queue.releaseLane(LANE);
    await settle();
    expect(queue.isGroupMutationPaused(LANE)).toBe(false);
    // Its work went with the discard.
    expect(count(LANE)).toBe(0);
  });
});

describe('a stop is remembered for its own lane', () => {
  test('a user Stop on main during a session hold stays a discard, and survives the release', async () => {
    const { queue } = harness();
    queue.enqueueMessageCheck(MAIN);
    queue.enqueueMessageCheck(LANE);
    queue.enqueueMessageCheck(OTHER);
    await settle();
    queue.holdLane(LANE);
    await queue.stopGroup(LANE, { force: true, preserveQueuedWork: true });
    await queue.stopGroup(MAIN, { force: true });

    expect(queue.getRecentStopDisposition(LANE)).toBe('preserve');
    expect(queue.getRecentStopDisposition(MAIN)).toBe('discard');
    // The IM group shares main's runner: the same lane, the same stop.
    expect(queue.getRecentStopDisposition(IM)).toBe('discard');
    expect(queue.getRecentStopDisposition(OTHER)).toBe('none');
    expect(queue.isRecentlyStopped(OTHER)).toBe(false);

    queue.releaseLane(LANE);
    expect(queue.getRecentStopDisposition(MAIN)).toBe('discard');
    expect(queue.getRecentStopDisposition(LANE)).toBe('none');
  });

  test('main stopped by the user does not run again right after its exit', async () => {
    const { queue, count } = harness();
    queue.enqueueMessageCheck(MAIN);
    await settle();
    queue.enqueueMessageCheck(MAIN);
    await queue.stopGroup(MAIN, { force: true });
    await settle();
    expect(count(MAIN)).toBe(1);
  });
});

describe('deliveries a work-keeping stop left unacknowledged', () => {
  function withDelivery() {
    const h = harness();
    const replayed: string[][] = [];
    const committed: string[][] = [];
    h.queue.setOnUnacknowledgedIpcDeliveries((_jid, receipts) =>
      replayed.push(receipts.map((r) => r.cursor.id)),
    );
    h.queue.setOnAbandonedIpcDeliveries((_jid, receipts) =>
      committed.push(receipts.map((r) => r.cursor.id)),
    );
    const inject = (jid: string, id: string) => {
      const cursor = { timestamp: '2026-10-29T00:00:00.000Z', id };
      expect(
        h.queue.sendMessage(jid, id, undefined, undefined, jid, undefined, {
          chatJid: jid,
          coveredCursors: [cursor],
          cursor,
        }),
      ).toBe('sent');
    };
    return { ...h, replayed, committed, inject };
  }

  test('a deleted workspace commits them instead of replaying them', async () => {
    const { queue, replayed, committed, inject } = withDelivery();
    queue.enqueueMessageCheck(IM);
    await settle();
    inject(IM, 'om_in_flight');
    const token = queue.pauseGroupsForMutation([MAIN, IM]);
    await queue.stopGroup(IM, { force: true, preserveQueuedWork: true });
    expect(replayed).toEqual([]);

    queue.discardGroupsAfterMutation(token);
    expect(committed).toEqual([['om_in_flight']]);
    expect(replayed).toEqual([]);
  });

  test('a mutation that resumes replays them', async () => {
    const { queue, replayed, committed, inject } = withDelivery();
    queue.enqueueMessageCheck(IM);
    await settle();
    inject(IM, 'om_in_flight');
    const token = queue.pauseGroupsForMutation([MAIN, IM]);
    await queue.stopGroup(IM, { force: true, preserveQueuedWork: true });

    queue.resumeGroupsAfterMutation(token);
    expect(replayed).toEqual([['om_in_flight']]);
    expect(committed).toEqual([]);
  });

  test('a released session lane replays them; a discarded one commits them', async () => {
    for (const finish of ['releaseLane', 'discardHeldLane'] as const) {
      const { queue, replayed, committed, inject } = withDelivery();
      queue.enqueueMessageCheck(LANE);
      await settle();
      inject(LANE, `om_${finish}`);
      queue.holdLane(LANE);
      await queue.stopGroup(LANE, { force: true, preserveQueuedWork: true });
      expect(replayed).toEqual([]);
      queue[finish](LANE);
      expect(finish === 'releaseLane' ? replayed : committed).toEqual([
        [`om_${finish}`],
      ]);
      expect(finish === 'releaseLane' ? committed : replayed).toEqual([]);
    }
  });
});
