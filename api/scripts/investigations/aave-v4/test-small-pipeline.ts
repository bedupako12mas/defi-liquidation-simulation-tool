import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { discoverAaveV4BorrowCandidates } from "../../../src/loaders/aaveV4BorrowDiscovery.js";
import { enrichAaveV4Positions } from "../../../src/loaders/aaveV4UserEnrichment.js";

async function main() {
  await assertAllowedChain();
  const finalized = (await publicClient.getBlock({ blockTag: "finalized" })).number;
  const fromBlock = finalized - 3000n;

  console.log(`Discovering candidates across all 12 Spokes, blocks ${fromBlock}-${finalized}...`);
  const candidates = await discoverAaveV4BorrowCandidates(publicClient, { fromBlock, toBlock: finalized, chunkSize: 10n });
  console.log(`Found ${candidates.length} real candidates.`);
  console.log(candidates.slice(0, 10));

  if (candidates.length === 0) return;

  console.log("\nEnriching...");
  const { positions, failedCallCount } = await enrichAaveV4Positions(publicClient, candidates.map((c) => c.address));
  console.log(`Enriched: ${positions.length} real positions written, ${failedCallCount} failed pre-filter calls.`);
  for (const p of positions.slice(0, 5)) {
    console.log(JSON.stringify(p, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  }
}
main().catch(console.error);
