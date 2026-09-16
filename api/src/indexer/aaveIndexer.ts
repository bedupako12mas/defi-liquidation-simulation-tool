import { sql, type Kysely } from "kysely";
import type { PublicClient } from "viem";
import type { DB } from "../db/types.js";
import { discoverBorrowCandidates } from "../loaders/aaveBorrowDiscovery.js";
import { syncBorrowCandidates } from "../loaders/syncBorrowCandidates.js";
import { resolveAaveAddresses } from "../loaders/aaveAddresses.js";
import { loadReserveConfigs } from "../loaders/aaveReserveConfig.js";
import { enrichPositions } from "../loaders/aaveUserEnrichment.js";
import { syncAaveSnapshot } from "../loaders/syncAaveSnapshot.js";
import { publicClient, assertAllowedChain } from "../rpc/client.js";
import { db as dbClient } from "../db/client.js";
import { redactError } from "../rpc/redact.js";

const PROTOCOL = "aave" as const;

// First-ever run has no checkpoint to resume from. A full historical backfill from Aave
// V3's actual mainnet launch block is explicitly out of scope for this demo-scale
// indexer - see docs/decisions.md. This bounds the first run to a recent, useful window
// instead.
const DEFAULT_INITIAL_LOOKBACK_BLOCKS = 50_000n;

export interface AaveIndexSyncResult {
  newCandidatesDiscovered: number;
  totalCandidatesEnriched: number;
  positionsWritten: number;
  snapshotId: number;
  scannedFromBlock: bigint;
  scannedToBlock: bigint;
}

export async function runAaveIndexSync(
  client: PublicClient,
  db: Kysely<DB>,
  chunkSize?: bigint,
  enrichBatchSize?: number,
  enrichInterBatchDelayMs?: number,
): Promise<AaveIndexSyncResult> {
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
    await discoverBorrowCandidates(client, {
      fromBlock,
      toBlock: finalizedBlock,
      chunkSize,
      onChunkScanned: async (chunkCandidates, scannedThroughBlock) => {
        if (chunkCandidates.length > 0) {
          await syncBorrowCandidates(db, chunkCandidates);
          newCandidatesDiscovered += chunkCandidates.length;
        }
        // GREATEST, not a plain overwrite - same reasoning as the borrow-candidates
        // LEAST fix: a stray out-of-order run should never be able to regress progress
        // backward and cause blocks to be needlessly re-scanned or, worse, skipped.
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

  // Re-enrich EVERY known candidate, not just this run's new ones - an existing
  // candidate's position changes over time (more borrowing, repayment, liquidation)
  // without necessarily emitting a new Borrow event, so a full snapshot needs everyone's
  // current on-chain state. Known tradeoff, not hidden: this means enrichment cost scales
  // with the total candidate set, not the delta - acceptable at demo scale, a real
  // limitation if the candidate set grows very large (see docs/decisions.md).
  const allCandidates = await db.selectFrom("aave_borrow_candidates").select("address").execute();
  const addresses = allCandidates.map((c) => c.address);

  const { dataProvider } = await resolveAaveAddresses(client);
  const reserveConfigs = await loadReserveConfigs(client);
  const { positions } = await enrichPositions(
    client,
    dataProvider,
    addresses,
    reserveConfigs,
    undefined,
    enrichBatchSize,
    enrichInterBatchDelayMs,
  );
  const snapshotId = await syncAaveSnapshot(db, finalizedBlock, reserveConfigs, positions);

  return {
    newCandidatesDiscovered,
    totalCandidatesEnriched: addresses.length,
    positionsWritten: positions.length,
    snapshotId,
    scannedFromBlock: fromBlock,
    scannedToBlock: finalizedBlock,
  };
}

// Self-executing when run directly (`node dist/indexer/aaveIndexer.js` in the real
// container/Job, or `tsx src/indexer/aaveIndexer.ts` / via scripts/index-aave.ts locally) -
// NOT when imported as a library elsewhere (e.g. this file's own tests), same convention as
// src/db/migrate.ts and src/sync/validationResults.ts.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await assertAllowedChain();

  // Same real, live-confirmed free-tier eth_getLogs cap as scripts/index-aave.ts's own
  // comment describes - overridable via env since the right value depends on the actual
  // RPC plan in use, not a fixed assumption.
  const chunkSize = process.env.AAVE_INDEXER_CHUNK_SIZE ? BigInt(process.env.AAVE_INDEXER_CHUNK_SIZE) : undefined;
  const enrichBatchSize = process.env.AAVE_ENRICH_BATCH_SIZE ? Number(process.env.AAVE_ENRICH_BATCH_SIZE) : undefined;
  const enrichInterBatchDelayMs = process.env.AAVE_ENRICH_INTER_BATCH_DELAY_MS
    ? Number(process.env.AAVE_ENRICH_INTER_BATCH_DELAY_MS)
    : undefined;

  try {
    const result = await runAaveIndexSync(publicClient, dbClient, chunkSize, enrichBatchSize, enrichInterBatchDelayMs);
    console.log(JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
    await dbClient.destroy();
  } catch (err) {
    // See redact.ts - both viem (RPC_URL_MAINNET) and pg (DATABASE_URL) errors can embed the
    // raw connection URL, credentials included, directly in .message/.details/.stack.
    console.error(redactError(err));
    await dbClient.destroy();
    process.exit(1);
  }
}
