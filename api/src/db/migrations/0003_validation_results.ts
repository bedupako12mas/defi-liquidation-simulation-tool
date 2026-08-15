import type { Kysely } from "kysely";

// Validation-tier (#30) results are written by a real, RPC-heavy sync script (real state-
// override eth_calls per position - too slow/costly to run live on every page load), not
// computed on request - same pattern as snapshots/positions, read-side kept dumb.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("validation_results")
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("protocol", "text", (col) => col.notNull())
    .addColumn("position_id", "text", (col) => col.notNull())
    .addColumn("preset_id", "text", (col) => col.notNull())
    .addColumn("magnitude_pct", "numeric", (col) => col.notNull())
    // "matched" | "mismatched" | "not-applicable" | "unable-to-validate" | "unexpected-revert"
    // - kept as plain text, not a DB enum, matching this project's existing convention
    // (protocol/status-shaped columns elsewhere are also plain text) - a new real status
    // discovered later doesn't need a migration to add.
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("expected_amount", "numeric")
    .addColumn("actual_amount", "numeric")
    .addColumn("detail", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(db.fn("now")))
    .execute();

  await db.schema
    .createIndex("validation_results_lookup_idx")
    .on("validation_results")
    .columns(["protocol", "preset_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("validation_results").execute();
}
