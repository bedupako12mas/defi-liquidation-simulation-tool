import { sql, type Kysely } from "kysely";
import type { PublicClient } from "viem";
import type { DB } from "../db/types.js";
import { discoverAaveV4BorrowCandidates } from "../loaders/aaveV4BorrowDiscovery.js";
import { enrichAaveV4Positions } from "../loaders/aaveV4UserEnrichment.js";
import { syncAaveV4Snapshot } from "../loaders/syncAaveV4Snapshot.js";

const PROTOCOL = "aave-v4" as const;

// Aave V4 launched on Ethereum mainnet 2026-03-30 - a full backfill to launch is a much
// smaller real window than V3's multi-year history, but still bounded here the same way
// aaveIndexer.ts bounds its own first run, rather than assuming "just scan everything since
// launch" is automatically cheap.
const DEFAULT_INITIAL_LOOKBACK_BLOCKS = 50_000n;

export interface AaveV4IndexSyncResult {
  newCandidatesDiscovered: number;
  totalCandidatesEnriched: number;
  positionsWritten: number;
  snapshotId: number;
  scannedFromBlock: bigint;
  scannedToBlock: bigint;
}

export async function runAaveV4IndexSync(
  client: PublicClient,
  db: Kysely<DB>,
  chunkSize?: bigint,
  enrichBatchSize?: number,
  enrichInterBatchDelayMs?: number,
): Promise<AaveV4IndexSyncResult> {
  const finalizedBlock = (await client.getBlock({ blockTag: "finalized" })).number;

  const progress = await db
    .selectFrom("indexer_progress")
    .select("last_indexed_block")
    .where("protocol", "=", PROTOCOL)
    .executeTakeFirst();

  const fromBlock = progress
    ? BigInt(progress.last_indexed_block) + 1n
    : finalizedBlock - DEFAULT_INITIAL_LOOKBACK_BLOCKS;

  let newCandidatesDiscovered = 0;

  if (fromBlock <= finalizedBlock) {
    await discoverAaveV4BorrowCandidates(client, {
      fromBlock,
      toBlock: finalizedBlock,
      chunkSize,
      onChunkScanned: async (chunkCandidates, scannedThroughBlock) => {
        if (chunkCandidates.length > 0) {
          await db
            .insertInto("aave_v4_borrow_candidates")
            .values(chunkCandidates.map((c) => ({ address: c.address, discovered_at_block: c.discoveredAtBlock.toString() })))
            .onConflict((oc) => oc.column("address").doNothing())
            .execute();
          newCandidatesDiscovered += chunkCandidates.length;
        }
        await db
          .insertInto("indexer_progress")
          .values({ protocol: PROTOCOL, last_indexed_block: scannedThroughBlock.toString() })
          .onConflict((oc) =>
            oc.column("protocol").doUpdateSet({
              last_indexed_block: sql`GREATEST(excluded.last_indexed_block, indexer_progress.last_indexed_block)`,
            }),
          )
          .execute();
      },
    });
  }

  // Re-enrich every known candidate, same reasoning as aaveIndexer.ts: a position changes
  // over time without necessarily emitting a new Borrow event on a re-scan.
  const allCandidates = await db.selectFrom("aave_v4_borrow_candidates").select("address").execute();
  const addresses = allCandidates.map((c) => c.address);

  const { positionRecords, reserveConfigs } = await enrichAaveV4Positions(client, addresses, enrichBatchSize, enrichInterBatchDelayMs);
  const snapshotId = await syncAaveV4Snapshot(db, finalizedBlock, reserveConfigs, positionRecords);

  return {
    newCandidatesDiscovered,
    totalCandidatesEnriched: addresses.length,
    positionsWritten: positionRecords.length,
    snapshotId,
    scannedFromBlock: fromBlock,
    scannedToBlock: finalizedBlock,
  };
}
