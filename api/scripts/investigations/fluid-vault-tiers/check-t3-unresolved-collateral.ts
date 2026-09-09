import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { parseAbi } from "viem";

const VAULTS = [
  "0x528Af0f4AD74F84c624c6EAf04EcbFe6A3d7a770",
  "0x0e19B64F3A79FeeE12Df1b6f239929c6ab6C7ED0",
  "0xC8c9EF21613eB49F6959252154eE8632E40A67Ce",
  "0x56a25029b116a7AA329d5e6357E8679E824F6c83",
  "0x1d3FADD621946c104d72bc2D01A79acdf9719EBa",
  "0x1e3a423bBD2820B08a7Dca2E5D683C143BB11c53",
] as const;

const ABI = parseAbi([
  "struct AddressPair { address token0; address token1; }",
  "struct ConstantViews { address liquidity; address factory; address operateImplementation; address adminImplementation; address secondaryImplementation; address deployer; address supply; address borrow; AddressPair supplyToken; AddressPair borrowToken; uint256 vaultId; uint256 vaultType; bytes32 supplyExchangePriceSlot; bytes32 borrowExchangePriceSlot; bytes32 userSupplySlot; bytes32 userBorrowSlot; }",
  "function constantsView() view returns (ConstantViews)",
  "function symbol() view returns (string)",
]);

async function main() {
  await assertAllowedChain();
  for (const vault of VAULTS) {
    const constants = await publicClient.readContract({ address: vault, abi: ABI, functionName: "constantsView" });
    const collateralToken = constants.supplyToken.token0;
    const symbol = await publicClient.readContract({ address: collateralToken, abi: ABI, functionName: "symbol" }).catch(() => "???");
    console.log(`${vault}: collateral=${collateralToken} (${symbol})`);
  }
}
main().catch(console.error);
