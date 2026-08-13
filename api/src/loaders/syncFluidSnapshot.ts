import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import type { FluidPositionRecord } from "./fluidPositions.js";
import type { FluidPriceResolution } from "./fluidPriceResolution.js";

/**
 * Writes one full, fresh Fluid snapshot - mirrors syncAaveSnapshot.ts's shape (one
 * transaction: snapshots row, protocol_params, positions) with two differences specific
 * to Fluid: positions carry fluid_vault_address/fluid_nft_id (decision #1, migration
 * 0002 - Fluid's natural key isn't the address alone), and protocol_params'
 * liquidation_threshold_bps is written as 0 for every Fluid row - deliberately, not an
 * oversight. Fluid's threshold is a per-VAULT property (Configs.liquidationThreshold),
 * not a single canonical per-asset value the way Aave's is (the same token can be
 * collateral in one vault at 90% and something else in another at a different
 * threshold) - there is no correct single number to put here. It isn't needed downstream
 * either: the sweep reads liquidationThresholdBps off each position's own collateral leg
 * (already correctly set per-vault in fluidPositions.ts), never off protocol_params -
 * same as Aave's own protocol_params.liquidation_threshold_bps, which syncAaveSnapshot.ts's
 * comment already notes isn't read by the hot path.
 */
export async function syncFluidSnapshot(
  db: Kysely<DB>,
  pinnedBlock: bigint,
  priceResolution: FluidPriceResolution,
  positionRecords: FluidPositionRecord[],
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const snapshot = await trx
      .insertInto("snapshots")
      .values({ protocol: "fluid", pinned_block: pinnedBlock.toString() })
      .returning("id")
      .executeTakeFirstOrThrow();

    const snapshotId = snapshot.id;

    const priceEntries = [...priceResolution.pricesUsd8.entries()];
    if (priceEntries.length > 0) {
      await trx
        .insertInto("protocol_params")
        .values(
          priceEntries.map(([asset, priceUsd8]) => ({
            snapshot_id: snapshotId,
            asset,
            liquidation_threshold_bps: "0",
            price_usd8: priceUsd8.toString(),
          })),
        )
        .execute();
    }

    if (positionRecords.length > 0) {
      await trx
        .insertInto("positions")
        .values(
          positionRecords.map(({ position, vaultAddress, nftId }) => ({
            snapshot_id: snapshotId,
            user_address: position.user,
            collateral: JSON.stringify(position.collateral, bigIntReplacer),
            debt: JSON.stringify(position.debt, bigIntReplacer),
            liquidation_incentive_bps: position.liquidationIncentiveBps.toString(),
            fluid_vault_address: vaultAddress.toLowerCase(),
            fluid_nft_id: nftId.toString(),
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
