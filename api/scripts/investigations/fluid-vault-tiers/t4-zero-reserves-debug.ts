import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { detectSmartLegs } from "../../../src/loaders/fluidSmartLeg.js";
import { loadDexCollateralReserves, loadDexDebtReserves } from "../../../src/loaders/fluidDexPoolState.js";
import { parseAbi } from "viem";

// The OTHER real T4 vault confirmed earlier with substantial activity: 204 positions.
const ACTIVE_T4_VAULT = "0x528CF7DBBff878e02e48E83De5097F8071af768D" as const;
const DUST_T4_VAULT = "0x57fed7c9b3c763999c519264931790cbca331417" as const; // 1 position, dust amounts

const DEX_RAW_ABI = parseAbi([
  "function readFromStorage(bytes32 slot) view returns (uint256)",
]);
// DexSlotsLink.DEX_VARIABLES2_SLOT - need the real slot constant, checking bit 0 (smart col) and bit 1 (smart debt)

async function inspect(label: string, vault: `0x${string}`) {
  console.log(`\n=== ${label}: ${vault} ===`);
  const legs = await detectSmartLegs(publicClient, vault);
  console.log(`collateralDex: ${legs.collateralDex}`);
  console.log(`debtDex: ${legs.debtDex}`);

  if (legs.collateralDex) {
    try {
      const col = await loadDexCollateralReserves(publicClient, legs.collateralDex);
      console.log("collateral reserves:", col);
    } catch (err) {
      console.log("collateral reserves call REVERTED:", (err as Error).message.slice(0, 200));
    }
  }
  if (legs.debtDex) {
    try {
      const debt = await loadDexDebtReserves(publicClient, legs.debtDex);
      console.log("debt reserves:", debt);
    } catch (err) {
      console.log("debt reserves call REVERTED:", (err as Error).message.slice(0, 200));
    }
  }
}

async function main() {
  await assertAllowedChain();
  await inspect("Active T4 (204 positions)", ACTIVE_T4_VAULT);
  await inspect("Dust T4 (1 position)", DUST_T4_VAULT);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
