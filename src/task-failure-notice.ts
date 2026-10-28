import crypto from 'node:crypto';

import {
  clearTaskFailure,
  recordTaskFailure,
  type TaskFailureNoticeState,
} from './runtime-state-store.js';

/**
 * Reduce an error to what stays the same when a task keeps failing for the
 * same reason: durations, counts, ids, timestamps and paths with numbers
 * change on every run and must not make the same failure look new.
 */
export function normalizeTaskFailureError(error: string): string {
  return error
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '#',
    )
    .replace(/\b[0-9a-f]{12,}\b/gi, '#')
    .replace(
      /\b\d{4}-\d{2}-\d{2}(?:[t\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?\b/gi,
      '#',
    )
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '#')
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:ns|us|µs|ms|s|sec|seconds?|m|min|minutes?|h|hr|hours?)\b/gi,
      '#',
    )
    .replace(/\b\d{4,}\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 500);
}

function failureKey(error: string): string {
  return crypto
    .createHash('sha256')
    .update(normalizeTaskFailureError(error))
    .digest('hex')
    .slice(0, 32);
}

export type TaskRunNoticeDecision =
  | { kind: 'notify_failure' }
  | { kind: 'suppress_failure'; failureCount: number }
  | { kind: 'notify_recovery'; streak: TaskFailureNoticeState }
  | { kind: 'none' };

/**
 * Decide what a finished run tells the task owner. A failure is announced
 * once per streak and again only when its normalized error changes; the
 * first success after a streak announces the recovery once. A manual run is
 * always answered, because someone just asked for it.
 */
export function decideTaskRunNotice(input: {
  taskId: string;
  error: string | null;
  manualRun?: boolean;
}): TaskRunNoticeDecision {
  try {
    if (input.error) {
      const { notify, state } = recordTaskFailure(
        input.taskId,
        failureKey(input.error),
        input.error,
      );
      if (notify || input.manualRun) return { kind: 'notify_failure' };
      return { kind: 'suppress_failure', failureCount: state.failureCount };
    }
    const streak = clearTaskFailure(input.taskId);
    return streak ? { kind: 'notify_recovery', streak } : { kind: 'none' };
  } catch {
    // Bookkeeping must never cost a notice: fail open to the old behaviour.
    return input.error ? { kind: 'notify_failure' } : { kind: 'none' };
  }
}

export function formatTaskRecoveryNotice(
  taskLabel: string,
  streak: TaskFailureNoticeState,
): string {
  const error = streak.errorText.trim().split('\n')[0].slice(0, 200);
  return [
    `✅ 定时任务已恢复：${taskLabel}`,
    `此前连续失败 ${streak.failureCount} 次，最近一次错误：${error}`,
  ].join('\n');
}
