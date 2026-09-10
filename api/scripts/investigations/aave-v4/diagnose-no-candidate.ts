import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { db } from "../../../src/db/client.js";
import { AAVE_V4_SPOKES, type AaveV4SpokeName } from "../../../src/loaders/aaveV4Addresses.js";
import { multicallWithRateLimitRetry } from "../../../src/rpc/rateLimitRetry.js";
import { parseAbi } from "viem";

const AAVE_V4_SPOKE_READ_ABI = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 riskPremium, uint256 avgCollateralFactor, uint256 healthFactor, uint256 totalCollateralValue, uint256 totalDebtValueRay, uint256 activeCollateralCount, uint256 borrowCount)",
]);

async function main() {
  await assertAllowedChain();
  const rows = await db.selectFrom("aave_v4_borrow_candidates").select("address").limit(500).execute();
  console.log(`Scanning ${rows.length} real candidates across ${Object.keys(AAVE_V4_SPOKES).length} spokes live...`);

  const spokeEntries = Object.entries(AAVE_V4_SPOKES) as [AaveV4SpokeName, `0x${string}`][];
  let minHf: { user: string; spoke: string; hf: bigint; borrowCount: bigint } | null = null;
  let below1 = 0;
  let totalReal = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20);
    const contracts = batch.flatMap((r) =>
      spokeEntries.map(([, spoke]) => ({ address: spoke, abi: AAVE_V4_SPOKE_READ_ABI, functionName: "getUserAccountData", args: [r.address as `0x${string}`] }) as const),
    );
    type Result = { status: "success"; result: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint] } | { status: "failure"; error: Error };
    const results = await multicallWithRateLimitRetry<Result>(publicClient, contracts, undefined, "diagnose");

    for (let bi = 0; bi < batch.length; bi++) {
      for (let si = 0; si < spokeEntries.length; si++) {
        const result = results[bi * spokeEntries.length + si];
        if (!result) continue;
        if (result.status !== "success") {
          failed++;
          continue;
        }
        const [, , hf, , , , borrowCount] = result.result;
        if (borrowCount === 0n) continue;
        totalReal++;
        if (hf < 1_000_000_000_000_000_000n) below1++;
        if (minHf === null || hf < minHf.hf) {
          minHf = { user: batch[bi]!.address, spoke: spokeEntries[si]![0], hf, borrowCount };
        }
      }
    }
  }

  console.log(`Real (user, spoke) pairs with open debt: ${totalReal}`);
  console.log(`Pairs with HF < 1.0 right now: ${below1}`);
  console.log(`Failed calls: ${failed}`);
  console.log(`Lowest real HF found: ${minHf ? `${minHf.user} on ${minHf.spoke} - HF ${(Number(minHf.hf) / 1e18).toFixed(6)}` : "none"}`);

  await db.destroy();
}
main().catch(console.error);
