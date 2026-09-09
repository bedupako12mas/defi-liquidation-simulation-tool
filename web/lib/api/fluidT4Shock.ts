/**
 * `/api/fluid-t4-shock` client - real Fluid T4 (smart collateral AND smart debt) vaults.
 * Both legs are real DEX pools, valued via T2's collateral-leg math and T3's debt-leg math
 * run independently (api/src/db/syncFluidT4Shock.ts, Deploy 5/6). Same "sync writes, route
 * reads" split as every other tier - see meta.ts's top comment.
 */

import { API_BASE, USE_MOCK } from "./meta";

export interface FluidT4ShockResult {
  vault: string;
  collateralDex: string;
  colToken0: string;
  colToken1: string;
  colToken0Decimals: number;
  colToken1Decimals: number;
  debtDex: string;
  debtToken0: string;
  debtToken1: string;
  debtToken0Decimals: number;
  debtToken1Decimals: number;
  presetId: string;
  magnitudePct: string;
  /** The collateral DEX pool's total value under this shock - kept for transparency, NOT
   *  what vaultCollateralValueUsd8 is derived from directly. */
  colPoolValueUsd8: string;
  colPoolValueUsd8Baseline: string;
  /** The debt DEX pool's total value under this shock - same role as colPoolValueUsd8. */
  debtPoolValueUsd8: string;
  debtPoolValueUsd8Baseline: string;
  /** This vault's REAL, precise share of the collateral pool's value (its own supply shares
   *  / the pool's total supply shares) - not the raw pool total. */
  vaultCollateralValueUsd8: string;
  /** This vault's REAL, precise share of the debt pool's value (its own borrow shares / the
   *  pool's total borrow shares) - not the raw pool total. */
  vaultDebtValueUsd8: string;
  liquidatable: boolean;
  createdAt: string;
}

export async function fetchFluidT4Shock(): Promise<FluidT4ShockResult[]> {
  if (USE_MOCK) {
    const { getMockFluidT4Shock } = await import("./mock/mockClient");
    return getMockFluidT4Shock();
  }
  const res = await fetch(`${API_BASE}/api/fluid-t4-shock`);
  if (!res.ok) throw new Error(`GET /api/fluid-t4-shock failed: ${res.status}`);
  return res.json();
}
