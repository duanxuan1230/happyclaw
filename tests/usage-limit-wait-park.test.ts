import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-wait-park-'));
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: tmp,
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/runtime-state-store.js');
const wait = await import('../src/usage-limit-wait.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const LANE = 'web:park-lane';
const EMPTY_CURSOR = { timestamp: '', id: '', sequence: 0 };

function inbound(id: string, minute: number): void {
  db.ensureChatExists(LANE);
  db.storeMessageDirect(
    id,
    LANE,
    'owner',
    'Owner',
    `message ${id}`,
    `2026-10-29T08:${String(minute).padStart(2, '0')}:00.000Z`,
    false,
  );
}

function harness() {
  const globals: Record<string, any> = {
    crypto,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    EMPTY_CURSOR,
    lastCommittedCursor: {} as Record<string, unknown>,
    getMessagesSince: db.getMessagesSince,
    setMessageFollowUp: db.setMessageFollowUp,
    claimNextQueuedFollowUpBatch: db.claimNextQueuedFollowUpBatch,
    releaseQueuedFollowUpBatch: db.releaseQueuedFollowUpBatch,
    getUsageLimitWait: store.getUsageLimitWait,
    endUsageLimitWait: wait.endUsageLimitWait,
    formatUsageLimitWaitNotice: wait.formatUsageLimitWaitNotice,
    formatUsageLimitResumeTime: wait.formatUsageLimitResumeTime,
    armUsageLimitResume: vi.fn(),
    broadcastFollowUpUpdate: vi.fn(),
    broadcastFollowUpBatchUpdate: vi.fn(),
    broadcastUsageLimitWait: vi.fn(),
    deliverTerminalFailureNotice: vi.fn(async () => {}),
    withdrawQueuedInputsOutsideAudience: vi.fn(),
    enqueueReleasedFollowUp: vi.fn(),
  };
  const runtime = createRuntimeSourceHarness(globals);
  for (const name of [
    'usageLimitParkedMessageIds',
    'parkInputForUsageLimitWait',
    'releaseQueuedFollowUpsToColdReader',
    'releaseUsageLimitWaitForNewInput',
  ]) {
    runtime.install(name);
  }
  return globals;
}

describe('parking an input that waits for a usage-limit reset', () => {
  test('the failed batch and the backlog behind it wait in the durable queue; new input brings them back', () => {
    const g = harness();
    inbound('m1', 1);
    inbound('m2', 2);
    inbound('m3', 3);
    // m1 was answered; m2 hit the wall; m3 was still waiting behind it.
    g.lastCommittedCursor[LANE] = db.getMessageCursor(LANE, 'm1');
    store.reserveUsageLimitWait({
      scopeKey: LANE,
      inputKey: 'm2',
      resetAt: '2026-10-29T09:00:00.000Z',
      resumeAt: '2026-10-29T09:01:10.000Z',
      maxWaits: 3,
    });

    const note = g.parkInputForUsageLimitWait({
      laneJid: LANE,
      agentId: null,
      inputId: 'm2',
      messageIds: g.usageLimitParkedMessageIds(LANE, {}, [{ id: 'm2' }]),
      replySourceImJid: 'feishu:oc_park',
      turnScope: 'park-scope',
      presentation: 'default',
    });

    expect(note).toMatch(/^额度用尽，预计 .+ 自动继续$/);
    expect(
      db
        .listQueuedFollowUps(LANE)
        .map((item) => [item.id, item.delivery_run_id]),
    ).toEqual([
      // "Send now" needs a run id to name; the parked input carries its own.
      ['m2', 'usage-limit:m2'],
      ['m3', 'usage-limit:m2'],
    ]);
    expect(db.getMessagesSince(LANE, g.lastCommittedCursor[LANE])).toHaveLength(
      0,
    );
    expect(g.armUsageLimitResume).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey: LANE, waitCount: 1 }),
    );
    expect(g.broadcastFollowUpUpdate).toHaveBeenCalledWith(LANE);
    expect(g.broadcastUsageLimitWait).toHaveBeenCalledWith(
      LANE,
      expect.objectContaining({ resumeAt: '2026-10-29T09:01:10.000Z' }),
    );
    // One channel notice, keyed by the input so later waits stay quiet.
    expect(g.deliverTerminalFailureNotice).toHaveBeenCalledTimes(1);
    expect(g.deliverTerminalFailureNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        targetJid: 'feishu:oc_park',
        originalInputTurnId: 'm2',
        noticeKey: 'usage-limit-wait',
        text: expect.stringContaining('自动继续'),
      }),
    );

    // Nothing pending: the retry after the failed run finds no input.
    expect(g.releaseUsageLimitWaitForNewInput(LANE)).toBe(true);
    expect(
      db
        .getMessagesSince(LANE, g.lastCommittedCursor[LANE])
        .map((message) => message.id),
    ).toEqual(['m2', 'm3']);
    expect(store.getUsageLimitWait(LANE)).toMatchObject({
      state: 'resumed',
      waitCount: 1,
    });
    // The caller reads the batch itself; nothing else is scheduled.
    expect(g.enqueueReleasedFollowUp).not.toHaveBeenCalled();
    // A second new input finds no wait to end.
    expect(g.releaseUsageLimitWaitForNewInput(LANE)).toBe(false);
  });

  test('a Web input gets no channel notice', () => {
    const g = harness();
    const lane = LANE;
    inbound('w1', 20);
    g.lastCommittedCursor[lane] = EMPTY_CURSOR;
    store.reserveUsageLimitWait({
      scopeKey: lane,
      inputKey: 'w1',
      resetAt: '2026-10-29T09:00:00.000Z',
      resumeAt: '2026-10-29T09:01:00.000Z',
      maxWaits: 3,
    });
    g.parkInputForUsageLimitWait({
      laneJid: lane,
      agentId: null,
      inputId: 'w1',
      messageIds: ['w1'],
      replySourceImJid: null,
      turnScope: 'park-scope',
      presentation: 'default',
    });
    expect(g.deliverTerminalFailureNotice).not.toHaveBeenCalled();
  });
});

describe('usage-limit wait wiring in the conversation loops', () => {
  const source = fs.readFileSync('src/index.ts', 'utf8');
  const slice = (start: string, end: string) =>
    source.slice(source.indexOf(start), source.indexOf(end));
  const main = slice(
    'async function processGroupMessages(',
    'async function runTerminalWarmup(',
  );
  const agent = slice(
    'async function processAgentConversation(',
    'async function startMessageLoop(',
  );

  test('both loops park a waiting failure and end the wait for new input', () => {
    for (const [body, lane] of [
      [main, 'chatJid'],
      [agent, 'virtualChatJid'],
    ] as const) {
      expect(body).toMatch(
        /providerUsageLimitResumeAt !== undefined\) \{[\s\S]{0,200}?parkInputForUsageLimitWait\(\{/,
      );
      expect(body).toMatch(
        new RegExp(
          `pendingWindow\\.messages\\.some\\([\\s\\S]{0,120}?\\) &&\\s*releaseUsageLimitWaitForNewInput\\(${lane}\\)[\\s\\S]{0,120}?pendingWindow = getMessagesSinceBounded\\(`,
        ),
      );
    }
    expect(main).toContain('if (parkedForUsageLimitWait) {');
    expect(agent).toContain('if (parkedForUsageLimitWait) {');
  });

  test('break, cancel, send-now, stop and restart all reach the wait', () => {
    expect(
      slice(
        'async function handleSessionBreak(',
        'async function handleFeishuSessionClear(',
      ),
    ).toContain("endUsageLimitWait(targetJid, 'cancelled');");
    expect(
      slice('function settleCancelledFollowUp(', 'function editFollowUp('),
    ).toMatch(
      /listQueuedFollowUps\(chatJid\)\.length === 0\) \{\s*endUsageLimitWait\(chatJid, 'cancelled'\);/,
    );
    expect(
      slice('function promoteFollowUp(', 'function cancelFollowUp('),
    ).toMatch(
      /endUsageLimitWait\(chatJid, 'new_input'\)\) \{[\s\S]{0,120}releaseQueuedFollowUpsToColdReader\(chatJid\);/,
    );
    expect(source).toMatch(
      /queue\.setOnLaneDiscarded\(\(jid\) => \{\s*endUsageLimitWait\(jid, 'discarded'\);/,
    );
    expect(source).toContain(
      'recoverDurableFollowUps(new Set(rearmUsageLimitWaitsAfterRestart()));',
    );
    expect(
      slice('function recoverDurableFollowUps(', '// ── Usage-limit waits'),
    ).toContain('if (waitingLanes.has(chatJid)) continue;');
    expect(source).toMatch(
      /keepCorrelationIds: \[\s*\.\.\.new Set\(\s*listPendingUsageLimitWaits\(\)\.flatMap\(/,
    );
  });
});
