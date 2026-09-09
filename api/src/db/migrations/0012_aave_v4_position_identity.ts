import { sql, type Kysely } from "kysely";

// Aave V4 positions are identified by (user, Spoke), not by address alone - a user's
// position is genuinely per-Spoke (each Spoke is its own isolated health-factor domain, real
// account model confirmed live - see docs/decisions.md's 2026-09-08 entries), so one wallet
// can have multiple real, independent V4 positions across different Spokes, same shape of
// problem migration 0002 already solved for Fluid's (vault, nftId) identity. Same STI
// approach (nullable column on the shared table), not a new pattern.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("positions").addColumn("aave_v4_spoke", "text").execute();

  // Real natural key, scoped to rows that have it - a regular unique index can't express
  // "unique only when non-null" the way a partial index can.
  await sql`
    create unique index positions_aave_v4_identity_idx
    on positions (snapshot_id, user_address, aave_v4_spoke)
    where aave_v4_spoke is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists positions_aave_v4_identity_idx`.execute(db);
  await db.schema.alterTable("positions").dropColumn("aave_v4_spoke").execute();
}
