import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

// Same reasoning as capped-rate-breach's rate limit - cheap, single-shot, DB-only read.
const FLUID_T2_SHOCK_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };

export interface FluidT2ShockDTO {
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
  poolValueUsd8: string;
  poolValueUsd8Baseline: string;
  vaultCollateralValueUsd8: string;
  vaultDebtValueUsd8: string;
  liquidatable: boolean;
  createdAt: string;
}

/**
 * Serves the latest results written by src/db/syncFluidT2Shock.ts (Deploy 1/6) - real T2
 * (smart collateral, normal debt) vaults, valued under the full shock sweep via
 * oracle-override repricing of the smart-collateral leg's real DEX reserves (see
 * docs/decisions.md's 2026-08-25 entry for why a swap-simulation approach was tried and
 * abandoned). pool_value_usd8 is the DEX pool's total value, not this specific vault's exact
 * share of it - see fluidSmartLegValuation.ts's own disclosed limitation.
 */
export function registerFluidT2ShockRoutes(app: FastifyInstance, deps: { db: Kysely<DB> }) {
  app.get(
    "/api/fluid-t2-shock",
    { config: { rateLimit: FLUID_T2_SHOCK_RATE_LIMIT } },
    async (): Promise<FluidT2ShockDTO[]> => {
      const rows = await deps.db.selectFrom("fluid_t2_shock_results").selectAll().orderBy("id", "asc").execute();
      return rows.map((r) => ({
        vault: r.vault,
        collateralDex: r.collateral_dex,
        token0: r.token0,
        token1: r.token1,
        token0Decimals: r.token0_decimals,
        token1Decimals: r.token1_decimals,
        debtToken: r.debt_token,
        debtDecimals: r.debt_decimals,
        presetId: r.preset_id,
        magnitudePct: r.magnitude_pct,
        poolValueUsd8: r.pool_value_usd8,
        poolValueUsd8Baseline: r.pool_value_usd8_baseline,
        vaultCollateralValueUsd8: r.vault_collateral_value_usd8,
        vaultDebtValueUsd8: r.vault_debt_value_usd8,
        liquidatable: r.liquidatable,
        createdAt: r.created_at.toISOString(),
      }));
    },
  );
}
