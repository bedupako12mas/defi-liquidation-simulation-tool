import { publicClient, assertAllowedChain } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { runAaveV4IndexSync } from "../src/indexer/aaveV4Indexer.js";
import { redactError } from "../src/rpc/redact.js";

async function main() {
  await assertAllowedChain();

  // Same real, live-confirmed free-tier eth_getLogs cap as the V3 indexer - see
  // docs/decisions.md's 2026-09-10 entry. aaveV4BorrowDiscovery.ts's own DEFAULT_CHUNK_SIZE
  // is now 10 (the confirmed real cap), so this override is only needed to go smaller/larger
  // for a specific run - a caller no longer has to already know the provider's limit.
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
