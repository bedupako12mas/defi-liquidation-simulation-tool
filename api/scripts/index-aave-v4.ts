import { publicClient, assertAllowedChain } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { runAaveV4IndexSync } from "../src/indexer/aaveV4Indexer.js";
import { redactError } from "../src/rpc/redact.js";

async function main() {
  await assertAllowedChain();

  // Same real, live-confirmed free-tier eth_getLogs cap as the V3 indexer - see
  // docs/decisions.md's 2026-09-08 entry. Default here already reflects that lesson
  // (aaveV4BorrowDiscovery.ts's own MIN_CHUNK_SIZE=10), but still overridable.
  const chunkSize = process.env.AAVE_V4_INDEXER_CHUNK_SIZE
    ? BigInt(process.env.AAVE_V4_INDEXER_CHUNK_SIZE)
    : undefined;

  const enrichBatchSize = process.env.AAVE_V4_ENRICH_BATCH_SIZE
    ? Number(process.env.AAVE_V4_ENRICH_BATCH_SIZE)
    : undefined;

  const enrichInterBatchDelayMs = process.env.AAVE_V4_ENRICH_INTER_BATCH_DELAY_MS
    ? Number(process.env.AAVE_V4_ENRICH_INTER_BATCH_DELAY_MS)
    : undefined;

  const result = await runAaveV4IndexSync(publicClient, db, chunkSize, enrichBatchSize, enrichInterBatchDelayMs);
  console.log(JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));

  await db.destroy();
}

main().catch((err) => {
  console.error(redactError(err));
  process.exitCode = 1;
});
