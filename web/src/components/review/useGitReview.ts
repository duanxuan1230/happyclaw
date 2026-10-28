import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../api/client';
import { useChatStore } from '../../stores/chat';
import type {
  GitDiffResponse,
  GitReviewFile,
  GitStatusResponse,
  ReviewLoad,
  ReviewRequestFailure,
} from './types';

// The backend runs several git commands per request, each capped at 15s;
// the client's 8s default would give up on a large repository first.
const REVIEW_REQUEST_TIMEOUT_MS = 30_000;

export function toReviewFailure(error: unknown): ReviewRequestFailure {
  if (error && typeof error === 'object' && 'status' in error) {
    const { status, message } = error as { status: unknown; message?: unknown };
    if (typeof status === 'number') {
      return { status, message: typeof message === 'string' ? message : '' };
    }
  }
  return {
    status: 0,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function reviewRuntimeJid(
  groupJid: string,
  agentId: string | null,
): string {
  return agentId ? `${groupJid}#agent:${agentId}` : groupJid;
}

export function gitStatusUrl(groupJid: string, agentId: string | null) {
  const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
  return `/api/groups/${encodeURIComponent(groupJid)}/git/status${query}`;
}

export function gitDiffUrl(
  groupJid: string,
  agentId: string | null,
  file: Pick<GitReviewFile, 'path' | 'orig_path'>,
) {
  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  params.set('path', file.path);
  if (file.orig_path) params.set('orig_path', file.orig_path);
  return `/api/groups/${encodeURIComponent(groupJid)}/git/diff?${params}`;
}

interface Request {
  seq: number;
  controller: AbortController | null;
}

/** Supersede the previous request and return a guard for the new one. */
function beginRequest(ref: { current: Request }) {
  ref.current.controller?.abort();
  const controller = new AbortController();
  const seq = ref.current.seq + 1;
  ref.current = { seq, controller };
  return {
    signal: controller.signal,
    isCurrent: () => ref.current.seq === seq,
  };
}

function cancelRequest(ref: { current: Request }) {
  ref.current.controller?.abort();
  ref.current = { seq: ref.current.seq + 1, controller: null };
}

/**
 * Status and diff of one conversation's checkout. State belongs to a single
 * (groupJid, agentId) scope: the caller remounts it with a `key` when the
 * scope changes. Responses of superseded or cancelled requests are dropped.
 */
export function useGitReview(groupJid: string, agentId: string | null) {
  const [status, setStatus] = useState<ReviewLoad<GitStatusResponse>>({
    kind: 'loading',
  });
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [selected, setSelected] = useState<GitReviewFile | null>(null);
  const [diff, setDiff] = useState<ReviewLoad<GitDiffResponse> | null>(null);
  const [diffRefreshing, setDiffRefreshing] = useState(false);

  const statusRequest = useRef<Request>({ seq: 0, controller: null });
  const diffRequest = useRef<Request>({ seq: 0, controller: null });
  const selectedRef = useRef<GitReviewFile | null>(null);

  const loadStatus = useCallback(async () => {
    const request = beginRequest(statusRequest);
    setStatusRefreshing(true);
    try {
      const data = await apiFetch<GitStatusResponse>(
        gitStatusUrl(groupJid, agentId),
        { signal: request.signal, timeoutMs: REVIEW_REQUEST_TIMEOUT_MS },
      );
      if (request.isCurrent()) setStatus({ kind: 'loaded', data });
    } catch (error) {
      if (request.isCurrent()) {
        setStatus({ kind: 'failed', failure: toReviewFailure(error) });
      }
    } finally {
      if (request.isCurrent()) setStatusRefreshing(false);
    }
  }, [groupJid, agentId]);

  const loadDiff = useCallback(
    async (file: GitReviewFile) => {
      const request = beginRequest(diffRequest);
      setDiffRefreshing(true);
      try {
        const data = await apiFetch<GitDiffResponse>(
          gitDiffUrl(groupJid, agentId, file),
          { signal: request.signal, timeoutMs: REVIEW_REQUEST_TIMEOUT_MS },
        );
        if (request.isCurrent()) setDiff({ kind: 'loaded', data });
      } catch (error) {
        if (request.isCurrent()) {
          setDiff({ kind: 'failed', failure: toReviewFailure(error) });
        }
      } finally {
        if (request.isCurrent()) setDiffRefreshing(false);
      }
    },
    [groupJid, agentId],
  );

  const refresh = useCallback(() => {
    void loadStatus();
    if (selectedRef.current) void loadDiff(selectedRef.current);
  }, [loadStatus, loadDiff]);

  const openFile = useCallback(
    (file: GitReviewFile) => {
      selectedRef.current = file;
      setSelected(file);
      setDiff({ kind: 'loading' });
      void loadDiff(file);
    },
    [loadDiff],
  );

  const closeFile = useCallback(() => {
    cancelRequest(diffRequest);
    selectedRef.current = null;
    setSelected(null);
    setDiff(null);
    setDiffRefreshing(false);
  }, []);

  const retryDiff = useCallback(() => {
    const file = selectedRef.current;
    if (!file) return;
    setDiff({ kind: 'loading' });
    void loadDiff(file);
  }, [loadDiff]);

  useEffect(() => {
    void loadStatus();
    return () => {
      cancelRequest(statusRequest);
      cancelRequest(diffRequest);
    };
  }, [loadStatus]);

  // A finished run is when the Agent's edits land; refresh then, never poll.
  const runtimeJid = reviewRuntimeJid(groupJid, agentId);
  const running = useChatStore((s) => !!s.activeRuns[runtimeJid]);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) refresh();
    wasRunning.current = running;
  }, [running, refresh]);

  return {
    status,
    statusRefreshing,
    selected,
    diff,
    diffRefreshing,
    refresh,
    openFile,
    closeFile,
    retryDiff,
  };
}
