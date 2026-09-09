import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

// Same reasoning as T2/T3 shock's rate limit - cheap, single-shot, DB-only read.
const FLUID_T4_SHOCK_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };

export interface FluidT4ShockDTO {
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
  colPoolValueUsd8: string;
  colPoolValueUsd8Baseline: string;
  debtPoolValueUsd8: string;
  debtPoolValueUsd8Baseline: string;
  vaultCollateralValueUsd8: string;
  vaultDebtValueUsd8: string;
  liquidatable: boolean;
  createdAt: string;
}

/**
 * Serves the latest results written by src/db/syncFluidT4Shock.ts (Deploy 5/6) - real T4
 * (smart collateral AND smart debt) vaults. Both col/debt pool value fields are each DEX
 * pool's total value (kept for transparency/debugging); vaultCollateralValueUsd8/
 * vaultDebtValueUsd8 are this vault's real, precise per-vault shares - see
 * migrations/0010_fluid_t4_shock_results.ts's top comment.
 */
export function registerFluidT4ShockRoutes(app: FastifyInstance, deps: { db: Kysely<DB> }) {
  app.get(
    "/api/fluid-t4-shock",
    { config: { rateLimit: FLUID_T4_SHOCK_RATE_LIMIT } },
    async (): Promise<FluidT4ShockDTO[]> => {
      const rows = await deps.db.selectFrom("fluid_t4_shock_results").selectAll().orderBy("id", "asc").execute();
      return rows.map((r) => ({
        vault: r.vault,
        collateralDex: r.collateral_dex,
        colToken0: r.col_token0,
        colToken1: r.col_token1,
        colToken0Decimals: r.col_token0_decimals,
        colToken1Decimals: r.col_token1_decimals,
        debtDex: r.debt_dex,
        debtToken0: r.debt_token0,
        debtToken1: r.debt_token1,
        debtToken0Decimals: r.debt_token0_decimals,
        debtToken1Decimals: r.debt_token1_decimals,
        presetId: r.preset_id,
        magnitudePct: r.magnitude_pct,
        colPoolValueUsd8: r.col_pool_value_usd8,
        colPoolValueUsd8Baseline: r.col_pool_value_usd8_baseline,
        debtPoolValueUsd8: r.debt_pool_value_usd8,
        debtPoolValueUsd8Baseline: r.debt_pool_value_usd8_baseline,
        vaultCollateralValueUsd8: r.vault_collateral_value_usd8,
        vaultDebtValueUsd8: r.vault_debt_value_usd8,
        liquidatable: r.liquidatable,
        createdAt: r.created_at.toISOString(),
      }));
    },
  );
}
