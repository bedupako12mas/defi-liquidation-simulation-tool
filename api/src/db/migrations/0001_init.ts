import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("snapshots")
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    .addColumn("protocol", "text", (col) => col.notNull())
    .addColumn("pinned_block", "bigint", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("snapshots_protocol_check", sql`protocol in ('aave', 'fluid')`)
    .execute();

  await db.schema
    .createTable("indexer_progress")
    .addColumn("protocol", "text", (col) => col.primaryKey())
    .addColumn("last_indexed_block", "bigint", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("aave_borrow_candidates")
    .addColumn("address", "text", (col) => col.primaryKey())
    .addColumn("discovered_at_block", "bigint", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("positions")
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    .addColumn("snapshot_id", "bigint", (col) =>
      col.notNull().references("snapshots.id"),
    )
    .addColumn("user_address", "text", (col) => col.notNull())
    .addColumn("collateral", "jsonb", (col) => col.notNull())
    .addColumn("debt", "jsonb", (col) => col.notNull())
    .addColumn("liquidation_incentive_bps", "numeric", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("positions_snapshot_id_idx")
    .on("positions")
    .column("snapshot_id")
    .execute();

  await db.schema
    .createTable("protocol_params")
    .addColumn("snapshot_id", "bigint", (col) =>
      col.notNull().references("snapshots.id"),
    )
    .addColumn("asset", "text", (col) => col.notNull())
    .addColumn("liquidation_threshold_bps", "numeric", (col) => col.notNull())
    .addColumn("price_usd8", "numeric", (col) => col.notNull())
    .addPrimaryKeyConstraint("protocol_params_pk", ["snapshot_id", "asset"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("protocol_params").execute();
  await db.schema.dropTable("positions").execute();
  await db.schema.dropTable("aave_borrow_candidates").execute();
  await db.schema.dropTable("indexer_progress").execute();
  await db.schema.dropTable("snapshots").execute();
}
