/**
 * Milestone 2 (mainnet-fork tier) API client - STUBBED, not implemented.
 *
 * `ValidationTab` (components/tabs/ValidationTab.tsx) renders `<ComingSoonPanel />` and never
 * imports or calls anything below while `capabilities.fork` is false (see
 * lib/hooks/useCapabilities.ts). This file exists now only so the module the real Milestone-2
 * work fills in already has a name and a location - FRONTEND_STRATEGY.md's "names reserved so
 * the plan is legible now" - not because there is a working validation flow today.
 *
 * When Milestone 2 starts: replace `notImplemented()` with a real client for whatever
 * fork-replay validation endpoint `v2/api` exposes then (FRONTEND_STRATEGY.md's data-flow
 * section: "on-demand, single-scenario request... since fork jobs are serialized and
 * expensive"). Do not call this from a Milestone-1 component before that's true.
 */

export interface ValidationResult {
  // Placeholder shape - intentionally not fleshed out. Milestone 2 defines the real
  // Tier1-vs-Tier2 comparison shape once the fork replay endpoint exists.
  status: "not-implemented";
}

export async function fetchValidation(): Promise<never> {
  throw new Error(
    "fetchValidation() is a Milestone-2 stub (v2/web/lib/api/validation.ts) - the fork tier " +
      "is not built yet. See docs/FRONTEND_STRATEGY.md and capabilities.fork in /api/meta."
  );
}
