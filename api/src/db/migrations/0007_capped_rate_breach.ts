import type { Kysely } from "kysely";

// #38 (SCOPE.md item 3b) - the real mechanism behind the March 2026 Resolv exploit (~$21M bad
// debt): does Fluid's CappedRate cap-enforcement logic correctly clamp an extreme raw-source
// move once its heartbeat genuinely elapses, or does it slip through unclamped? "Designed
// staleness" (getExchangeRateLiquidate() only re-reads the raw source once block.timestamp
// passes lastUpdateTime + minHeartbeat) means a plain eth_call against a currently-fresh
// vault can never observe the AFTER state - genuinely fork-requiring, since only a fork can
// move real block.timestamp forward. One row per real vault tested.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("capped_rate_breach_results")
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("vault", "text", (col) => col.notNull())
    .addColumn("capped_rate_address", "text", (col) => col.notNull())
    .addColumn("min_heartbeat_seconds", "integer", (col) => col.notNull())
    // Real, admin-set gate confirmed this session: getExchangeRateLiquidate()'s down-cap
    // branch only applies at all when this is true - independent of the numeric bound.
    .addColumn("avoid_forced_liquidations_col", "boolean", (col) => col.notNull())
    // 1e6-scale percent (1000000 = 100%), matching the real source's own _SIX_DECIMALS.
    .addColumn("max_down_from_max_reached_pct_col", "numeric", (col) => col.notNull())
    .addColumn("rate_before", "numeric", (col) => col.notNull())
    .addColumn("rate_immediately_after_override", "numeric", (col) => col.notNull())
    .addColumn("rate_after_heartbeat", "numeric", (col) => col.notNull())
    .addColumn("real_drop_pct", "numeric", (col) => col.notNull())
    // "protection-disabled" | "clamped-as-designed" | "unclamped-beyond-bound" - see
    // sync-capped-rate-breach.ts's verdict logic for exactly what each means.
    .addColumn("verdict", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(db.fn("now")))
    .execute();

  await db.schema.createIndex("capped_rate_breach_results_lookup_idx").on("capped_rate_breach_results").columns(["created_at"]).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("capped_rate_breach_results").execute();
}
