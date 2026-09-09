/**
 * `/api/fluid-t2-shock` client - real Fluid T2 (smart collateral, normal debt) vaults, valued
 * under the full shock sweep via oracle-override repricing of the smart-collateral leg's real
 * DEX reserves (api/src/db/syncFluidT2Shock.ts, Deploy 1/6). A swap-simulation approach was
 * tried first and abandoned - see docs/decisions.md's 2026-08-25 entry: Fluid's own
 * single-swap price-impact cap makes it structurally incapable of reaching realistic depeg
 * magnitudes on a well-capitalized pool. Same "sync writes, route reads" split as every other
 * tier - see meta.ts's top comment.
 */

import { API_BASE, USE_MOCK } from "./meta";

export interface FluidT2ShockResult {
  vault: string;
  collateralDex: string;
  token0: string;
  token1: string;
  token0Decimals: number;
  token1Decimals: number;
  debtToken: string;
  debtDecimals: number;
  presetId: string;
  magnitudePct: string;
  /** The DEX pool's total value under this shock - kept for transparency, NOT what
   *  vaultCollateralValueUsd8 is derived from directly. Real pools are sometimes shared
   *  across many vaults - confirmed live, one pool shared by 18 distinct vaults. */
  poolValueUsd8: string;
  poolValueUsd8Baseline: string;
  /** This vault's REAL, precise share of the pool's value (its own supply shares / the
   *  pool's total shares, both real on-chain values) - not the raw pool total. An earlier
   *  version used the pool's full value directly; fixed after the same approximation was
   *  found to be actively wrong (not just imprecise) on T3's debt leg - see
   *  api/src/db/migrations/0009_fluid_t3_shock_results.ts's top comment. */
  vaultCollateralValueUsd8: string;
  vaultDebtValueUsd8: string;
  liquidatable: boolean;
  createdAt: string;
}

export async function fetchFluidT2Shock(): Promise<FluidT2ShockResult[]> {
  if (USE_MOCK) {
    const { getMockFluidT2Shock } = await import("./mock/mockClient");
    return getMockFluidT2Shock();
  }
  const res = await fetch(`${API_BASE}/api/fluid-t2-shock`);
  if (!res.ok) throw new Error(`GET /api/fluid-t2-shock failed: ${res.status}`);
  return res.json();
}
