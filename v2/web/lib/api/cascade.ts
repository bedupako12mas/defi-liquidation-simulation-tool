/**
 * Milestone 2 (mainnet-fork tier) API client - STUBBED, not implemented.
 *
 * `CascadeDetailTab` (components/tabs/CascadeDetailTab.tsx) renders `<ComingSoonPanel />` and
 * never imports or calls anything below while `capabilities.fork` is false. See
 * validation.ts's top comment - identical reasoning, mirrored here for the cascade-replay
 * endpoint instead of the validation one.
 *
 * FRONTEND_STRATEGY.md's data-flow section names the eventual real call:
 * `POST /api/cascade-replay` or similar - a single, expensive, serialized fork job, not a
 * streamed sweep like Milestone 1's `/api/simulate`. Do not build that client speculatively
 * here; wire it up for real once `v2/api` actually exposes the route.
 */

export interface CascadeReplayResult {
  status: "not-implemented";
}

export async function fetchCascadeReplay(): Promise<never> {
  throw new Error(
    "fetchCascadeReplay() is a Milestone-2 stub (v2/web/lib/api/cascade.ts) - the fork tier " +
      "is not built yet. See docs/FRONTEND_STRATEGY.md and capabilities.fork in /api/meta."
  );
}
