import { useChatStore } from '../stores/chat';
import { setWorkspaceLastAgent } from '../utils/workspaceLastAgent';

export function chatHref(folder: string, sessionId?: string | null): string {
  const base = `/chat/${folder}`;
  return sessionId ? `${base}?agent=${encodeURIComponent(sessionId)}` : base;
}

/** Navigation to an app path; a router `navigate` or a stable wrapper of it. */
export type NavigateToPath = (to: string) => unknown;

/**
 * Open a specific conversation in a workspace. `null` opens the main
 * conversation and clears the per-workspace "last session" memory, otherwise
 * ChatView's restore effect would immediately jump back to that session.
 */
export function openWorkspaceSession(
  navigate: NavigateToPath,
  group: { jid: string; folder: string },
  sessionId: string | null,
) {
  setWorkspaceLastAgent(group.jid, sessionId);
  useChatStore.getState().selectGroup(group.jid);
  navigate(chatHref(group.folder, sessionId));
}

/**
 * Whether the current history entry has one of this app's before it. The
 * router numbers its entries in `history.state.idx` (kept across reloads and
 * by replace navigations), so 0 is the first page of this app in the tab.
 * Back buttons step back when it does (cindy's goBackGuarded), so history
 * never piles up list → chat → list, and replace their page otherwise.
 */
export function hasAppEntryBefore(): boolean {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' && idx > 0;
}
