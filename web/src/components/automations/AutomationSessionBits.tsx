import { useMemo } from 'react';
import { Pause, PanelRight, Play, Timer, Trash2 } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Automation } from '../../lib/automation';
import {
  automationUnreadTone,
  automationsForSession,
  boundAutomationsOf,
  isAutomationRunning,
  nextRunText,
} from '../../lib/automation-presentation';
import type { AutomationSessionGroup } from '../../lib/session-presentation';
import { sessionJidOf } from '../../lib/session-jid';
import { useAutomationsStore } from '../../stores/automations';
import { useShellStore } from '../../stores/shell';
import type { AgentInfo } from '../../types';
import type { NavigateToPath } from '../../lib/chat-navigation';
import {
  automationHref,
  deleteAutomationWithConfirm,
  runAutomationNow,
  setAutomationEnabled,
} from './automation-actions';

// Pieces of the automations list, the session tree and the chat header.

/** The red or green dot of unread runs. */
export function UnreadDot({
  automation,
  className,
}: {
  automation: Automation;
  className?: string;
}) {
  const tone = automationUnreadTone(automation);
  if (!tone) return null;
  return (
    <span
      role="img"
      aria-label={
        tone === 'error'
          ? `${automation.unreadRuns} 次未读运行，最近一次失败`
          : `${automation.unreadRuns} 次未读运行`
      }
      data-tone={tone}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        tone === 'error' ? 'bg-error' : 'bg-success',
        className,
      )}
    />
  );
}

/** Automations whose runs come to a session, for the chat header. */
export function useSessionAutomations(
  sessionJid: string,
  generatedBy?: string | null,
): Automation[] {
  const automations = useAutomationsStore((s) => s.automations);
  return useMemo(
    () => automationsForSession(automations, sessionJid, generatedBy),
    [automations, sessionJid, generatedBy],
  );
}

/** The timer mark's automations for each session row of a workspace. */
export function useBoundAutomations(
  workspaceJid: string,
): (session: AgentInfo | null) => Automation[] {
  const automations = useAutomationsStore((s) => s.automations);
  return useMemo(
    () => (session) =>
      boundAutomationsOf(
        automations,
        sessionJidOf(workspaceJid, session?.id),
        session?.automation_id,
      ),
    [automations, workspaceJid],
  );
}

/** What an automation's group row in the session tree shows and toggles. */
export function useAutomationGroup(group: AutomationSessionGroup) {
  const automation = useAutomationsStore((s) =>
    s.automations.find((item) => item.id === group.automationId),
  );
  const expanded = useShellStore(
    (s) => !!s.expandedAutomationGroups[group.automationId],
  );
  const setExpanded = useShellStore((s) => s.setAutomationGroupExpanded);
  return {
    automation,
    name: automation?.name ?? group.name,
    running:
      (!!automation && isAutomationRunning(automation)) ||
      group.sessions.some((session) => session.status === 'running'),
    expanded,
    toggle: () => setExpanded(group.automationId, !expanded),
  };
}

function markText(automation: Automation): string {
  if (automation.status !== 'active') return '已暂停';
  return nextRunText(automation) ?? '没有计划中的运行';
}

/** The timer mark on a session row bound to automations. */
export function BoundAutomationMark({
  automations,
  className,
}: {
  automations: Automation[];
  className?: string;
}) {
  if (automations.length === 0) return null;
  const label = `绑定了自动化：${automations.map((item) => item.name).join('、')}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className={cn(
            'inline-flex shrink-0 text-faint-foreground',
            className,
          )}
        >
          <Timer className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <ul className="space-y-0.5">
          {automations.map((automation) => (
            <li key={automation.id}>
              {automation.name} · {markText(automation)}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/** ⋯ items of an automation group in the session tree. */
export function AutomationMenuItems({
  automation,
  navigate,
}: {
  automation: Automation;
  navigate: NavigateToPath;
}) {
  const enabled = automation.status === 'active';
  return (
    <>
      <DropdownMenuItem onClick={() => navigate(automationHref(automation.id))}>
        <PanelRight />
        查看详情
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void runAutomationNow(automation.id)}>
        <Play />
        立即运行
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => void setAutomationEnabled(automation.id, !enabled)}
      >
        {enabled ? <Pause /> : <Play />}
        {enabled ? '暂停' : '启用'}
      </DropdownMenuItem>
      <DropdownMenuItem
        variant="destructive"
        onClick={() => void deleteAutomationWithConfirm(automation)}
      >
        <Trash2 />
        删除自动化
      </DropdownMenuItem>
    </>
  );
}
