import { publicClient, assertAllowedChain } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { runAaveIndexSync } from "../src/indexer/aaveIndexer.js";
import { redactError } from "../src/rpc/redact.js";

async function main() {
  // Fail loud before doing any chain work, not partway through - same pattern as every
  // other entrypoint in this codebase.
  await assertAllowedChain();

  // Real providers cap eth_getLogs range differently by plan - discovered live tonight
  // that a free-tier Alchemy app caps it at 10 blocks, well under the loader's own
  // MIN_CHUNK_SIZE backoff floor (50), so the adaptive splitting correctly gave up
  // rather than split forever. Overridable via env instead of hardcoded, since the right
  // value depends on the actual plan in use, not a fixed assumption.
  const chunkSize = process.env.AAVE_INDEXER_CHUNK_SIZE
    ? BigInt(process.env.AAVE_INDEXER_CHUNK_SIZE)
    : undefined;

  // Same reasoning as chunkSize above, for the enrichment stage - a single unbatched
  // (candidates x reserves) multicall failed 100% of ~110,000 calls in real usage against
  // a free-tier RPC already under load from discovery. See aaveUserEnrichment.ts.
  const enrichBatchSize = process.env.AAVE_ENRICH_BATCH_SIZE
    ? Number(process.env.AAVE_ENRICH_BATCH_SIZE)
    : undefined;

  // Batch size alone (25->15) didn't fix a later real 69% failure rate at wide-backfill
  // scale - task #51 traced it to sustained request RATE, not batch SIZE (a small, fast
  // test at the same batch size had zero failures). This paces requests instead.
  const enrichInterBatchDelayMs = process.env.AAVE_ENRICH_INTER_BATCH_DELAY_MS
    ? Number(process.env.AAVE_ENRICH_INTER_BATCH_DELAY_MS)
    : undefined;

  const result = await runAaveIndexSync(publicClient, db, chunkSize, enrichBatchSize, enrichInterBatchDelayMs);
  console.log(JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));

  await db.destroy();
}

main().catch((err) => {
  // See redact.ts - both viem (RPC_URL_MAINNET) and pg (DATABASE_URL) errors can embed
  // the raw connection URL, credentials included, directly in .message/.details/.stack.
  // A bare console.error(err) here would print that straight to the terminal/log.
  console.error(redactError(err));
  process.exitCode = 1;
});
