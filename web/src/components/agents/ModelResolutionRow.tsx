import { Badge } from '@/components/ui/badge';
import type { AgentModelResolution } from '@/types';

const SOURCE_LABELS: Record<string, string> = {
  session: '会话手选',
  agent: '智能体绑定',
  owner_main: '跟随主智能体',
  system_main: '跟随主 HappyClaw',
  workspace_env: '工作区环境变量',
  none: '未设置模型',
  // Older servers: the global default and the automatic pool.
  default: '全局默认',
  single: '唯一启用',
  pool: '自动池',
};

/**
 * An unsaved model binding to resolve instead of the saved one. Callers keep
 * it referentially stable (useMemo): the preview refetches when it changes.
 */
export interface ModelBinding {
  model_config_id: string | null;
  model: string | null;
}

/** The resolution from an effective-capabilities response, if it has one. */
export function readModelResolution(
  response: unknown,
): AgentModelResolution | null {
  const value = (response as { model_resolution?: AgentModelResolution })
    ?.model_resolution;
  return value && typeof value.source === 'string' ? value : null;
}

function describe(resolution: AgentModelResolution): string {
  if (resolution.connection_missing) return '绑定的连接不存在，运行会失败';
  if (resolution.model_config_id) {
    return [resolution.model_config_name, resolution.model]
      .filter(Boolean)
      .join(' · ');
  }
  if (resolution.source === 'workspace_env') {
    return '使用工作区自带的 Provider 环境变量';
  }
  return '没有可用的模型连接，无法运行';
}

/**
 * The connection and model a run of this Agent uses and which step of the
 * order chose it: conversation pick, the Agent's own binding, the workspace
 * env, the owner's main Agent or the system main HappyClaw.
 */
export function ModelResolutionRow({
  resolution,
}: {
  resolution: AgentModelResolution | null;
}) {
  if (!resolution) return null;
  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[120px_1fr] sm:items-start">
      <div className="text-caption font-medium text-muted-foreground">模型</div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span
          className={
            resolution.connection_missing
              ? 'text-caption text-warning'
              : resolution.source === 'none'
                ? 'text-caption text-error'
                : 'min-w-0 text-label break-all text-foreground'
          }
        >
          {describe(resolution)}
        </span>
        <Badge variant="neutral">{SOURCE_LABELS[resolution.source]}</Badge>
      </div>
    </div>
  );
}
