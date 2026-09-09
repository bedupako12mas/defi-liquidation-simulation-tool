import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { db } from "../../../src/db/client.js";
import { resolveAaveAddresses } from "../../../src/loaders/aaveAddresses.js";
import { loadReserveConfigs } from "../../../src/loaders/aaveReserveConfig.js";
import { parseAbi } from "viem";

const DATA_PROVIDER_ABI = parseAbi([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
]);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await assertAllowedChain();
  const { dataProvider } = await resolveAaveAddresses(publicClient);
  const reserveConfigs = await loadReserveConfigs(publicClient);

  const BATCH_SIZE = 25;
  const DELAY_MS = 250;
  const NUM_BATCHES = 40;

  const allCandidates = await db.selectFrom("aave_borrow_candidates").select("address").limit(BATCH_SIZE * NUM_BATCHES).execute();
  console.log(`Have ${allCandidates.length} real candidates for ${NUM_BATCHES} batches of ${BATCH_SIZE}`);

  let totalContracts = 0;
  let totalFailed = 0;
  let firstFailureAtBatch: number | null = null;

  for (let b = 0; b < NUM_BATCHES; b++) {
    const batch = allCandidates.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE).map((c) => c.address);
    if (batch.length === 0) break;
    const contracts = batch.flatMap((user) =>
      reserveConfigs.map((reserve) => ({ address: dataProvider, abi: DATA_PROVIDER_ABI, functionName: "getUserReserveData" as const, args: [reserve.asset, user as `0x${string}`] as const })),
    );
    totalContracts += contracts.length;
    const start = Date.now();
    try {
      const results = await publicClient.multicall({ contracts, allowFailure: true });
      const failed = results.filter((r) => r.status === "failure").length;
      totalFailed += failed;
      if (failed > 0 && firstFailureAtBatch === null) firstFailureAtBatch = b;
      console.log(`batch ${b}: ${Date.now() - start}ms, ${failed}/${results.length} failed${failed > 0 ? " <-- FAILURES START" : ""}`);
      if (failed > 0) {
        const sample = results.find((r) => r.status === "failure");
        console.log("  sample failure:", JSON.stringify(sample, (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 300));
      }
    } catch (err) {
      console.log(`batch ${b}: WHOLE CALL THREW after ${Date.now() - start}ms:`, (err as Error).message.split("\n")[0]);
      totalFailed += contracts.length;
      if (firstFailureAtBatch === null) firstFailureAtBatch = b;
    }
    if (b < NUM_BATCHES - 1) await sleep(DELAY_MS);
  }

  console.log(`\nTotal: ${totalFailed} of ${totalContracts} failed. First failure at batch: ${firstFailureAtBatch}`);
  await db.destroy();
}
main().catch(console.error);
