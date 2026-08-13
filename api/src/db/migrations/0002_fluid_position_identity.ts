import { sql, type Kysely } from "kysely";

// Fluid positions are identified by (vault, nftId), not by address alone - one wallet can
// own multiple Fluid NFTs (multiple, entirely independent positions across different
// vaults), unlike Aave's per-account aggregation. STI (nullable columns on the shared
// table), not a separate extension table - see docs/decisions.md's "Fluid position
// identity: STI" entry for the full reasoning (standard practice at 2 known protocols;
// CTI's benefits only pay for their cost at 3+ subtypes).
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("positions")
    .addColumn("fluid_vault_address", "text")
    .execute();

  await db.schema
    .alterTable("positions")
    .addColumn("fluid_nft_id", "bigint")
    .execute();

  // Both columns null (Aave row) or both non-null (Fluid row) - never one without the
  // other. Recovers most of a normalized extension table's integrity guarantee without
  // the join.
  await sql`
    alter table positions
    add constraint positions_fluid_identity_check
    check ((fluid_vault_address is null) = (fluid_nft_id is null))
  `.execute(db);

  // Fluid's natural key, scoped to rows that have it. A regular unique index can't express
  // "unique only when non-null" the way a partial index can.
  await sql`
    create unique index positions_fluid_identity_idx
    on positions (snapshot_id, fluid_vault_address, fluid_nft_id)
    where fluid_vault_address is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists positions_fluid_identity_idx`.execute(db);
  await sql`alter table positions drop constraint if exists positions_fluid_identity_check`.execute(db);
  await db.schema.alterTable("positions").dropColumn("fluid_nft_id").execute();
  await db.schema.alterTable("positions").dropColumn("fluid_vault_address").execute();
}
