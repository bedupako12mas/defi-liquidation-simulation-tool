import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { parseAbi } from "viem";

const OLD_PEG_ABI = parseAbi([
  "function dexSmartColOracleData() view returns (address dexPool_, uint256 reservesPegBufferPercent_, address liquidity_, uint256 token0NumeratorPrecision_, uint256 token0DenominatorPrecision_, uint256 token1NumeratorPrecision_, uint256 token1DenominatorPrecision_, address reservesConversionOracle_, bool reservesConversionInvert_, bool quoteInToken0_)",
]);

const VAULTS = [
  { oracle: "0x79ad9500CA248D263553d2447b134a4A2c7934b9", label: "WBTC/CBBTC-USDC" },
  { oracle: "0x6E09F5E75FF59A35237DeE49078d07f316F90Ad9", label: "WBTC/CBBTC-USDT" },
  { oracle: "0xfecF110AeE99c9972A3214CbA4822E9Df5e92309", label: "WBTC/CBBTC-USDC #2" },
  { oracle: "0xA19d38cE41059482B273049A4b7BE405188bd915", label: "WBTC/CBBTC-USDT #2" },
  { oracle: "0xB07175600Bf990ab397Ce57048BB5B7498d306b8", label: "WEETH/ETH-WSTETH" },
] as const;

async function main() {
  await assertAllowedChain();
  for (const v of VAULTS) {
    try {
      const data = await publicClient.readContract({ address: v.oracle as `0x${string}`, abi: OLD_PEG_ABI, functionName: "dexSmartColOracleData" });
      console.log(`${v.label} (${v.oracle}): pegBuffer=${data[1]} reservesConversionOracle=${data[7]} invert=${data[8]}`);
    } catch (e) {
      console.log(`${v.label}: FAIL -> ${(e as Error).message.slice(0, 150)}`);
    }
  }
}
main().catch(console.error);
