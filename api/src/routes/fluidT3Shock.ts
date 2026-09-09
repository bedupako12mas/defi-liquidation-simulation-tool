import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

// Same reasoning as fluid-t2-shock's rate limit - cheap, single-shot, DB-only read.
const FLUID_T3_SHOCK_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };

export interface FluidT3ShockDTO {
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
  poolValueUsd8: string;
  poolValueUsd8Baseline: string;
  vaultCollateralValueUsd8: string;
  vaultDebtValueUsd8: string;
  liquidatable: boolean;
  createdAt: string;
}

/**
 * Serves the latest results written by src/db/syncFluidT3Shock.ts (Deploy 3/6) - real T3
 * (normal collateral, smart debt) vaults, the mirror image of T2's fluid-t2-shock route.
 * pool_value_usd8 is the DEX pool's total value, not this specific vault's exact share of
 * it - see fluidSmartLegValuation.ts's own disclosed limitation.
 */
export function registerFluidT3ShockRoutes(app: FastifyInstance, deps: { db: Kysely<DB> }) {
  app.get(
    "/api/fluid-t3-shock",
    { config: { rateLimit: FLUID_T3_SHOCK_RATE_LIMIT } },
    async (): Promise<FluidT3ShockDTO[]> => {
      const rows = await deps.db.selectFrom("fluid_t3_shock_results").selectAll().orderBy("id", "asc").execute();
      return rows.map((r) => ({
        vault: r.vault,
        collateralToken: r.collateral_token,
        collateralDecimals: r.collateral_decimals,
        debtDex: r.debt_dex,
        token0: r.token0,
        token1: r.token1,
        token0Decimals: r.token0_decimals,
        token1Decimals: r.token1_decimals,
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
