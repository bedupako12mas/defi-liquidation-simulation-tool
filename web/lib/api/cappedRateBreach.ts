/**
 * `/api/capped-rate-breach` client - real CappedRate cap-enforcement testing on an ephemeral
 * mainnet fork (api/scripts/sync-capped-rate-breach.ts, #38, SCOPE.md item 3b - the real
 * mechanism behind the March 2026 Resolv exploit, ~$21M bad debt). Fluid's CappedRate has
 * "designed staleness": getExchangeRateLiquidate() only re-reads its raw source once real
 * time passes lastUpdateTime + minHeartbeat. A plain eth_call against a currently-fresh vault
 * can never observe the AFTER state, since it can't move real block.timestamp forward - only
 * a fork can. Same "sync writes, route reads" split as every other tier - see meta.ts's top
 * comment.
 */

import { API_BASE, USE_MOCK } from "./meta";

export interface CappedRateBreachResult {
  vault: string;
  cappedRateAddress: string;
  minHeartbeatSeconds: number;
  /** Real, admin-set gate: getExchangeRateLiquidate()'s down-cap branch only runs at all
   *  when this is true, independent of the numeric bound below. Confirmed live: every
   *  currently-fresh vault checked has this false - a real, protocol-wide pattern. */
  avoidForcedLiquidationsCol: boolean;
  /** 1e6-scale percent (1000000 = "100%"), matching Fluid's own real source convention. */
  maxDownFromMaxReachedPctCol: string;
  rateBefore: string;
  rateImmediatelyAfterOverride: string;
  rateAfterHeartbeat: string;
  realDropPct: string;
  /** "protection-disabled" (the gate above is false - down-capping never runs for this
   *  vault) | "clamped-as-designed" (protection enabled and correctly bounded the move) |
   *  "unclamped-beyond-bound" (protection enabled but didn't hold - a genuine, concerning
   *  finding, not expected). */
  verdict: string;
  createdAt: string;
}

export async function fetchCappedRateBreach(): Promise<CappedRateBreachResult[]> {
  if (USE_MOCK) {
    const { getMockCappedRateBreach } = await import("./mock/mockClient");
    return getMockCappedRateBreach();
  }
  const res = await fetch(`${API_BASE}/api/capped-rate-breach`);
  if (!res.ok) throw new Error(`GET /api/capped-rate-breach failed: ${res.status}`);
  return res.json();
}
