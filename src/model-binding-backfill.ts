/**
 * One-time move of the global default model onto the system main HappyClaw.
 *
 * The global default, the automatic pool and per-connection enable switches
 * are gone; a run's connection now comes from an Agent binding
 * (resolveModelBinding). So that an install upgraded from them keeps running
 * where it ran, the system main HappyClaw (main Agent of the earliest active
 * admin) is bound once to what used to be the default, and the legacy pointer
 * is cleared. A profile that already has a binding is left alone, which makes
 * this safe to run on every boot.
 */
import {
  getOrCreateDefaultAgentProfile,
  getSystemMainAdminUserId,
  isDatabaseInitialized,
  peekSystemMainAgentProfile,
  updateAgentProfile,
} from './db.js';
import { logger } from './logger.js';
import { splitOneMillionSuffix } from './model-providers.js';
import {
  clearLegacyDefaultModelConfigId,
  getProviders,
  providerHasCredentials,
  readLegacyModelDefaults,
  setGlobalModelConfigResolver,
  type UnifiedProvider,
} from './runtime-config.js';

export type ModelBindingBackfillResult =
  | { status: 'no_admin' }
  | { status: 'already_bound'; modelConfigId: string }
  | { status: 'no_connection' }
  | { status: 'bound'; modelConfigId: string; model: string | null };

/**
 * The connection the system main HappyClaw inherits: the legacy default if it
 * can serve, else the first enabled usable one (the only one, when a single
 * one is enabled), else the first usable one.
 */
function pickLegacyConnection(): UnifiedProvider | null {
  const { defaultModelConfigId, enabledIds } = readLegacyModelDefaults();
  const usable = getProviders().filter(providerHasCredentials);
  const enabled = usable.filter((provider) => enabledIds.includes(provider.id));
  return (
    usable.find((provider) => provider.id === defaultModelConfigId) ??
    enabled[0] ??
    usable[0] ??
    null
  );
}

export function backfillSystemMainModelBinding(): ModelBindingBackfillResult {
  const adminId = getSystemMainAdminUserId();
  // Before setup there is no one to bind; the legacy pointer stays for later.
  if (!adminId) return { status: 'no_admin' };
  const profile = getOrCreateDefaultAgentProfile(adminId);
  if (profile.model_config_id) {
    clearLegacyDefaultModelConfigId();
    return { status: 'already_bound', modelConfigId: profile.model_config_id };
  }
  const provider = pickLegacyConnection();
  if (!provider) return { status: 'no_connection' };
  const model = splitOneMillionSuffix(provider.anthropicModel).model || null;
  updateAgentProfile(profile.id, adminId, {
    modelConfigId: provider.id,
    model,
  });
  clearLegacyDefaultModelConfigId();
  logger.info(
    { profileId: profile.id, modelConfigId: provider.id, model },
    'Bound the system main HappyClaw to the former default model connection',
  );
  return { status: 'bound', modelConfigId: provider.id, model };
}

/**
 * Point the host's own Claude calls (titles, recall, a launch nothing chose
 * a connection for) at the system main HappyClaw's binding.
 */
export function installSystemMainModelConfigResolver(): void {
  setGlobalModelConfigResolver(() =>
    isDatabaseInitialized()
      ? (peekSystemMainAgentProfile()?.model_config_id ?? null)
      : null,
  );
}
