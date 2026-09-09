import type { Kysely } from "kysely";

// Deploy 1/6 (Fluid T2 - RPC tier). One row per (vault, shock preset, magnitude) - same
// sweep-ladder convention as validation_results/liquidation_profitability. Values computed
// via oracle-override repricing of the smart-collateral leg's real DEX reserves, not swap
// simulation - see docs/decisions.md's 2026-08-25 entry for why the swap-simulation approach
// was tried first and abandoned.
//
// UPDATE (2026-09-03, retrofitted alongside T3's migration 0009): pool_value_usd8 is still
// the DEX POOL's total value (kept for transparency), but vault_collateral_value_usd8 is NOT
// an approximation anymore - it's the real, precise per-vault share (this vault's own supply
// shares / the pool's total shares, both real on-chain values via FLUID_DEX_RESOLVER's
// getTotalSupplySharesRaw - see fluidDexPoolState.ts's loadVaultSupplyShareFraction).
// Originally shipped as a disclosed approximation (applying the pool's shock ratio to the
// vault's own totalSupply figure, exact only if this vault's share didn't move differently
// from the pool average) until the identical approximation was found to be actively wrong -
// not just imprecise - on T3's debt leg (migration 0009's top comment), which prompted
// fixing this side too rather than leaving a known-fixable flaw in place.
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
