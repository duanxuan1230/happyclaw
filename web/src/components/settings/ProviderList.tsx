import {
  Activity,
  Copy,
  Loader2,
  MoreHorizontal,
  PlugZap,
  Plus,
  RotateCcw,
  Settings2,
  Star,
  Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { IconButton } from '@/components/common/IconButton';
import { ListGroup, ListRow } from '@/components/common/ListRow';
import { ResponsiveMenu } from '@/components/common/ResponsiveMenu';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { effectiveProviderModels } from '@/lib/model-providers';
import { cn } from '@/lib/utils';
import {
  connectionKind,
  connectionKindLabel,
  connectionStatus,
} from './model-connections';
import type { ProviderWithHealth, ProviderHealthStatus } from './types';
import { UsageBars } from './UsageBars';
import { vendorOfConnection } from '../brand/vendor';
import { VendorTile } from '../brand/VendorTile';

interface ProviderListProps {
  providers: ProviderWithHealth[];
  /** The configuration unselected conversations run on; null = automatic pool. */
  defaultModelConfigId: string | null;
  /** Open the connection's detail: models, test, settings. */
  onManage: (provider: ProviderWithHealth) => void;
  onTest: (provider: ProviderWithHealth) => void;
  onDelete: (provider: ProviderWithHealth) => void;
  onToggle: (provider: ProviderWithHealth) => void;
  /** Make the provider the default, or clear it when it already is. */
  onSetDefault: (provider: ProviderWithHealth) => void;
  onResetHealth: (provider: ProviderWithHealth) => void;
  onDuplicate: (provider: ProviderWithHealth) => void;
  onAdd: () => void;
  togglingId: string | null;
  deletingId: string | null;
  testingId: string | null;
  disabled: boolean;
}

/** 健康指示灯颜色：运行时健康，与连接测试结果是两回事 */
function healthDotClass(
  health: ProviderHealthStatus | null,
  enabled: boolean,
): string {
  if (!enabled || !health) return 'bg-faint-foreground';
  if (health.healthy) return 'bg-success';
  return health.consecutiveErrors > 0 ? 'bg-error' : 'bg-warning';
}

/** 类型图标 + 健康指示灯 */
function ProviderMedia({ provider }: { provider: ProviderWithHealth }) {
  const vendor = vendorOfConnection({
    kind: provider.hasCodexOAuthCredentials
      ? 'codex'
      : provider.type === 'official'
        ? 'official'
        : 'third_party',
    presetId: provider.presetId,
    baseUrl: provider.anthropicBaseUrl,
    model: provider.anthropicModel,
  });
  return (
    <span className="relative flex">
      <VendorTile
        vendor={vendor}
        name={provider.name}
        className="size-8 rounded-lg"
      />
      <span
        aria-hidden="true"
        className={cn(
          'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface-raised',
          healthDotClass(provider.health, provider.enabled),
        )}
      />
    </span>
  );
}

function hasCredential(provider: ProviderWithHealth): boolean {
  return (
    provider.hasClaudeOAuthCredentials ||
    provider.hasCodexOAuthCredentials ||
    provider.hasClaudeCodeOauthToken ||
    provider.hasAnthropicApiKey ||
    provider.hasAnthropicAuthToken
  );
}

/** Where the connection's models come from, in one short line. */
function sourceText(provider: ProviderWithHealth): string | null {
  const kind = connectionKind(provider);
  if (kind === 'chatgpt') {
    return (
      provider.codexOAuthCredentialsEmail ?? 'ChatGPT 订阅网关（服务内嵌）'
    );
  }
  if (kind === 'claude_subscription') {
    return provider.claudeOAuthAccountEmail ?? null;
  }
  return kind === 'anthropic_api' ? null : provider.anthropicBaseUrl || null;
}

export function ProviderList({
  providers,
  defaultModelConfigId,
  onManage,
  onTest,
  onDelete,
  onToggle,
  onSetDefault,
  onResetHealth,
  onDuplicate,
  onAdd,
  togglingId,
  deletingId,
  testingId,
  disabled,
}: ProviderListProps) {
  // Below `sm` the row hides its default and reset buttons (`max-sm:hidden`).
  const narrow = useMediaQuery('(max-width: 639px)');
  if (providers.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-surface-border px-6 py-10 text-center">
        <p className="text-body text-muted-foreground">
          还没有模型连接。添加一个 Claude / ChatGPT 订阅、API Key
          或兼容地址即可开始对话。
        </p>
        <Button onClick={onAdd} disabled={disabled}>
          <Plus />
          添加模型连接
        </Button>
      </div>
    );
  }

  return (
    <ListGroup>
      {providers.map((provider) => {
        const toggling = togglingId === provider.id;
        const deleting = deletingId === provider.id;
        const testing = testingId === provider.id;
        const rowDisabled = disabled || toggling || deleting;
        const health = provider.health;
        const kind = connectionKind(provider);
        const canDuplicate = kind === 'preset' || kind === 'custom';
        const canResetHealth = !!health && !health.healthy && provider.enabled;
        const isDefault = provider.id === defaultModelConfigId;
        const status = connectionStatus(provider);
        const modelCount =
          kind === 'chatgpt' ? 0 : effectiveProviderModels(provider).length;
        const source = sourceText(provider);
        const defaultTitle = isDefault
          ? '取消默认：未手动选择模型的对话恢复为在已启用配置间自动轮换'
          : provider.enabled
            ? '设为默认：未手动选择模型的对话都使用它，不再自动轮换，也不会在账号间故障转移'
            : '设为默认（将同时启用该配置）：未手动选择模型的对话都使用它，不再自动轮换，也不会在账号间故障转移';

        return (
          <div key={provider.id} className="min-w-0">
            <ListRow
              media={<ProviderMedia provider={provider} />}
              onClick={() => onManage(provider)}
              aria-label={`管理「${provider.name}」`}
              title={
                <span
                  className={cn(!provider.enabled && 'text-muted-foreground')}
                >
                  {provider.name}
                </span>
              }
              badges={
                <>
                  <Badge variant="neutral" className="max-sm:hidden">
                    {connectionKindLabel(provider)}
                  </Badge>
                  {isDefault && <Badge variant="info">默认</Badge>}
                  {health && provider.enabled && !health.healthy && (
                    <Badge variant="error">不健康</Badge>
                  )}
                </>
              }
              description={
                <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <Badge
                    variant="outline"
                    dot={status.tone}
                    title={status.hint}
                  >
                    {testing ? '测试中…' : status.label}
                  </Badge>
                  {/* Touch has no hover title, so the hint is spelled out. */}
                  {status.hint && !testing && (
                    <span className="pointer-fine:hidden">{status.hint}</span>
                  )}
                  {source && (
                    <span
                      className="max-w-60 truncate font-mono"
                      title={source}
                    >
                      {source}
                    </span>
                  )}
                  {provider.anthropicModel && (
                    <span className="font-mono">{provider.anthropicModel}</span>
                  )}
                  {modelCount > 1 && <span>{modelCount} 个模型</span>}
                  {!hasCredential(provider) && (
                    <span className="text-warning">未配置凭据</span>
                  )}
                  {health &&
                    provider.enabled &&
                    health.consecutiveErrors > 0 && (
                      <span className="text-error">
                        连续错误 {health.consecutiveErrors}
                      </span>
                    )}
                </span>
              }
              meta={
                health &&
                provider.enabled &&
                health.activeSessionCount > 0 && (
                  <span className="hidden items-center gap-1 sm:inline-flex">
                    <Activity className="size-3.5" aria-hidden="true" />
                    {health.activeSessionCount} 活跃会话
                  </span>
                )
              }
              actions={
                <>
                  {canResetHealth && (
                    <IconButton
                      label="重置健康状态"
                      icon={<RotateCcw />}
                      onClick={() => onResetHealth(provider)}
                      disabled={disabled}
                      className="max-sm:hidden"
                    />
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant={isDefault ? 'secondary' : 'ghost'}
                    aria-pressed={isDefault}
                    title={defaultTitle}
                    disabled={rowDisabled}
                    onClick={() => onSetDefault(provider)}
                    className="h-7 px-2 text-xs max-sm:hidden"
                  >
                    默认
                  </Button>
                  <Switch
                    checked={provider.enabled}
                    disabled={rowDisabled || isDefault}
                    title={
                      isDefault
                        ? '默认模型不能禁用，请先取消默认或改选其他默认模型'
                        : '是否加入自动池'
                    }
                    onCheckedChange={() => onToggle(provider)}
                    aria-label={
                      provider.enabled ? '禁用模型配置' : '启用模型配置'
                    }
                    className="mx-1.5"
                  />
                  <ResponsiveMenu
                    title={`「${provider.name}」的操作`}
                    groups={[
                      [
                        {
                          label: '管理',
                          icon: Settings2,
                          onSelect: () => onManage(provider),
                        },
                        {
                          label: '测试连接',
                          icon: PlugZap,
                          disabled: testing,
                          onSelect: () => onTest(provider),
                        },
                        // 窄屏把行内按钮收进菜单，给名称留出空间
                        ...(narrow
                          ? [
                              {
                                label: isDefault ? '取消默认' : '设为默认',
                                icon: Star,
                                onSelect: () => onSetDefault(provider),
                              },
                            ]
                          : []),
                        ...(narrow && canResetHealth
                          ? [
                              {
                                label: '重置健康状态',
                                icon: RotateCcw,
                                disabled,
                                onSelect: () => onResetHealth(provider),
                              },
                            ]
                          : []),
                        ...(canDuplicate
                          ? [
                              {
                                label: '复制',
                                icon: Copy,
                                onSelect: () => onDuplicate(provider),
                              },
                            ]
                          : []),
                      ],
                      [
                        {
                          label: '删除',
                          icon: Trash2,
                          destructive: true,
                          onSelect: () => onDelete(provider),
                        },
                      ],
                    ]}
                    trigger={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="更多操作"
                        disabled={rowDisabled}
                      >
                        {deleting || testing ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <MoreHorizontal />
                        )}
                      </Button>
                    }
                  />
                </>
              }
            />

            {/* 订阅用量：Claude OAuth 与 ChatGPT 订阅 */}
            {(provider.type === 'official' ||
              provider.hasCodexOAuthCredentials) && (
              <UsageBars
                providerId={provider.id}
                providerVersion={provider.updatedAt}
                className="-mt-1 px-4 pb-3 sm:pl-15"
              />
            )}
          </div>
        );
      })}
    </ListGroup>
  );
}
