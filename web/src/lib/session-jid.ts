// A session's JID: the workspace's for its main session, `<workspace>#agent:<id>`
// for the others.

const MARKER = '#agent:';

export function sessionJidOf(
  workspaceJid: string,
  sessionId: string | null | undefined,
): string {
  return sessionId ? `${workspaceJid}${MARKER}${sessionId}` : workspaceJid;
}

/** The session id in a session JID, or null for a workspace's main session. */
export function sessionIdOf(sessionJid: string): string | null {
  const marker = sessionJid.indexOf(MARKER);
  return marker === -1 ? null : sessionJid.slice(marker + MARKER.length);
}

export function workspaceJidOf(sessionJid: string): string {
  const marker = sessionJid.indexOf(MARKER);
  return marker === -1 ? sessionJid : sessionJid.slice(0, marker);
}
