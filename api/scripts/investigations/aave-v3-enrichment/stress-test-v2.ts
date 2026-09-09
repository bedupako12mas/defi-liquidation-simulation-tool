import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { db } from "../../../src/db/client.js";
import { enrichPositions } from "../../../src/loaders/aaveUserEnrichment.js";
import { resolveAaveAddresses } from "../../../src/loaders/aaveAddresses.js";
import { loadReserveConfigs } from "../../../src/loaders/aaveReserveConfig.js";

async function main() {
  await assertAllowedChain();
  const { dataProvider } = await resolveAaveAddresses(publicClient);
  const reserveConfigs = await loadReserveConfigs(publicClient);

  // Same real scale that triggered the original 74% failure: enough candidates to force
  // several batches at the default batch size (25), which is enough to trigger the real
  // rate limit per the earlier stress test (started around batch 2).
  const candidates = await db.selectFrom("aave_borrow_candidates").select("address").limit(500).execute();
  console.log(`Testing real enrichPositions() with ${candidates.length} real candidates x ${reserveConfigs.length} reserves, using the FIXED retry logic...`);

  const start = Date.now();
  const { positions, failedCallCount } = await enrichPositions(publicClient, dataProvider, candidates.map((c) => c.address), reserveConfigs);
  const totalCalls = candidates.length * reserveConfigs.length;
  console.log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s: ${positions.length} real positions, ${failedCallCount} of ${totalCalls} calls failed (${((failedCallCount / totalCalls) * 100).toFixed(1)}%)`);

  await db.destroy();
}
main().catch(console.error);
