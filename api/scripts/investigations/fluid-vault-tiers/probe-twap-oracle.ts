import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { parseAbi } from "viem";

const ORACLES = [
  "0x79ad9500CA248D263553d2447b134a4A2c7934b9",
  "0x6E09F5E75FF59A35237DeE49078d07f316F90Ad9",
  "0xfecF110AeE99c9972A3214CbA4822E9Df5e92309",
  "0xA19d38cE41059482B273049A4b7BE405188bd915",
  "0xB07175600Bf990ab397Ce57048BB5B7498d306b8",
] as const;

const ABI = parseAbi([
  "function dexSmartColOracleData() view returns (address dexPool_, address reservesConversionOracle_, bool reservesConversionInvert_, bool quoteInToken0_, uint256 dexTwapDuration_, uint8 dexSharesDecimals_, uint8 dexTokensDecimalsPrecision_, address liquidity_, uint256 token0NumeratorPrecision_, uint256 token0DenominatorPrecision_, uint256 token1NumeratorPrecision_, uint256 token1DenominatorPrecision_)",
  "function getDexColDebtOracleData() view returns (address, bool)",
]);

async function main() {
  await assertAllowedChain();
  for (const oracle of ORACLES) {
    try {
      const data = await publicClient.readContract({ address: oracle, abi: ABI, functionName: "dexSmartColOracleData" });
      console.log(`${oracle}:`);
      console.log(`  dexPool=${data[0]} reservesConversionOracle=${data[1]} invert=${data[2]} twapDuration=${data[4]}`);
      const colDebt = await publicClient.readContract({ address: oracle, abi: ABI, functionName: "getDexColDebtOracleData" }).catch((e) => `FAIL: ${(e as Error).message.slice(0,100)}`);
      console.log(`  colDebtOracle=${JSON.stringify(colDebt, (_, v) => typeof v === "bigint" ? v.toString() : v)}`);
    } catch (e) {
      console.log(`${oracle}: FAIL -> ${(e as Error).message.slice(0, 150)}`);
    }
  }
}
main().catch(console.error);
