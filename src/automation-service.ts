/**
 * Placeholder with the final signatures so the runtime lane can compile
 * against it; the core lane replaces the bodies.
 */
import type {
  AutomationRuntimeDeps,
  AutomationScheduler,
  AutomationService,
} from './automation-contract.js';

export interface AutomationCore {
  service: AutomationService;
  scheduler: AutomationScheduler;
}

/** One instance per process; index.ts wires it after the DB is open. */
export function createAutomationCore(
  _deps: AutomationRuntimeDeps,
): AutomationCore {
  throw new Error('automation core not implemented yet');
}
