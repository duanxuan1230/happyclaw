import { Fragment, useState } from 'react';
import {
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  TriangleAlert,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { IconButton } from '@/components/common/IconButton';
import { buildDefaultProviderEnv } from '../../utils/provider-model';
import type { EnvRow } from './types';

const RESERVED_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
]);

const DEFAULTED_THIRD_PARTY_ENV_KEYS = new Set(
  buildDefaultProviderEnv('').map((row) => row.key),
);

const PROXY_ENV_KEY_RE = /^(https?|all|no)_proxy$/i;

const MANAGED_ENV_SOURCE_LABELS = {
  model: '跟随模型',
  context: '跟随上下文',
  default: '系统默认',
} as const;

/** A connection's environment, split the way the editor shows it. */
export interface ProviderEnvDraft {
  /** Prefilled third-party rows whose value differs from the default. */
  overrides: Record<string, string>;
  rows: EnvRow[];
}

/** Splits a stored `customEnv` into prefilled overrides and free rows. */
export function splitProviderEnv(
  thirdParty: boolean,
  customEnv: Record<string, string>,
  defaultModel: string,
): ProviderEnvDraft {
  const defaults = Object.fromEntries(
    buildDefaultProviderEnv(defaultModel).map((row) => [row.key, row.value]),
  );
  const overrides: Record<string, string> = {};
  const rows: EnvRow[] = [];
  for (const [key, value] of Object.entries(customEnv)) {
    if (thirdParty && DEFAULTED_THIRD_PARTY_ENV_KEYS.has(key)) {
      if (value !== defaults[key]) overrides[key] = value;
    } else {
      rows.push({ key, value });
    }
  }
  return { overrides, rows };
}

/**
 * Validates the free rows and merges the non-blank overrides back into the
 * one `customEnv` the server stores. Blank prefilled overrides mean "use the
 * default" and are never persisted.
 */
export function buildProviderCustomEnv(
  thirdParty: boolean,
  env: ProviderEnvDraft,
): { customEnv: Record<string, string>; error: string | null } {
  const customEnv: Record<string, string> = {};
  for (const [idx, row] of env.rows.entries()) {
    const key = row.key.trim();
    const value = row.value;
    if (!key && !value.trim()) continue;
    if (!key) {
      return { customEnv: {}, error: `第 ${idx + 1} 行环境变量 Key 不能为空` };
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return {
        customEnv: {},
        error: `环境变量 Key "${key}" 格式无效（需匹配 [A-Za-z_][A-Za-z0-9_]*）`,
      };
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      return {
        customEnv: {},
        error: `${key} 由端点、密钥或模型字段管理，请在对应字段中填写`,
      };
    }
    if (thirdParty && DEFAULTED_THIRD_PARTY_ENV_KEYS.has(key)) {
      return {
        customEnv: {},
        error: `${key} 已在系统预填列表中，请直接修改对应值`,
      };
    }
    if (customEnv[key] !== undefined) {
      return { customEnv: {}, error: `环境变量 Key "${key}" 重复` };
    }
    customEnv[key] = value;
  }
  if (thirdParty) {
    for (const [key, value] of Object.entries(env.overrides)) {
      if (value.trim()) customEnv[key] = value;
    }
  }
  return { customEnv, error: null };
}

interface ProviderEnvEditorProps {
  /** Third-party connections get the prefilled Claude Code rows. */
  thirdParty: boolean;
  /** The default model the prefilled rows follow. */
  defaultModel: string;
  value: ProviderEnvDraft;
  onChange: (next: ProviderEnvDraft) => void;
  disabled?: boolean;
}

/** The collapsed 高级设置 block: prefilled defaults plus free env rows. */
export function ProviderEnvEditor({
  thirdParty,
  defaultModel,
  value,
  onChange,
  disabled = false,
}: ProviderEnvEditorProps) {
  const [shown, setShown] = useState<Record<number, boolean>>({});
  const defaults = thirdParty ? buildDefaultProviderEnv(defaultModel) : [];
  const proxyKeys = value.rows
    .map((row) => row.key.trim())
    .filter((key) => PROXY_ENV_KEY_RE.test(key));

  const setOverride = (key: string, next: string, defaultValue: string) => {
    const overrides = { ...value.overrides };
    if (next === defaultValue) delete overrides[key];
    else overrides[key] = next;
    onChange({ ...value, overrides });
  };
  const resetOverride = (key: string) => {
    const overrides = { ...value.overrides };
    delete overrides[key];
    onChange({ ...value, overrides });
  };
  const setRows = (rows: EnvRow[]) => onChange({ ...value, rows });
  const updateRow = (index: number, field: keyof EnvRow, next: string) =>
    setRows(
      value.rows.map((row, i) =>
        i === index ? { ...row, [field]: next } : row,
      ),
    );

  return (
    <details className="group/env overflow-hidden rounded-lg ring-1 ring-surface-border">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-label text-foreground outline-none transition-colors duration-100 select-none hover:bg-surface-hover focus-visible:bg-surface-hover [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open/env:rotate-90"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">
          {thirdParty ? '高级设置 · 环境变量' : '高级设置 · 自定义环境变量'}
        </span>
        {thirdParty && (
          <span className="shrink-0 text-caption text-muted-foreground">
            {defaults.length} 项默认配置
          </span>
        )}
        {value.rows.length > 0 && (
          <span className="shrink-0 text-caption text-muted-foreground">
            {value.rows.length} 项自定义
          </span>
        )}
      </summary>

      <div className="space-y-5 border-t border-surface-border px-3 py-4">
        {thirdParty && (
          <section aria-labelledby="default-provider-env-heading">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3
                  id="default-provider-env-heading"
                  className="text-label text-foreground"
                >
                  系统预填环境变量
                </h3>
                <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
                  默认值会随默认模型更新；修改后以你的自定义值为准。
                </p>
              </div>
              <Badge variant="neutral">{defaults.length} 项</Badge>
            </div>

            <div className="divide-y divide-surface-border overflow-hidden rounded-lg ring-1 ring-surface-border">
              {defaults.map((row, index) => {
                const overridden = Object.hasOwn(value.overrides, row.key);
                const current = overridden
                  ? value.overrides[row.key]
                  : row.value;
                const inputId = `provider-env-default-${index}`;
                return (
                  <div
                    key={row.key}
                    className="grid min-w-0 gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)] sm:items-center sm:gap-4"
                  >
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <label
                        htmlFor={inputId}
                        className="min-w-0 font-mono text-micro break-words text-foreground"
                      >
                        <EnvKey name={row.key} />
                      </label>
                      <Badge
                        variant={overridden ? 'info' : 'outline'}
                        className="shrink-0"
                      >
                        {overridden
                          ? '已自定义'
                          : MANAGED_ENV_SOURCE_LABELS[row.source]}
                      </Badge>
                    </div>
                    <div className="flex min-w-0 items-center gap-1">
                      <Input
                        variant="code"
                        id={inputId}
                        type="text"
                        value={current}
                        onChange={(event) =>
                          setOverride(row.key, event.target.value, row.value)
                        }
                        disabled={disabled}
                        placeholder={
                          row.source === 'model'
                            ? '跟随 Claude Code 默认（透传）'
                            : '使用默认值'
                        }
                        autoComplete="off"
                        className="min-w-0 font-mono text-caption md:text-caption"
                      />
                      {overridden && (
                        <IconButton
                          label="恢复默认值"
                          aria-label={`恢复 ${row.key} 的默认值`}
                          icon={<RotateCcw />}
                          onClick={() => resetOverride(row.key)}
                          disabled={disabled}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section
          aria-labelledby="custom-provider-env-heading"
          className={
            thirdParty ? 'border-t border-surface-border pt-4' : undefined
          }
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <h3
                id="custom-provider-env-heading"
                className="text-label text-foreground"
              >
                自定义环境变量
              </h3>
              <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
                用于 ANTHROPIC_CUSTOM_HEADERS、CLAUDE_CODE_MAX_CONTEXT_TOKENS
                等特殊需求。
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRows([...value.rows, { key: '', value: '' }])}
              disabled={disabled}
              className="shrink-0"
            >
              <Plus />
              添加
            </Button>
          </div>

          {proxyKeys.length > 0 && (
            <p className="mb-2 flex gap-1.5 text-caption leading-5 text-warning">
              <TriangleAlert
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
              {proxyKeys.join('、')}
              会作用于 Agent 的全部网络请求（包括 Bash 和 MCP）；Container
              模式下 127.0.0.1 指向容器自身。建议改在系统或工作区层面配置代理。
            </p>
          )}
          {value.rows.length === 0 ? (
            <p className="text-caption text-muted-foreground">
              没有自定义环境变量，大多数连接无需添加。
            </p>
          ) : (
            <div className="space-y-2">
              {value.rows.map((row, idx) => (
                <div
                  key={idx}
                  className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center"
                >
                  <Input
                    variant="code"
                    type="text"
                    value={row.key}
                    onChange={(e) => updateRow(idx, 'key', e.target.value)}
                    disabled={disabled}
                    placeholder="KEY"
                    aria-label={`第 ${idx + 1} 行环境变量 Key`}
                    className="w-full font-mono text-caption sm:w-[38%] md:text-caption"
                  />
                  <div className="flex min-w-0 flex-1 items-center gap-1">
                    {row.key.trim() === 'ANTHROPIC_CUSTOM_HEADERS' ? (
                      // Claude Code reads one `Name: value` per line.
                      <Textarea
                        variant="code"
                        value={row.value}
                        onChange={(e) =>
                          updateRow(idx, 'value', e.target.value)
                        }
                        disabled={disabled}
                        rows={2}
                        spellCheck={false}
                        placeholder={'X-Header: value\nX-Other: value'}
                        aria-label={`第 ${idx + 1} 行环境变量值`}
                        className="min-h-9 min-w-0 flex-1 font-mono text-caption md:text-caption"
                      />
                    ) : (
                      <Input
                        variant="code"
                        type={shown[idx] ? 'text' : 'password'}
                        value={row.value}
                        onChange={(e) =>
                          updateRow(idx, 'value', e.target.value)
                        }
                        disabled={disabled}
                        placeholder="value"
                        aria-label={`第 ${idx + 1} 行环境变量值`}
                        className="min-w-0 flex-1 font-mono text-caption md:text-caption"
                      />
                    )}
                    <IconButton
                      label={shown[idx] ? '隐藏环境变量值' : '显示环境变量值'}
                      icon={shown[idx] ? <EyeOff /> : <Eye />}
                      onClick={() =>
                        setShown((current) => ({
                          ...current,
                          [idx]: !current[idx],
                        }))
                      }
                    />
                    <IconButton
                      label="删除环境变量"
                      icon={<X />}
                      onClick={() =>
                        setRows(value.rows.filter((_, i) => i !== idx))
                      }
                      disabled={disabled}
                      className="hover:text-destructive"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </details>
  );
}

/** Env var name that wraps after underscores instead of mid-word. */
function EnvKey({ name }: { name: string }) {
  const parts = name.split('_');
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 && (
        <>
          _<wbr />
        </>
      )}
    </Fragment>
  ));
}
