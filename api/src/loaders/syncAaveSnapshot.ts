import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import type { AaveReserveConfig } from "./aaveReserveConfig.js";
import type { Position } from "../engine/types.js";

/**
 * Writes one full, fresh snapshot: a new snapshots row, its protocol_params, and its
 * positions. Unlike aave_borrow_candidates (append-only, upserted), a snapshot is
 * immutable once written - each sync run creates a NEW snapshot rather than mutating an
 * old one, matching the snapshot-based versioning decided in the DB-layer commit.
 *
 * All three inserts run inside one transaction. Without this, a crash between the
 * snapshots insert and the positions insert would leave a permanent snapshots row with
 * zero positions - and nothing in the schema marks a snapshot as partial, so a future
 * "load latest snapshot, run sweep()" consumer would read that as a legitimately empty,
 * healthy market instead of a failed write. A silently wrong answer, worse than a crash,
 * caught in review before this shipped.
 *
 * Note on scope: protocol_params today stores only liquidation_threshold_bps and
 * price_usd8 (the schema committed in the DB-layer commit) - it does not carry the
 * liquidation bonus/incentive, which lives instead inside each position's own collateral
 * legs. That's sufficient for sweep()/healthFactor(), which read thresholds off the
 * position, not off protocol_params. It is NOT yet sufficient for the frontend's
 * UcFrontierTable (which wants a per-asset incentive figure) to run on real data - that
 * gap is real and deliberately deferred, not silently dropped, to whenever that tab is
 * wired to the real backend instead of mock fixtures.
 */
export async function syncAaveSnapshot(
  db: Kysely<DB>,
  pinnedBlock: bigint,
  reserveConfigs: AaveReserveConfig[],
  positions: Position[],
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const snapshot = await trx
      .insertInto("snapshots")
      .values({ protocol: "aave", pinned_block: pinnedBlock.toString() })
      .returning("id")
      .executeTakeFirstOrThrow();

    const snapshotId = snapshot.id;

    if (reserveConfigs.length > 0) {
      await trx
        .insertInto("protocol_params")
        .values(
          reserveConfigs.map((r) => ({
            snapshot_id: snapshotId,
            asset: r.asset,
            liquidation_threshold_bps: r.liquidationThresholdBps.toString(),
            price_usd8: r.priceUsd8.toString(),
          })),
        )
        .execute();
    }

    if (positions.length > 0) {
      await trx
        .insertInto("positions")
        .values(
          positions.map((p) => ({
            snapshot_id: snapshotId,
            user_address: p.user,
            // Matches engine/types.ts's CollateralLeg[]/DebtLeg[] shape exactly (JSON of
            // the real type, bigints as strings) - not a hand-described shape that can
            // drift from the type it's supposed to mirror. See db/types.ts's column
            // comment, corrected in review to point here instead of re-describing the
            // fields by hand.
            collateral: JSON.stringify(p.collateral, bigIntReplacer),
            debt: JSON.stringify(p.debt, bigIntReplacer),
            liquidation_incentive_bps: p.liquidationIncentiveBps.toString(),
          })),
        )
        .execute();
    }

    return snapshotId;
  });
}

function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
