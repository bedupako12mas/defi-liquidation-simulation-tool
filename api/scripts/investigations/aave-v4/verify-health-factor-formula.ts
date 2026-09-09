import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { AAVE_V4_SPOKES } from "../../../src/loaders/aaveV4Addresses.js";
import { parseAbiItem, parseAbi } from "viem";

const BORROW_EVENT = parseAbiItem(
  "event Borrow(uint256 indexed reserveId, address indexed caller, address indexed user, uint256 drawnShares, uint256 drawnAmount)",
);

const SPOKE_ABI = parseAbi([
  "function getReserveCount() view returns (uint256)",
  "function getReserve(uint256 reserveId) view returns (address underlying, address hub, uint16 assetId, uint8 decimals, uint24 collateralRisk, uint8 flags, uint32 dynamicConfigKey)",
  "function getUserReserveStatus(uint256 reserveId, address user) view returns (bool, bool)",
  "function getUserSuppliedAssets(uint256 reserveId, address user) view returns (uint256)",
  "function getUserTotalDebt(uint256 reserveId, address user) view returns (uint256)",
  "function getDynamicReserveConfig(uint256 reserveId, uint32 key) view returns (uint16 collateralFactor, uint32 maxLiquidationBonus, uint16 liquidationFee)",
  "function getUserAccountData(address user) view returns ((uint256 riskPremium, uint256 avgCollateralFactor, uint256 healthFactor, uint256 totalCollateralValue, uint256 totalDebtValueRay, uint256 activeCollateralCount, uint256 borrowCount))",
  "function ORACLE() view returns (address)",
]);

const ORACLE_ABI = parseAbi(["function getReservePrice(uint256 reserveId) view returns (uint256)", "function decimals() view returns (uint8)"]);

async function main() {
  await assertAllowedChain();
  const mainSpoke = AAVE_V4_SPOKES.main;
  const finalized = (await publicClient.getBlock({ blockTag: "finalized" })).number;

  console.log(`Scanning ${mainSpoke} for a real Borrow event, 10 blocks at a time (free-tier RPC cap)...`);
  let allLogs: Awaited<ReturnType<typeof publicClient.getLogs>> = [];
  const CHUNK = 10n;
  const MAX_CHUNKS = 300; // 3000 blocks total
  for (let i = 0; i < MAX_CHUNKS && allLogs.length === 0; i++) {
    const toBlock = finalized - BigInt(i) * CHUNK;
    const fromBlock = toBlock - CHUNK + 1n;
    const logs = await publicClient.getLogs({ address: mainSpoke, event: BORROW_EVENT, fromBlock, toBlock });
    if (logs.length > 0) allLogs = logs;
  }
  console.log(`Found ${allLogs.length} real Borrow events.`);
  if (allLogs.length === 0) {
    console.log("No recent borrows on main spoke in the scanned window - widen MAX_CHUNKS or try another spoke.");
    return;
  }

  const user = allLogs[allLogs.length - 1]!.args.user!;
  console.log(`\nUsing real user: ${user}`);

  const accountData = await publicClient.readContract({ address: mainSpoke, abi: SPOKE_ABI, functionName: "getUserAccountData", args: [user] });
  console.log("\n=== Real getUserAccountData() ===");
  console.log(JSON.stringify(accountData, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  const reserveCount = await publicClient.readContract({ address: mainSpoke, abi: SPOKE_ABI, functionName: "getReserveCount" });
  const oracle = await publicClient.readContract({ address: mainSpoke, abi: SPOKE_ABI, functionName: "ORACLE" });

  let totalCollateralValueRecomputed = 0n; // scaled 1e8 (typical Aave oracle precision) * collateralFactor-weighted
  let totalAdjustedCollateralRecomputed = 0n;
  let totalDebtValueRecomputed = 0n;

  for (let reserveId = 0n; reserveId < reserveCount; reserveId++) {
    const [usedAsCollateral, isBorrowed] = await publicClient.readContract({ address: mainSpoke, abi: SPOKE_ABI, functionName: "getUserReserveStatus", args: [reserveId, user] });
    if (!usedAsCollateral && !isBorrowed) continue;

    const reserve = await publicClient.readContract({ address: mainSpoke, abi: SPOKE_ABI, functionName: "getReserve", args: [reserveId] });
    const price = await publicClient.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "getReservePrice", args: [reserveId] });

    if (usedAsCollateral) {
      const supplied = await publicClient.readContract({ address: mainSpoke, abi: SPOKE_ABI, functionName: "getUserSuppliedAssets", args: [reserveId, user] });
      const dynCfg = await publicClient.readContract({ address: mainSpoke, abi: SPOKE_ABI, functionName: "getDynamicReserveConfig", args: [reserveId, reserve[6]] });
      const decimals = reserve[3];
      const valueUsd8 = (supplied * price) / 10n ** BigInt(decimals);
      totalCollateralValueRecomputed += valueUsd8;
      totalAdjustedCollateralRecomputed += (valueUsd8 * BigInt(dynCfg[0])) / 10_000n;
      console.log(`reserveId=${reserveId} underlying=${reserve[0]} supplied=${supplied} collateralFactor=${dynCfg[0]}bps price=${price} valueUsd8~=${valueUsd8}`);
    }
    if (isBorrowed) {
      const debt = await publicClient.readContract({ address: mainSpoke, abi: SPOKE_ABI, functionName: "getUserTotalDebt", args: [reserveId, user] });
      const decimals = reserve[3];
      const debtValueUsd8 = (debt * price) / 10n ** BigInt(decimals);
      totalDebtValueRecomputed += debtValueUsd8;
      console.log(`reserveId=${reserveId} underlying=${reserve[0]} debt=${debt} price=${price} debtValueUsd8~=${debtValueUsd8}`);
    }
  }

  console.log("\n=== Recomputed (mine) ===");
  console.log("totalCollateralValueRecomputed:", totalCollateralValueRecomputed.toString());
  console.log("totalAdjustedCollateralRecomputed (x collateralFactor):", totalAdjustedCollateralRecomputed.toString());
  console.log("totalDebtValueRecomputed:", totalDebtValueRecomputed.toString());
  const hfRecomputed = totalDebtValueRecomputed === 0n ? null : (totalAdjustedCollateralRecomputed * 10n ** 18n) / totalDebtValueRecomputed;
  console.log("healthFactor recomputed (1e18):", hfRecomputed?.toString());
  console.log("healthFactor REAL (from getUserAccountData):", accountData.healthFactor.toString());
}
main().catch(console.error);
