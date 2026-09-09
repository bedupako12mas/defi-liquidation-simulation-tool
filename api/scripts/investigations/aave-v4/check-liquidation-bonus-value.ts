import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { AAVE_V4_SPOKES } from "../../../src/loaders/aaveV4Addresses.js";
import { parseAbi } from "viem";

const SPOKE_ABI = parseAbi([
  "function getReserveCount() view returns (uint256)",
  "function getUserReserveStatus(uint256 reserveId, address user) view returns (bool, bool)",
  "function getUserAccountData(address user) view returns (uint256 riskPremium, uint256 avgCollateralFactor, uint256 healthFactor, uint256 totalCollateralValue, uint256 totalDebtValueRay, uint256 activeCollateralCount, uint256 borrowCount)",
  "function getLiquidationBonus(uint256 reserveId, address user, uint256 healthFactor) view returns (uint256)",
]);

async function main() {
  await assertAllowedChain();
  const spoke = AAVE_V4_SPOKES.ethenaEcosystem;
  const user = "0xd7F455CB72895a8B55Dedf2e6C90629e8A0Bf91f" as const;
  const accountData = await publicClient.readContract({ address: spoke, abi: SPOKE_ABI, functionName: "getUserAccountData", args: [user] });
  const healthFactor = accountData[2];
  console.log("real healthFactor:", healthFactor.toString(), "=", Number(healthFactor) / 1e18);

  const reserveCount = await publicClient.readContract({ address: spoke, abi: SPOKE_ABI, functionName: "getReserveCount" });
  let collateralReserveId: bigint | null = null;
  for (let i = 0n; i < reserveCount; i++) {
    const [usedAsCollateral] = await publicClient.readContract({ address: spoke, abi: SPOKE_ABI, functionName: "getUserReserveStatus", args: [i, user] });
    if (usedAsCollateral) {
      collateralReserveId = i;
      console.log(`reserveId=${i} is a real collateral reserve for this user`);
    }
  }
  if (collateralReserveId === null) {
    console.log("no collateral reserve found");
    return;
  }

  try {
    const bonus = await publicClient.readContract({ address: spoke, abi: SPOKE_ABI, functionName: "getLiquidationBonus", args: [collateralReserveId, user, healthFactor] });
    console.log(`getLiquidationBonus(reserveId=${collateralReserveId}, user, real HF) SUCCEEDED, raw value:`, bonus.toString());
  } catch (err) {
    console.log("getLiquidationBonus FAILED:", (err as Error).message.split("\n")[0]);
  }

  try {
    const bonusAtRisk = await publicClient.readContract({ address: spoke, abi: SPOKE_ABI, functionName: "getLiquidationBonus", args: [collateralReserveId, user, 900000000000000000n] });
    console.log("getLiquidationBonus(HF=0.9) SUCCEEDED, raw value:", bonusAtRisk.toString());
  } catch (err) {
    console.log("getLiquidationBonus(HF=0.9) FAILED:", (err as Error).message.split("\n")[0]);
  }
}
main().catch(console.error);
