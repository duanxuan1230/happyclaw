import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { api } from '../../api/client';
import { cn } from '@/lib/utils';

export interface WorkdirPeer {
  workspace_jid: string;
  workspace_name: string;
  kind: 'main' | 'session' | 'task';
  session_id: string | null;
  session_name: string | null;
}

const POLL_MS = 15_000;

/**
 * Other conversations running a turn in this conversation's working
 * directory. Only reported: sessions may run in parallel by design, they can
 * just overwrite each other's edits. Polled while the page is visible.
 */
export function useWorkdirPeers(
  groupJid: string,
  agentId: string | null,
  enabled: boolean,
): { peers: WorkdirPeer[]; hiddenCount: number } {
  const [state, setState] = useState<{
    peers: WorkdirPeer[];
    hiddenCount: number;
  }>({ peers: [], hiddenCount: 0 });

  useEffect(() => {
    setState({ peers: [], hiddenCount: 0 });
    if (!enabled) return;
    let active = true;
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    const load = () => {
      if (document.hidden) return;
      api
        .get<{ peers: WorkdirPeer[]; hidden_count: number }>(
          `/api/groups/${encodeURIComponent(groupJid)}/workdir/peers${query}`,
        )
        .then((data) => {
          if (active) {
            setState({ peers: data.peers, hiddenCount: data.hidden_count });
          }
        })
        .catch(() => {
          // A failed check shows nothing rather than a stale warning.
          if (active) setState({ peers: [], hiddenCount: 0 });
        });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [groupJid, agentId, enabled]);

  return state;
}

function describePeer(peer: WorkdirPeer, groupJid: string): string {
  const conversation =
    peer.kind === 'main'
      ? '主会话'
      : peer.kind === 'task'
        ? '定时任务'
        : `会话「${peer.session_name || '新会话'}」`;
  return peer.workspace_jid === groupJid
    ? conversation
    : `工作区「${peer.workspace_name}」的${conversation}`;
}

/** Non-blocking hint that edits in a shared directory may collide. */
export function SharedWorkdirNotice({
  groupJid,
  peers,
  hiddenCount,
  className,
}: {
  groupJid: string;
  peers: WorkdirPeer[];
  hiddenCount: number;
  className?: string;
}) {
  const names = peers.map((peer) => describePeer(peer, groupJid));
  if (hiddenCount > 0) names.push(`${hiddenCount} 个其他会话`);
  return (
    <div
      role="status"
      className={cn(
        'flex min-h-9 shrink-0 items-center gap-2 border-b border-surface-border bg-warning/10 px-4 py-1.5 text-caption text-muted-foreground lg:px-5',
        className,
      )}
    >
      <TriangleAlert className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">
        另一个会话正在同一目录中运行，改动可能互相覆盖（{names.join('、')}
        ）。需要并行修改时，可以新建独立 worktree 会话。
      </span>
    </div>
  );
}
