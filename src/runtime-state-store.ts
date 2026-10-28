/**
 * Durable runtime and scheduling state that must survive a restart:
 * usage-limit waits, the history hand-off owed to sessions reset by a
 * capability change, de-duplicated scheduled-task failure notices, and the
 * connection that served each usage event.
 *
 * db.ts binds this module to its connection; no other module touches these
 * tables directly.
 */

interface SqliteRunResult {
  changes: number;
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

let database: SqliteDatabase | null = null;

function requireDatabase(): SqliteDatabase {
  if (!database) throw new Error('Runtime state store is not initialized');
  return database;
}

/** Create the tables (idempotent) and bind the store; null unbinds it. */
export function initRuntimeStateStore(db: SqliteDatabase | null): void {
  database = db;
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_limit_waits (
      scope_key TEXT PRIMARY KEY,
      input_key TEXT NOT NULL,
      wait_count INTEGER NOT NULL,
      reset_at TEXT NOT NULL,
      resume_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'waiting',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_history_reinjections (
      group_folder TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, agent_id)
    );
    CREATE TABLE IF NOT EXISTS task_failure_notices (
      task_id TEXT PRIMARY KEY,
      error_key TEXT NOT NULL,
      error_text TEXT NOT NULL,
      failure_count INTEGER NOT NULL,
      first_failed_at TEXT NOT NULL,
      last_failed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_event_connections (
      event_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

// ─── Usage-limit waits ─────────────────────────────────────

export type UsageLimitWaitState = 'waiting' | 'resumed';

export interface UsageLimitWait {
  /** Queue lane: a chat JID, `{jid}#agent:{id}`, or `task-run:{runId}`. */
  scopeKey: string;
  /** Durable input that hit the wall most recently in this lane. */
  inputKey: string;
  /** Consecutive waits in this lane since its last healthy turn. */
  waitCount: number;
  resetAt: string;
  resumeAt: string;
  state: UsageLimitWaitState;
  createdAt: string;
  updatedAt: string;
}

function toUsageLimitWait(row: Record<string, unknown>): UsageLimitWait {
  return {
    scopeKey: String(row.scope_key),
    inputKey: String(row.input_key),
    waitCount: Number(row.wait_count) || 0,
    resetAt: String(row.reset_at),
    resumeAt: String(row.resume_at),
    state: row.state === 'resumed' ? 'resumed' : 'waiting',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Count one more consecutive wait for a lane and record when it resumes.
 * Returns null, and forgets the lane, once the wait budget is spent: the
 * caller then ends the input the way it did before waits existed.
 */
export function reserveUsageLimitWait(input: {
  scopeKey: string;
  inputKey: string;
  resetAt: string;
  resumeAt: string;
  maxWaits: number;
  now?: string;
}): UsageLimitWait | null {
  const db = requireDatabase();
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM usage_limit_waits WHERE scope_key = ?')
      .get(input.scopeKey) as Record<string, unknown> | undefined;
    const waitCount = (row ? Number(row.wait_count) || 0 : 0) + 1;
    if (waitCount > input.maxWaits) {
      db.prepare('DELETE FROM usage_limit_waits WHERE scope_key = ?').run(
        input.scopeKey,
      );
      return null;
    }
    db.prepare(
      `INSERT INTO usage_limit_waits (
         scope_key, input_key, wait_count, reset_at, resume_at, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)
       ON CONFLICT(scope_key) DO UPDATE SET
         input_key = excluded.input_key,
         wait_count = excluded.wait_count,
         reset_at = excluded.reset_at,
         resume_at = excluded.resume_at,
         state = 'waiting',
         updated_at = excluded.updated_at`,
    ).run(
      input.scopeKey,
      input.inputKey,
      waitCount,
      input.resetAt,
      input.resumeAt,
      now,
      now,
    );
    return toUsageLimitWait(
      db
        .prepare('SELECT * FROM usage_limit_waits WHERE scope_key = ?')
        .get(input.scopeKey) as Record<string, unknown>,
    );
  })();
}

export function getUsageLimitWait(scopeKey: string): UsageLimitWait | null {
  const row = requireDatabase()
    .prepare('SELECT * FROM usage_limit_waits WHERE scope_key = ?')
    .get(scopeKey) as Record<string, unknown> | undefined;
  return row ? toUsageLimitWait(row) : null;
}

export function listUsageLimitWaits(
  state?: UsageLimitWaitState,
): UsageLimitWait[] {
  const db = requireDatabase();
  const rows = (
    state
      ? db
          .prepare(
            'SELECT * FROM usage_limit_waits WHERE state = ? ORDER BY resume_at',
          )
          .all(state)
      : db.prepare('SELECT * FROM usage_limit_waits ORDER BY resume_at').all()
  ) as Array<Record<string, unknown>>;
  return rows.map(toUsageLimitWait);
}

/** The parked input started again; keep the count until a healthy turn. */
export function markUsageLimitWaitResumed(scopeKey: string): boolean {
  return (
    requireDatabase()
      .prepare(
        `UPDATE usage_limit_waits SET state = 'resumed', updated_at = ?
         WHERE scope_key = ? AND state = 'waiting'`,
      )
      .run(new Date().toISOString(), scopeKey).changes === 1
  );
}

export function clearUsageLimitWait(scopeKey: string): UsageLimitWait | null {
  const db = requireDatabase();
  return db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM usage_limit_waits WHERE scope_key = ?')
      .get(scopeKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    db.prepare('DELETE FROM usage_limit_waits WHERE scope_key = ?').run(
      scopeKey,
    );
    return toUsageLimitWait(row);
  })();
}

/** Every wait of a chat JID and of the Runtime Sessions under it. */
export function listUsageLimitWaitsForChat(chatJid: string): UsageLimitWait[] {
  const rows = requireDatabase()
    .prepare(
      `SELECT * FROM usage_limit_waits
       WHERE scope_key = ? OR substr(scope_key, 1, ?) = ?`,
    )
    .all(chatJid, chatJid.length + 7, `${chatJid}#agent:`) as Array<
    Record<string, unknown>
  >;
  return rows.map(toUsageLimitWait);
}

// ─── Session history re-injection ──────────────────────────

/**
 * Remember that these sessions lost their SDK context to a capability
 * change, so the next turn of each re-injects recent history. `''` is the
 * Workspace main session.
 */
export function markSessionsForHistoryReinjection(
  groupFolder: string,
  agentIds: readonly string[],
  reason: string,
): void {
  if (agentIds.length === 0) return;
  const db = requireDatabase();
  const insert = db.prepare(
    `INSERT INTO session_history_reinjections (
       group_folder, agent_id, reason, created_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET
       reason = excluded.reason, created_at = excluded.created_at`,
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const agentId of new Set(agentIds)) {
      insert.run(groupFolder, agentId, reason, now);
    }
  })();
}

/**
 * The reason a session owes a history hand-off, or null. The marker lives
 * until the session holds an SDK session again: a turn that fails before it
 * establishes one re-injects on its retry, and one that succeeded clears it.
 */
export function takeSessionHistoryReinjection(
  groupFolder: string,
  agentId: string | null | undefined,
  sessionEstablished: boolean,
): string | null {
  const db = requireDatabase();
  const key = agentId || '';
  if (sessionEstablished) {
    db.prepare(
      'DELETE FROM session_history_reinjections WHERE group_folder = ? AND agent_id = ?',
    ).run(groupFolder, key);
    return null;
  }
  const row = db
    .prepare(
      'SELECT reason FROM session_history_reinjections WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, key) as { reason: string } | undefined;
  return row?.reason ?? null;
}

export function clearSessionHistoryReinjections(groupFolder: string): void {
  requireDatabase()
    .prepare('DELETE FROM session_history_reinjections WHERE group_folder = ?')
    .run(groupFolder);
}

// ─── Scheduled-task failure notices ────────────────────────

export interface TaskFailureNoticeState {
  taskId: string;
  errorKey: string;
  errorText: string;
  failureCount: number;
  firstFailedAt: string;
  lastFailedAt: string;
}

function toTaskFailureNotice(
  row: Record<string, unknown>,
): TaskFailureNoticeState {
  return {
    taskId: String(row.task_id),
    errorKey: String(row.error_key),
    errorText: String(row.error_text),
    failureCount: Number(row.failure_count) || 0,
    firstFailedAt: String(row.first_failed_at),
    lastFailedAt: String(row.last_failed_at),
  };
}

/**
 * Record a failed run. `notify` is true for the first failure of a streak
 * and whenever the normalized error changes; a repeat of the error already
 * reported is only counted.
 */
export function recordTaskFailure(
  taskId: string,
  errorKey: string,
  errorText: string,
  now = new Date().toISOString(),
): { notify: boolean; state: TaskFailureNoticeState } {
  const db = requireDatabase();
  return db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM task_failure_notices WHERE task_id = ?')
      .get(taskId) as Record<string, unknown> | undefined;
    const repeat = !!row && String(row.error_key) === errorKey;
    if (repeat) {
      db.prepare(
        `UPDATE task_failure_notices
         SET failure_count = failure_count + 1, last_failed_at = ?
         WHERE task_id = ?`,
      ).run(now, taskId);
    } else {
      db.prepare(
        `INSERT INTO task_failure_notices (
           task_id, error_key, error_text, failure_count,
           first_failed_at, last_failed_at
         ) VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           error_key = excluded.error_key,
           error_text = excluded.error_text,
           failure_count = 1,
           first_failed_at = excluded.first_failed_at,
           last_failed_at = excluded.last_failed_at`,
      ).run(taskId, errorKey, errorText, now, now);
    }
    return {
      notify: !repeat,
      state: toTaskFailureNotice(
        db
          .prepare('SELECT * FROM task_failure_notices WHERE task_id = ?')
          .get(taskId) as Record<string, unknown>,
      ),
    };
  })();
}

/** End a failure streak; returns it so the caller can announce recovery. */
export function clearTaskFailure(
  taskId: string,
): TaskFailureNoticeState | null {
  const db = requireDatabase();
  return db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM task_failure_notices WHERE task_id = ?')
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    db.prepare('DELETE FROM task_failure_notices WHERE task_id = ?').run(
      taskId,
    );
    return toTaskFailureNotice(row);
  })();
}

// ─── Usage event connections ───────────────────────────────

/** First writer wins, so a replayed usage event keeps its original connection. */
export function recordUsageEventConnection(
  eventId: string,
  providerId: string,
): void {
  if (!eventId || !providerId) return;
  requireDatabase()
    .prepare(
      `INSERT OR IGNORE INTO usage_event_connections (event_id, provider_id, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(eventId, providerId, new Date().toISOString());
}

export interface UsageCacheFilters {
  from: string;
  to: string;
  userId?: string;
  model?: string;
  agentId?: string;
  groupFolder?: string;
  source?: string;
}

export interface UsageCacheRateRow {
  key: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** cache_read ÷ (input + cache_creation + cache_read); null without input. */
  hitRate: number | null;
}

export function cacheHitRate(
  inputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number | null {
  const denominator = inputTokens + cacheCreationTokens + cacheReadTokens;
  return denominator > 0 ? cacheReadTokens / denominator : null;
}

function buildCacheWhere(filters: UsageCacheFilters): {
  sql: string;
  params: unknown[];
} {
  // Same filter semantics as the usage analytics in db.ts.
  const conditions = ['r.usage_date >= ?', 'r.usage_date <= ?'];
  const params: unknown[] = [filters.from, filters.to];
  const add = (column: string, value?: string) => {
    if (!value) return;
    conditions.push(`${column} = ?`);
    params.push(value);
  };
  add('r.user_id', filters.userId);
  add('r.model', filters.model);
  if (filters.agentId === '__main__') conditions.push('r.agent_id IS NULL');
  else add('r.agent_id', filters.agentId);
  add('r.group_folder', filters.groupFolder);
  add('r.source', filters.source);
  return { sql: conditions.join(' AND '), params };
}

/** Prompt-cache hit rates of usage_records by day, model and connection. */
export function getUsageCacheRates(filters: UsageCacheFilters): {
  summary: Omit<UsageCacheRateRow, 'key'>;
  daily: UsageCacheRateRow[];
  models: UsageCacheRateRow[];
  connections: UsageCacheRateRow[];
} {
  const db = requireDatabase();
  const where = buildCacheWhere(filters);
  const select = `COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(r.cache_creation_input_tokens), 0) AS cache_creation_tokens,
    COALESCE(SUM(r.cache_read_input_tokens), 0) AS cache_read_tokens`;
  const toRow = (row: Record<string, unknown>): UsageCacheRateRow => {
    const inputTokens = Number(row.input_tokens) || 0;
    const cacheCreationTokens = Number(row.cache_creation_tokens) || 0;
    const cacheReadTokens = Number(row.cache_read_tokens) || 0;
    return {
      key: String(row.key ?? ''),
      inputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      hitRate: cacheHitRate(inputTokens, cacheCreationTokens, cacheReadTokens),
    };
  };
  const grouped = (keyExpression: string, join = ''): UsageCacheRateRow[] =>
    (
      db
        .prepare(
          `SELECT ${keyExpression} AS key, ${select}
           FROM usage_records r ${join}
           WHERE ${where.sql}
           GROUP BY key ORDER BY key`,
        )
        .all(...where.params) as Array<Record<string, unknown>>
    ).map(toRow);
  const { key: _key, ...summary } = toRow(
    db
      .prepare(
        `SELECT '' AS key, ${select} FROM usage_records r WHERE ${where.sql}`,
      )
      .get(...where.params) as Record<string, unknown>,
  );
  return {
    summary,
    daily: grouped('r.usage_date'),
    models: grouped('r.model'),
    // Usage recorded before connections were tracked, or by a run without a
    // configured connection, groups under ''.
    connections: grouped(
      `COALESCE(c.provider_id, '')`,
      'LEFT JOIN usage_event_connections c ON c.event_id = r.event_id',
    ),
  };
}
