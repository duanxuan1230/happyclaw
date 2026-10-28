import { useMemo } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsGroup } from '@/components/settings/SettingsLayout';
import {
  AgentModelSelect,
  hasModelLists,
  modelBindingChanges,
} from '@/components/settings/AgentModelSelect';
import { useMcpServersStore } from '@/stores/mcp-servers';
import { useSkillsStore } from '@/stores/skills';
import type {
  AgentEffortLevel,
  AgentProfile,
  AgentProfileRuntimePolicy,
  ModelConfigOption,
} from '@/types';
import { normalizeMcpPolicyReferences } from '@/utils/mcp-servers';
import {
  AGENT_EFFORT_OPTIONS,
  buildHostSkillOptions,
  buildManagedSkillOptions,
  buildMcpSelectionOptions,
  getHostSkillPolicy,
  hostSkillPolicyForMode,
  skillSelectionError,
  type RuntimePolicyMode,
  type SkillSourcePolicy,
} from '@/utils/agent-runtime-policy';
import { AgentControlRow, AgentSubheading } from './AgentSection';
import { AgentSkillsPolicyEditor } from './AgentSkillsPolicyEditor';
import { PolicyResourcePicker } from './PolicyResourcePicker';

/**
 * What the Agent page and the main HappyClaw settings both edit: the model
 * binding, reasoning effort and every capability source. Both save it the
 * same way, only when the user presses save.
 */
export interface AgentCapabilityFormValue {
  /** 'inherit' while the configuration is chosen automatically. */
  modelConfigId: string;
  /** The model within that configuration; null runs its default. */
  model: string | null;
  effort: AgentEffortLevel;
  skills: SkillSourcePolicy;
  hostSkills: SkillSourcePolicy;
  mcp: SkillSourcePolicy;
}

export function capabilityFormFromProfile(
  profile: Pick<
    AgentProfile,
    'model_config_id' | 'model' | 'runtime_policy' | 'effective_runtime_policy'
  >,
): AgentCapabilityFormValue {
  const policy = profile.runtime_policy;
  return {
    modelConfigId: profile.model_config_id ?? 'inherit',
    model: profile.model ?? null,
    effort: policy.reasoning?.effort ?? 'inherit',
    skills: { mode: policy.skills.mode, ids: [...policy.skills.ids] },
    hostSkills: getHostSkillPolicy(policy, profile.effective_runtime_policy),
    mcp: {
      mode: policy.mcp.mode,
      ids: normalizeMcpPolicyReferences(policy.mcp.ids),
    },
  };
}

/** The runtime-policy part of the form, as the server stores it. */
export function capabilityFormPolicy(
  value: AgentCapabilityFormValue,
): Pick<AgentProfileRuntimePolicy, 'reasoning' | 'skills' | 'mcp'> {
  return {
    reasoning: { effort: value.effort },
    skills: {
      mode: value.skills.mode,
      ids: value.skills.ids,
      host: { mode: value.hostSkills.mode, ids: value.hostSkills.ids },
    },
    mcp: { mode: value.mcp.mode, ids: value.mcp.ids },
  };
}

function capabilityFormErrors(value: AgentCapabilityFormValue) {
  return {
    managed: skillSelectionError(' HappyClaw Skill', value.skills),
    host: skillSelectionError('宿主机 Skill', value.hostSkills),
  };
}

export function capabilityFormError(
  value: AgentCapabilityFormValue,
): string | null {
  const errors = capabilityFormErrors(value);
  return errors.managed ?? errors.host;
}

/** The (configuration, model) part of a save; see modelBindingChanges. */
export function capabilityFormModelChanges(
  saved: Pick<AgentProfile, 'model_config_id' | 'model'>,
  value: AgentCapabilityFormValue,
) {
  return modelBindingChanges(
    saved,
    capabilityFormBinding(value).model_config_id,
    value.model,
  );
}

/** The model binding the form would save, as the profile stores it. */
export function capabilityFormBinding(
  value: Pick<AgentCapabilityFormValue, 'modelConfigId' | 'model'>,
) {
  const modelConfigId =
    value.modelConfigId === 'inherit' ? null : value.modelConfigId;
  return {
    model_config_id: modelConfigId,
    model: modelConfigId ? value.model : null,
  };
}

export function sameCapabilityForm(
  a: AgentCapabilityFormValue,
  b: AgentCapabilityFormValue,
): boolean {
  return (
    JSON.stringify({
      ...capabilityFormBinding(a),
      ...capabilityFormPolicy(a),
    }) ===
    JSON.stringify({
      ...capabilityFormBinding(b),
      ...capabilityFormPolicy(b),
    })
  );
}

export function AgentCapabilityForm({
  value,
  onChange,
  modelConfigs,
  hostAvailable,
  labelPrefix,
  modelConfigDescription,
}: {
  value: AgentCapabilityFormValue;
  onChange: (next: AgentCapabilityFormValue) => void;
  modelConfigs: ModelConfigOption[];
  /** Host Skills can only be granted by an admin. */
  hostAvailable: boolean;
  /** Names the controls, e.g. "智能体" or "主 HappyClaw ". */
  labelPrefix: string;
  modelConfigDescription: string;
}) {
  const skills = useSkillsStore((state) => state.skills);
  const skillsLoading = useSkillsStore((state) => state.loading);
  const skillsError = useSkillsStore((state) => state.error);
  const mcpServers = useMcpServersStore((state) => state.servers);
  const mcpLoading = useMcpServersStore((state) => state.loading);
  const mcpError = useMcpServersStore((state) => state.error);

  const skillOptions = useMemo(
    () => buildManagedSkillOptions(skills, value.skills.ids),
    [skills, value.skills.ids],
  );
  const hostSkillOptions = useMemo(
    () => buildHostSkillOptions(skills, value.hostSkills.ids),
    [skills, value.hostSkills.ids],
  );
  const mcpOptions = useMemo(
    () => buildMcpSelectionOptions(mcpServers, value.mcp.ids),
    [mcpServers, value.mcp.ids],
  );
  const errors = capabilityFormErrors(value);
  const update = (patch: Partial<AgentCapabilityFormValue>) =>
    onChange({ ...value, ...patch });
  const defaultModel = modelConfigs.find((item) => item.is_default);
  const enabledCount = modelConfigs.filter((item) => item.enabled).length;

  return (
    <div className="space-y-6">
      <SettingsGroup>
        <AgentControlRow
          label="模型配置"
          description={modelConfigDescription}
          control={
            <Select
              value={value.modelConfigId}
              // A model belongs to its configuration.
              onValueChange={(next) =>
                update({ modelConfigId: next, model: null })
              }
            >
              <SelectTrigger
                aria-label={`${labelPrefix}模型配置`}
                className="w-full"
              >
                <SelectValue placeholder="选择模型配置" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">
                  {defaultModel
                    ? `跟随默认模型（${defaultModel.name}）`
                    : `自动选择已启用模型（当前 ${enabledCount} 个）`}
                </SelectItem>
                {modelConfigs.map((config) => (
                  <SelectItem key={config.id} value={config.id}>
                    {config.name}
                    {config.anthropic_model
                      ? ` · ${config.anthropic_model}`
                      : ''}
                    {!config.enabled ? '（仅显式使用）' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        {hasModelLists(modelConfigs) && (
          <AgentControlRow
            label="模型"
            description="在所选模型配置里选择模型；连接默认跟随该配置设为默认的模型。自动选择模型配置时无法指定。"
            control={
              <AgentModelSelect
                configs={modelConfigs}
                configId={value.modelConfigId}
                value={value.model}
                onChange={(model) => update({ model })}
                ariaLabel={`${labelPrefix}模型`}
                className="w-full"
              />
            }
          />
        )}
        <AgentControlRow
          label="推理努力档位"
          description="“跟随模型配置”保留 Provider 高级设置中的 CLAUDE_CODE_EFFORT_LEVEL 或 SDK 默认值；显式档位会覆盖它。模型不支持所选档位时由 Claude 静默降级。"
          control={
            <Select
              value={value.effort}
              onValueChange={(next) =>
                update({ effort: next as AgentEffortLevel })
              }
            >
              <SelectTrigger
                aria-label={`${labelPrefix}推理努力档位`}
                className="w-full"
              >
                <SelectValue placeholder="选择推理努力档位" />
              </SelectTrigger>
              <SelectContent>
                {AGENT_EFFORT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroup>

      <SettingsGroup>
        <div className="px-4 py-4">
          <AgentSkillsPolicyEditor
            managedPolicy={value.skills}
            onManagedModeChange={(mode) =>
              update({ skills: { ...value.skills, mode } })
            }
            onManagedIdsChange={(ids) =>
              update({ skills: { ...value.skills, ids } })
            }
            managedOptions={skillOptions}
            hostPolicy={value.hostSkills}
            onHostModeChange={(mode) =>
              update({
                hostSkills: hostSkillPolicyForMode(mode, value.hostSkills.ids),
              })
            }
            onHostIdsChange={(ids) =>
              update({
                hostSkills: hostSkillPolicyForMode(value.hostSkills.mode, ids),
              })
            }
            hostOptions={hostSkillOptions}
            loading={skillsLoading}
            error={skillsError}
            hostAvailable={hostAvailable}
            managedError={errors.managed}
            hostError={errors.host}
          />
        </div>

        <section className="min-w-0 space-y-3 px-4 py-4">
          <AgentSubheading
            title="HappyClaw MCP"
            description="控制 HappyClaw 额外附加的 MCP；宿主机 MCP 随宿主机 Claude Code 配置加载。"
          />
          <div className="max-w-xl space-y-3">
            <Select
              value={value.mcp.mode}
              onValueChange={(mode) =>
                update({
                  mcp: { ...value.mcp, mode: mode as RuntimePolicyMode },
                })
              }
            >
              <SelectTrigger
                aria-label={`${labelPrefix} MCP`}
                className="w-full max-w-72"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">使用全部 HappyClaw MCP</SelectItem>
                <SelectItem value="custom">只允许所选 HappyClaw MCP</SelectItem>
                <SelectItem value="disabled">关闭 HappyClaw MCP</SelectItem>
              </SelectContent>
            </Select>
            {value.mcp.mode === 'custom' && (
              <PolicyResourcePicker
                label="选择 HappyClaw MCP"
                options={mcpOptions}
                selectedIds={value.mcp.ids}
                onChange={(ids) => update({ mcp: { ...value.mcp, ids } })}
                loading={mcpLoading}
                error={mcpError}
                emptyText="没有已启用的 HappyClaw MCP"
              />
            )}
          </div>
        </section>
      </SettingsGroup>
    </div>
  );
}
