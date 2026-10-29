export interface HappyClawBootstrapTurn {
  turnId?: string;
  isHome: boolean;
  isDefaultProfile: boolean;
}

/**
 * Restrict the one-shot first-wake ritual to a turn of the built-in
 * HappyClaw in Home. Process warmups have no turnId; custom Agents and
 * non-Home workspaces are always excluded. The caller still requires the
 * turn to be the owner's own (never an automation run).
 */
export function isHappyClawBootstrapTurn(
  input: HappyClawBootstrapTurn,
): boolean {
  return Boolean(input.turnId && input.isHome && input.isDefaultProfile);
}

export interface HappyClawOwnerProfileRuntime {
  isHome: boolean;
  isDefaultProfile: boolean;
  runtimeAgentId?: string | null;
  runtimeAgentKind?: 'task' | 'conversation' | 'spawn' | null;
}

/**
 * Structural capability survives a turn-less terminal warmup so the same
 * runner can later serve an admitted owner turn. Per-turn data and mutations
 * remain host-authorized; task/spawn runtimes never receive it.
 */
export function isHappyClawOwnerProfileRuntimeStructurallyEligible(
  input: HappyClawOwnerProfileRuntime,
): boolean {
  return Boolean(
    input.isHome &&
    input.isDefaultProfile &&
    (!input.runtimeAgentId || input.runtimeAgentKind === 'conversation'),
  );
}
