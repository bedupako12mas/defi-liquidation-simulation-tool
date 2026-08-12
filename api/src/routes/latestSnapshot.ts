import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import type { CollateralLeg, DebtLeg, Position, PriceVector } from "../engine/types.js";

export interface LoadedSnapshot {
  snapshotId: number;
  pinnedBlock: string;
  positions: Position[];
  basePrices: PriceVector;
}

/**
 * Loads the most recent Aave snapshot and reconstitutes it into the exact shapes the
 * engine consumes - the read side of what syncAaveSnapshot.ts writes. Matches
 * db/types.ts's documented JSONB contract (CollateralLeg[]/DebtLeg[], bigints as
 * strings) exactly, since this is the first code to actually read that column back -
 * catching any drift here, not downstream.
 */
export async function loadLatestAaveSnapshot(db: Kysely<DB>): Promise<LoadedSnapshot | null> {
  const snapshot = await db
    .selectFrom("snapshots")
    .selectAll()
    .where("protocol", "=", "aave")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();

  if (!snapshot) return null;

  const [positionRows, paramRows] = await Promise.all([
    db.selectFrom("positions").selectAll().where("snapshot_id", "=", snapshot.id).execute(),
    db.selectFrom("protocol_params").selectAll().where("snapshot_id", "=", snapshot.id).execute(),
  ]);

  const positions: Position[] = [];
  let skippedPositions = 0;

  for (const row of positionRows) {
    try {
      positions.push({
        id: `aave-${row.user_address.toLowerCase()}`,
        protocol: "aave",
        user: row.user_address,
        collateral: parseBigintLegs<CollateralLeg>(row.collateral),
        debt: parseBigintLegs<DebtLeg>(row.debt),
        liquidationIncentiveBps: BigInt(row.liquidation_incentive_bps),
      });
    } catch (err) {
      // Postgres-stored data gets the same "don't fully trust it" treatment as chain
      // data (per the DB-layer commit's own stated threat model) - one malformed row
      // (a bad BigInt conversion, unexpected JSON shape) skips that position with a
      // warning instead of crashing the whole snapshot for every position. Matches the
      // pattern already established in aaveReserveConfig.ts for a failed reserve.
      skippedPositions++;
      console.warn(`[latestSnapshot] skipped malformed position row (id=${row.id}):`, err);
    }
  }

  if (skippedPositions > 0) {
    console.warn(`[latestSnapshot] ${skippedPositions} of ${positionRows.length} position rows skipped`);
  }

  const basePrices: PriceVector = Object.fromEntries(paramRows.map((p) => [p.asset, BigInt(p.price_usd8)]));

  return { snapshotId: snapshot.id, pinnedBlock: snapshot.pinned_block, positions, basePrices };
}

/** Reverses syncAaveSnapshot.ts's JSON.stringify(legs, bigIntReplacer) - amount and, for
 *  collateral, liquidationThresholdBps come back as strings and are parsed to bigint here.
 *  Skips (and logs) an individual malformed leg rather than failing the whole array - the
 *  same "one bad entry shouldn't take down everything else" discipline already used in
 *  aaveReserveConfig.ts, applied to the read side too. */
function parseBigintLegs<T extends { amount: bigint }>(raw: unknown): T[] {
  const legs = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(legs)) return [];

  const parsed: T[] = [];
  for (const leg of legs) {
    try {
      parsed.push({
        ...leg,
        amount: BigInt(leg.amount),
        ...(leg.liquidationThresholdBps !== undefined
          ? { liquidationThresholdBps: BigInt(leg.liquidationThresholdBps) }
          : {}),
      } as T);
    } catch (err) {
      console.warn("[latestSnapshot] skipped malformed leg:", leg, err);
    }
  }
  return parsed;
}
