import type { Kysely } from "kysely";

// #37/#38: the real, fork-requiring question - does liquidating position A FOR REAL change
// position B's REAL liquidation outcome, compared to testing B in isolation (validation_results'
// method, one eth_call per position, stateless by construction)? One row per real (A, B) pair
// actually tested against a real, ephemeral anvil fork (docs/decisions.md's #37/#38 scoping) -
// A's own real mined-tx status is recorded alongside B's isolated-vs-chained comparison so a
// reverted/skipped A is disclosed, not silently dropped.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("chained_liquidation_results")
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("protocol", "text", (col) => col.notNull())
    .addColumn("preset_id", "text", (col) => col.notNull())
    .addColumn("magnitude_pct", "numeric", (col) => col.notNull())
    .addColumn("position_a_id", "text", (col) => col.notNull())
    .addColumn("position_b_id", "text", (col) => col.notNull())
    .addColumn("debt_asset_symbol", "text")
    .addColumn("debt_asset_decimals", "integer")
    // Whether A's own real, mined liquidationCall() succeeded on the fork - "reverted" is a
    // real, disclosed outcome (e.g. the real MustNotLeaveDust rule), not a script bug.
    .addColumn("position_a_tx_status", "text", (col) => col.notNull())
    .addColumn("isolated_status", "text")
    .addColumn("isolated_debt_repaid", "numeric")
    .addColumn("chained_status", "text")
    .addColumn("chained_debt_repaid", "numeric")
    // Signed: chained - isolated, in the debt asset's native decimals. The real, measured
    // fork-only effect - see debt_asset_decimals/debt_asset_symbol for how to display it.
    .addColumn("debt_repaid_diff", "numeric")
    .addColumn("detail", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(db.fn("now")))
    .execute();

  await db.schema
    .createIndex("chained_liquidation_results_lookup_idx")
    .on("chained_liquidation_results")
    .columns(["protocol", "preset_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("chained_liquidation_results").execute();
}
