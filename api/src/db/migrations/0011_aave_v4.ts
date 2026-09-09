import { sql, type Kysely } from "kysely";

// Deploy 7/8 (Aave V4 - RPC tier). Real, verified investigation before writing any code (see
// docs/decisions.md's 2026-09-07/08 entries): Aave V4's real Hub-and-Spoke account model
// (getUserAccountData, getUserSuppliedAssets/getUserTotalDebt, DynamicReserveConfig.
// collateralFactor) computes health factor via the EXACT same weighted formula this
// codebase's own engine/healthFactor.ts already implements for Aave V3/Fluid - confirmed
// live by independently recomputing a real user's health factor and matching the real
// on-chain getUserAccountData() value to 9+ significant digits. Unlike Fluid's T2-T4 (which
// each needed a bespoke table because their smart-leg valuation genuinely didn't fit the
// shared Position shape), V4 reuses the existing snapshots/positions tables and Protocol
// union directly - this is the engine being used as designed, not a special case.
export async function up(db: Kysely<unknown>): Promise<void> {
  // CHECK constraints can't be altered in place in Postgres - drop and recreate.
  await db.schema.alterTable("snapshots").dropConstraint("snapshots_protocol_check").execute();
  await db.schema
    .alterTable("snapshots")
    .addCheckConstraint("snapshots_protocol_check", sql`protocol in ('aave', 'fluid', 'aave-v4')`)
    .execute();

  // Mirrors aave_borrow_candidates exactly - a real Borrow event on any of the 12 real,
  // DAO-authorized Spokes (see aaveV4Addresses.ts) is discovery, same as V3's Pool.
  await db.schema
    .createTable("aave_v4_borrow_candidates")
    .addColumn("address", "text", (col) => col.primaryKey())
    .addColumn("discovered_at_block", "bigint", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("aave_v4_borrow_candidates").execute();
  await db.schema.alterTable("snapshots").dropConstraint("snapshots_protocol_check").execute();
  await db.schema
    .alterTable("snapshots")
    .addCheckConstraint("snapshots_protocol_check", sql`protocol in ('aave', 'fluid')`)
    .execute();
}
