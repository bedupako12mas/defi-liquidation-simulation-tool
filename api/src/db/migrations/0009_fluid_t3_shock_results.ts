import type { Kysely } from "kysely";

// Deploy 3/6 (Fluid T3 - RPC tier). T3 -> normal collateral, smart debt (the mirror image of
// T2's schema, migration 0008) - same sweep-ladder convention, same oracle-override
// repricing mechanism (computeSmartLegValueUsd8 is generic over DexCollateralReserves-shaped
// input, reused unchanged for the debt leg's reserves - see docs/decisions.md's 2026-09-03
// T3 investigation entry).
//
// pool_value_usd8 is still the DEX POOL's total value (kept for transparency/debugging), but
// vault_debt_value_usd8 is NOT a rough approximation of this vault's share - it's the real,
// precise per-vault share (this vault's own debt shares / the pool's total shares, both real
// on-chain values via FLUID_DEX_RESOLVER's getTotalBorrowSharesRaw - see
// fluidDexPoolState.ts's loadVaultBorrowShareFraction). Found and fixed live this session:
// using the raw pool total directly made a real, healthy, active vault look ~38x
// over-indebted (comparing its own real collateral against a pool shared with many other
// vaults) - the naive version was a real bug, not just an acceptable imprecision, once
// compared directly against a vault-scoped collateral figure the way T3's liquidation check
// needs to.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("fluid_t3_shock_results")
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("vault", "text", (col) => col.notNull())
    .addColumn("collateral_token", "text", (col) => col.notNull())
    .addColumn("collateral_decimals", "integer", (col) => col.notNull())
    .addColumn("debt_dex", "text", (col) => col.notNull())
    .addColumn("token0", "text", (col) => col.notNull())
    .addColumn("token1", "text", (col) => col.notNull())
    .addColumn("token0_decimals", "integer", (col) => col.notNull())
    .addColumn("token1_decimals", "integer", (col) => col.notNull())
    .addColumn("preset_id", "text", (col) => col.notNull())
    .addColumn("magnitude_pct", "numeric", (col) => col.notNull())
    // Pool-level, not vault-share - see this migration's top comment.
    .addColumn("pool_value_usd8", "numeric", (col) => col.notNull())
    .addColumn("pool_value_usd8_baseline", "numeric", (col) => col.notNull())
    .addColumn("vault_collateral_value_usd8", "numeric", (col) => col.notNull())
    // Approximation of this vault's own debt value - see top comment.
    .addColumn("vault_debt_value_usd8", "numeric", (col) => col.notNull())
    .addColumn("liquidatable", "boolean", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(db.fn("now")))
    .execute();

  await db.schema
    .createIndex("fluid_t3_shock_results_lookup_idx")
    .on("fluid_t3_shock_results")
    .columns(["vault", "preset_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("fluid_t3_shock_results").execute();
}
