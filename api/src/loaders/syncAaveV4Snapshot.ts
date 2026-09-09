import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import type { AaveReserveConfig } from "./aaveReserveConfig.js";
import type { Position } from "../engine/types.js";
import type { AaveV4SpokeName } from "./aaveV4Addresses.js";

export interface AaveV4PositionRecord {
  position: Position;
  spoke: AaveV4SpokeName;
}

/**
 * Writes one full, fresh Aave V4 snapshot - mirrors syncFluidSnapshot.ts's shape exactly
 * (its own dedicated sync function, not the plain syncAaveSnapshot.ts), for the same real
 * reason: V4 positions carry an extra identity field (aave_v4_spoke, migration 0012) a bare
 * Position doesn't have, since a user's real position is per-Spoke (one wallet can have
 * multiple independent real V4 positions, one per Spoke - confirmed live, see
 * docs/decisions.md's 2026-09-08 entries).
 */
export async function syncAaveV4Snapshot(
  db: Kysely<DB>,
  pinnedBlock: bigint,
  reserveConfigs: AaveReserveConfig[],
  positionRecords: AaveV4PositionRecord[],
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const snapshot = await trx
      .insertInto("snapshots")
      .values({ protocol: "aave-v4", pinned_block: pinnedBlock.toString() })
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

    if (positionRecords.length > 0) {
      await trx
        .insertInto("positions")
        .values(
          positionRecords.map(({ position, spoke }) => ({
            snapshot_id: snapshotId,
            user_address: position.user,
            collateral: JSON.stringify(position.collateral, bigIntReplacer),
            debt: JSON.stringify(position.debt, bigIntReplacer),
            liquidation_incentive_bps: position.liquidationIncentiveBps.toString(),
            aave_v4_spoke: spoke,
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
