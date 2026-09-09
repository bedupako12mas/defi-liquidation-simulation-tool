import type { Kysely } from "kysely";

// Deploy 5/6 (Fluid T4 - RPC tier). T4 -> smart collateral AND smart debt - both legs are
// real DEX pools, unlike T2 (smart collateral only) or T3 (smart debt only). Confirmed live
// this session (docs/decisions.md's 2026-09-03 T4 entries): every real T4 vault is exactly
// one of two architectures - 13/26 share ONE pool for both legs, 13/26 use TWO separate
// pools - but valuation needs no branching for either case: collateral_dex/debt_dex are
// looked up and valued completely independently (T2's collateral-leg math and T3's debt-leg
// math, reused unchanged, run side by side), and for a same-pool vault they simply both
// resolve to the same address with two independent share fractions (supply vs borrow), not a
// special case.
//
// col_pool_value_usd8/debt_pool_value_usd8 are each DEX POOL's total value (kept for
// transparency/debugging, same convention as T2/T3), NOT this vault's share - vault_
// collateral_value_usd8/vault_debt_value_usd8 are the real, precise per-vault shares (this
// vault's own supply/borrow shares divided by each pool's real total shares via
// FLUID_DEX_RESOLVER - see fluidDexPoolState.ts's loadVaultSupplyShareFraction/
// loadVaultBorrowShareFraction), the same real per-vault-share fix already applied to T2/T3,
// built into T4 from the start rather than retrofitted later.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("fluid_t4_shock_results")
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("vault", "text", (col) => col.notNull())
    .addColumn("collateral_dex", "text", (col) => col.notNull())
    .addColumn("col_token0", "text", (col) => col.notNull())
    .addColumn("col_token1", "text", (col) => col.notNull())
    .addColumn("col_token0_decimals", "integer", (col) => col.notNull())
    .addColumn("col_token1_decimals", "integer", (col) => col.notNull())
    .addColumn("debt_dex", "text", (col) => col.notNull())
    .addColumn("debt_token0", "text", (col) => col.notNull())
    .addColumn("debt_token1", "text", (col) => col.notNull())
    .addColumn("debt_token0_decimals", "integer", (col) => col.notNull())
    .addColumn("debt_token1_decimals", "integer", (col) => col.notNull())
    .addColumn("preset_id", "text", (col) => col.notNull())
    .addColumn("magnitude_pct", "numeric", (col) => col.notNull())
    // Pool-level, not vault-share - see this migration's top comment.
    .addColumn("col_pool_value_usd8", "numeric", (col) => col.notNull())
    .addColumn("col_pool_value_usd8_baseline", "numeric", (col) => col.notNull())
    .addColumn("debt_pool_value_usd8", "numeric", (col) => col.notNull())
    .addColumn("debt_pool_value_usd8_baseline", "numeric", (col) => col.notNull())
    .addColumn("vault_collateral_value_usd8", "numeric", (col) => col.notNull())
    .addColumn("vault_debt_value_usd8", "numeric", (col) => col.notNull())
    .addColumn("liquidatable", "boolean", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(db.fn("now")))
    .execute();

  await db.schema
    .createIndex("fluid_t4_shock_results_lookup_idx")
    .on("fluid_t4_shock_results")
    .columns(["vault", "preset_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("fluid_t4_shock_results").execute();
}
