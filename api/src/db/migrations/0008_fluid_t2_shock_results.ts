import type { Kysely } from "kysely";

// Deploy 1/6 (Fluid T2 - RPC tier). One row per (vault, shock preset, magnitude) - same
// sweep-ladder convention as validation_results/liquidation_profitability. Values computed
// via oracle-override repricing of the smart-collateral leg's real DEX reserves, not swap
// simulation - see docs/decisions.md's 2026-08-25 entry for why the swap-simulation approach
// was tried first and abandoned.
//
// KNOWN LIMITATION (disclosed in fluidSmartLegValuation.ts, repeated here since it directly
// shapes this schema): pool_value_usd8 is the DEX POOL's total value, not this specific
// vault's exact share of it (Fluid's real per-vault share mechanism - ConstantViews's
// userSupplySlot - is not yet wired in). vault_collateral_value_usd8 approximates the
// vault's share by applying the pool's shock ratio uniformly to the vault's own aggregate
// totalSupply figure - exact only if the vault's share didn't move differently from the
// pool average.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("fluid_t2_shock_results")
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("vault", "text", (col) => col.notNull())
    .addColumn("collateral_dex", "text", (col) => col.notNull())
    .addColumn("token0", "text", (col) => col.notNull())
    .addColumn("token1", "text", (col) => col.notNull())
    .addColumn("token0_decimals", "integer", (col) => col.notNull())
    .addColumn("token1_decimals", "integer", (col) => col.notNull())
    .addColumn("debt_token", "text", (col) => col.notNull())
    .addColumn("debt_decimals", "integer", (col) => col.notNull())
    .addColumn("preset_id", "text", (col) => col.notNull())
    .addColumn("magnitude_pct", "numeric", (col) => col.notNull())
    // Pool-level, not vault-share - see this migration's top comment.
    .addColumn("pool_value_usd8", "numeric", (col) => col.notNull())
    .addColumn("pool_value_usd8_baseline", "numeric", (col) => col.notNull())
    // Approximation of this vault's own collateral value - see top comment.
    .addColumn("vault_collateral_value_usd8", "numeric", (col) => col.notNull())
    .addColumn("vault_debt_value_usd8", "numeric", (col) => col.notNull())
    .addColumn("liquidatable", "boolean", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(db.fn("now")))
    .execute();

  await db.schema
    .createIndex("fluid_t2_shock_results_lookup_idx")
    .on("fluid_t2_shock_results")
    .columns(["vault", "preset_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("fluid_t2_shock_results").execute();
}
