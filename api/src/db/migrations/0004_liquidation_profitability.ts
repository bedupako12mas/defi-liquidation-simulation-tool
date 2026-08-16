import type { Kysely } from "kysely";

// #43: is a real liquidation actually worth a real liquidator's gas, at a given shock
// magnitude - a distinct question from validation_results' "does the math match the real
// contract," so kept as its own table rather than overloading that one with two concerns.
// One row per (position, magnitude tested), same granularity as validation_results, so a
// consumer can derive the real breakeven magnitude (first magnitude, in increasing
// severity, where status = "profitable") rather than storing only one collapsed number.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("liquidation_profitability")
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("protocol", "text", (col) => col.notNull())
    .addColumn("position_id", "text", (col) => col.notNull())
    .addColumn("preset_id", "text", (col) => col.notNull())
    .addColumn("magnitude_pct", "numeric", (col) => col.notNull())
    .addColumn("gas_used", "numeric")
    // All *_usd8 columns share the same 8-decimal fixed-point convention as
    // protocol_params.price_usd8 elsewhere in this schema - exact integer math throughout,
    // not floats, same discipline as every other USD-denominated column in this project.
    .addColumn("gas_cost_usd8", "numeric")
    .addColumn("debt_cleared_usd8", "numeric")
    .addColumn("bonus_value_usd8", "numeric")
    .addColumn("net_profit_usd8", "numeric")
    // "matched-within-drift" is not needed here - profitability doesn't test for an exact
    // liquidationCall match, so this text status set is deliberately its own vocabulary,
    // not validation_results' set.
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("detail", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(db.fn("now")))
    .execute();

  await db.schema
    .createIndex("liquidation_profitability_lookup_idx")
    .on("liquidation_profitability")
    .columns(["protocol", "preset_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("liquidation_profitability").execute();
}
