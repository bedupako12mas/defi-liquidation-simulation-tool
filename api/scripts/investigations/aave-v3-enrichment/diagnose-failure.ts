import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { db } from "../../../src/db/client.js";
import { resolveAaveAddresses } from "../../../src/loaders/aaveAddresses.js";
import { loadReserveConfigs } from "../../../src/loaders/aaveReserveConfig.js";
import { parseAbi } from "viem";

const DATA_PROVIDER_ABI = parseAbi([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
]);

async function main() {
  await assertAllowedChain();
  const { dataProvider } = await resolveAaveAddresses(publicClient);
  const reserveConfigs = await loadReserveConfigs(publicClient);
  console.log(`Real reserve count: ${reserveConfigs.length}`);

  const candidates = await db.selectFrom("aave_borrow_candidates").select("address").limit(25).execute();
  const addresses = candidates.map((c) => c.address);
  console.log(`Testing with ${addresses.length} real candidates x ${reserveConfigs.length} reserves = ${addresses.length * reserveConfigs.length} contracts`);

  const contracts = addresses.flatMap((user) =>
    reserveConfigs.map((reserve) => ({ address: dataProvider, abi: DATA_PROVIDER_ABI, functionName: "getUserReserveData" as const, args: [reserve.asset, user as `0x${string}`] as const })),
  );

  console.log("\n=== Attempting ONE large multicall (25 candidates, mimicking default batch) ===");
  try {
    const start = Date.now();
    const results = await publicClient.multicall({ contracts, allowFailure: true });
    const failures = results.filter((r) => r.status === "failure");
    console.log(`Succeeded in ${Date.now() - start}ms. ${failures.length} of ${results.length} individual entries failed.`);
    if (failures.length > 0) {
      console.log("Sample failure:", JSON.stringify(failures[0], (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 500));
    }
  } catch (err) {
    console.log("WHOLE multicall call threw:", (err as Error).message.split("\n").slice(0, 5).join("\n"));
  }

  await db.destroy();
}
main().catch(console.error);
