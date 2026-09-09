/**
 * `/api/fluid-t3-shock` client - real Fluid T3 (normal collateral, smart debt) vaults, the
 * mirror image of T2's fluidT2Shock.ts client. Same oracle-override repricing mechanism,
 * applied to the debt leg's real DEX reserves instead of the collateral leg's
 * (api/src/db/syncFluidT3Shock.ts, Deploy 3/6). Same "sync writes, route reads" split as
 * every other tier - see meta.ts's top comment.
 */

import { API_BASE, USE_MOCK } from "./meta";

export interface FluidT3ShockResult {
  vault: string;
  collateralToken: string;
  collateralDecimals: number;
  debtDex: string;
  token0: string;
  token1: string;
  token0Decimals: number;
  token1Decimals: number;
  presetId: string;
  magnitudePct: string;
  /** The debt DEX pool's total value under this shock - kept for transparency, NOT what
   *  vaultDebtValueUsd8 is derived from directly. */
  poolValueUsd8: string;
  poolValueUsd8Baseline: string;
  vaultCollateralValueUsd8: string;
  /** This vault's REAL, precise share of the pool's value (this vault's own debt shares /
   *  the pool's total shares, both real on-chain values) - not the raw pool total. A real
   *  bug in an earlier version used the pool's full value directly, which made a real,
   *  healthy vault look ~38x over-indebted - fixed live, see
   *  api/src/db/migrations/0009_fluid_t3_shock_results.ts's top comment. */
  vaultDebtValueUsd8: string;
  liquidatable: boolean;
  createdAt: string;
}

export async function fetchFluidT3Shock(): Promise<FluidT3ShockResult[]> {
  if (USE_MOCK) {
    const { getMockFluidT3Shock } = await import("./mock/mockClient");
    return getMockFluidT3Shock();
  }
  const res = await fetch(`${API_BASE}/api/fluid-t3-shock`);
  if (!res.ok) throw new Error(`GET /api/fluid-t3-shock failed: ${res.status}`);
  return res.json();
}
