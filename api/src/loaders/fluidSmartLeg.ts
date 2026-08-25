import type { Address, PublicClient } from "viem";
import { parseAbi } from "viem";

// Fluid's own ConstantViews struct via constantsView() - a plain public getter on the vault
// itself (vaultTypesCommon/coreModule/main.sol), shared by T1-T4. NOT the general resolver's
// getDexFromAddress(), which reads a transient re-entrancy-guard variable (dexFromAddress) that
// is always the DEAD_ADDRESS sentinel outside an active transaction - confirmed live against
// 80 real, active T2/T3/T4 vaults (2026-08-25 base-layer investigation, see docs/decisions.md).
const CONSTANTS_VIEW_ABI = parseAbi([
  "struct AddressPair { address token0; address token1; }",
  "struct ConstantViews { address liquidity; address factory; address operateImplementation; address adminImplementation; address secondaryImplementation; address deployer; address supply; address borrow; AddressPair supplyToken; AddressPair borrowToken; uint256 vaultId; uint256 vaultType; bytes32 supplyExchangePriceSlot; bytes32 borrowExchangePriceSlot; bytes32 userSupplySlot; bytes32 userBorrowSlot; }",
  "function constantsView() view returns (ConstantViews)",
]);

export interface FluidSmartLegs {
  vault: Address;
  /** Real DEX pool address if collateral is smart, else null. A normal leg's SUPPLY is always
   *  set equal to the vault's own LIQUIDITY address by the real constructor (which reverts
   *  otherwise) - SUPPLY is never zero/unset on any real vault, so comparing to zero would
   *  misclassify every vault as smart. Comparing to `liquidity` is the real distinguishing test. */
  collateralDex: Address | null;
  /** Real DEX pool address if debt is smart, else null - same reasoning as collateralDex,
   *  applied to the debt leg (BORROW vs. liquidity). */
  debtDex: Address | null;
}

export async function detectSmartLegs(client: PublicClient, vault: Address): Promise<FluidSmartLegs> {
  const constants = await client.readContract({
    address: vault,
    abi: CONSTANTS_VIEW_ABI,
    functionName: "constantsView",
  });

  const liquidity = constants.liquidity.toLowerCase();
  const collateralDex = constants.supply.toLowerCase() !== liquidity ? constants.supply : null;
  const debtDex = constants.borrow.toLowerCase() !== liquidity ? constants.borrow : null;

  return { vault, collateralDex, debtDex };
}
