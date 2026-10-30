import { useEffect, useState } from 'react';
import { Loader2, MoreHorizontal, RefreshCw, Star, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ResponsiveMenu } from '@/components/common/ResponsiveMenu';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import {
  MODEL_EFFORTS,
  effectiveProviderModels,
  getModelPreset,
  mergeDiscoveredModels,
  splitOneMillionSuffix,
  withOneMillionSuffix,
  type ModelEffort,
  type ProviderModelEntry,
} from '@/lib/model-providers';
import { cn } from '@/lib/utils';
import {
  confirmProtocolChange,
  discoverModels,
  effortLabel,
  errorCopy,
  modelInUseAgents,
  presetModelName,
  updateConnection,
} from './model-connections';
import { ManualModelInput, OneMillionToggle } from './ModelPicker';
import { getErrorMessage, type UnifiedProviderPublic } from './types';

interface ConnectionModelListProps {
  provider: UnifiedProviderPublic;
  /** The connection may run without a default model (it routes names itself). */
  allowNoDefault: boolean;
  onSaved: (provider: UnifiedProviderPublic) => void;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
}

/**
 * The models a connection offers. Showing, hiding, efforts and additions save
 * at once and leave running conversations alone; a new default model is a
 * protocol change and asks first.
 */
export function ConnectionModelList({
  provider,
  allowNoDefault,
  onSaved,
  setNotice,
  setError,
}: ConnectionModelListProps) {
  const [models, setModels] = useState<ProviderModelEntry[]>(() =>
    effectiveProviderModels(provider),
  );
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const preset = getModelPreset(provider.presetId);
  const defaultModel = provider.anthropicModel;

  useEffect(() => {
    setModels(effectiveProviderModels(provider));
    // The stored list changes only with the provider record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, provider.updatedAt]);

  const save = async (
    next: ProviderModelEntry[],
    nextDefault: string = defaultModel,
  ): Promise<boolean> => {
    const defaultChanged = nextDefault !== defaultModel;
    // A model taken out (a 1M switch renames, so it takes one out too) stops
    // the runners that may be on it, like a new default does.
    const removed = models.some(
      (entry) => !next.some((other) => other.id === entry.id),
    );
    if (
      (defaultChanged || removed) &&
      !(await confirmProtocolChange(provider))
    ) {
      return false;
    }
    const previous = models;
    setModels(next);
    setBusy(true);
    try {
      const saved = await updateConnection(provider.id, {
        models: next,
        ...(defaultChanged ? { anthropicModel: nextDefault } : {}),
      });
      setModels(effectiveProviderModels(saved));
      onSaved(saved);
      return true;
    } catch (err) {
      setModels(previous);
      const agents = modelInUseAgents(err);
      setError(
        agents
          ? `这个模型正被智能体「${agents.join('」「')}」使用。先在智能体设置里改用其他模型，再删除或改名。`
          : getErrorMessage(err, '保存模型列表失败'),
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const update = (id: string, patch: Partial<ProviderModelEntry>) =>
    save(
      models.map((entry) => {
        if (entry.id !== id) return entry;
        const next: ProviderModelEntry = { ...entry, ...patch };
        if (!next.hidden) delete next.hidden;
        if (!next.effort) delete next.effort;
        return next;
      }),
    );

  const toggleOneMillion = (entry: ProviderModelEntry) => {
    const { model: base, oneMillion } = splitOneMillionSuffix(entry.id);
    const nextId = withOneMillionSuffix(base, !oneMillion);
    void save(
      models.map((other) =>
        other.id === entry.id ? { ...other, id: nextId } : other,
      ),
      entry.id === defaultModel ? nextId : defaultModel,
    );
  };

  /** Same model with or without `[1m]` counts as already listed. */
  const listed = (id: string) => {
    const base = splitOneMillionSuffix(id).model;
    return models.find(
      (entry) => splitOneMillionSuffix(entry.id).model === base,
    );
  };

  const addManual = async (id: string) => {
    const existing = listed(id);
    if (existing) {
      setError(`列表里已经有 ${existing.id}`);
      return false;
    }
    const added = await save([...models, { id }]);
    if (added) setNotice(`已添加模型 ${id}`);
    return added;
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const result = await discoverModels({ providerId: provider.id });
      if (!result.ok) {
        const copy = errorCopy(result.code);
        setError(`没能获取模型列表：${copy.title}。${copy.hint}`);
        return;
      }
      const merged = mergeDiscoveredModels(
        models,
        result.models.map((model) => model.id),
      );
      if (merged.added.length === 0) {
        setNotice('没有发现新模型');
        return;
      }
      if (await save(merged.models)) {
        setNotice(
          `新增 ${merged.added.length} 个模型，默认隐藏；在列表里打开即可出现在聊天选择器中`,
        );
      }
    } catch (err) {
      setError(getErrorMessage(err, '获取模型列表失败'));
    } finally {
      setRefreshing(false);
    }
  };

  const disabled = busy || refreshing;

  return (
    <div className="space-y-3">
      {models.length === 0 ? (
        <p className="rounded-lg px-3 py-4 text-caption text-muted-foreground ring-1 ring-surface-border">
          {defaultModel
            ? '还没有模型。'
            : '没有指定模型：Claude Code 自己选择模型名，由服务端决定实际模型。可以刷新或手动添加。'}
        </p>
      ) : (
        <ul
          aria-label="连接的模型"
          className="divide-y divide-surface-border overflow-hidden rounded-lg ring-1 ring-surface-border"
        >
          {models.map((entry) => {
            const isDefault = entry.id === defaultModel;
            const { oneMillion } = splitOneMillionSuffix(entry.id);
            const name = presetModelName(preset, entry.id);
            return (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2"
              >
                <Switch
                  checked={!entry.hidden}
                  onCheckedChange={(checked) =>
                    void update(entry.id, { hidden: !checked })
                  }
                  disabled={disabled || isDefault}
                  title={
                    isDefault
                      ? '默认模型总是显示'
                      : '是否出现在聊天的模型选择里'
                  }
                  aria-label={`在聊天中显示 ${entry.id}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn(
                        'truncate font-mono text-caption',
                        entry.hidden
                          ? 'text-muted-foreground'
                          : 'text-foreground',
                      )}
                    >
                      {entry.id}
                    </span>
                    {isDefault && <Badge variant="info">默认</Badge>}
                  </div>
                  {(name || entry.hidden) && (
                    <div className="truncate text-micro text-muted-foreground">
                      {[name, entry.hidden ? '已隐藏' : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  )}
                </div>
                {/* Phones put the controls on their own line under the name. */}
                <div className="flex shrink-0 items-center gap-1.5 max-sm:w-full max-sm:pl-12">
                  <NativeSelect
                    size="sm"
                    value={entry.effort ?? ''}
                    onChange={(event) =>
                      void update(entry.id, {
                        effort: (event.target.value || undefined) as
                          | ModelEffort
                          | undefined,
                      })
                    }
                    disabled={disabled}
                    aria-label={`${entry.id} 的推理档位`}
                    title="下次启动会话时生效；智能体设置了推理档位时以智能体为准"
                    className="w-28 font-mono text-caption"
                  >
                    <NativeSelectOption value="">档位默认</NativeSelectOption>
                    {MODEL_EFFORTS.map((effort) => (
                      <NativeSelectOption key={effort} value={effort}>
                        {effortLabel(effort)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <OneMillionToggle
                    id={entry.id}
                    on={oneMillion}
                    onToggle={() => toggleOneMillion(entry)}
                    disabled={disabled}
                  />
                  <ResponsiveMenu
                    title={`${entry.id} 的操作`}
                    groups={[
                      [
                        ...(!isDefault
                          ? [
                              {
                                label: '设为默认模型',
                                icon: Star,
                                onSelect: () =>
                                  void save(
                                    models.map((other) =>
                                      other.id === entry.id
                                        ? { id: other.id, effort: other.effort }
                                        : other,
                                    ),
                                    entry.id,
                                  ),
                              },
                            ]
                          : []),
                        ...(isDefault && allowNoDefault
                          ? [
                              {
                                label: '不再指定默认模型',
                                icon: Star,
                                onSelect: () => void save(models, ''),
                              },
                            ]
                          : []),
                      ],
                      isDefault
                        ? []
                        : [
                            {
                              label: '从连接中删除',
                              icon: Trash2,
                              destructive: true,
                              onSelect: () =>
                                void save(
                                  models.filter(
                                    (other) => other.id !== entry.id,
                                  ),
                                ),
                            },
                          ],
                    ]}
                    trigger={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${entry.id} 的更多操作`}
                        disabled={disabled}
                      >
                        <MoreHorizontal />
                      </Button>
                    }
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {models.length > 0 && (
        <p className="text-caption text-muted-foreground">
          推理档位下次启动会话时生效；智能体设置了推理档位时以智能体为准。
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <ManualModelInput
          placeholder="手动添加模型名"
          onAdd={addManual}
          disabled={disabled}
        />
        <Button
          variant="ghost"
          onClick={() => void refresh()}
          disabled={disabled}
          title="从服务商获取模型列表：只添加新模型，不删除已有的"
        >
          {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          刷新模型列表
        </Button>
      </div>
    </div>
  );
}
