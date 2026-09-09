import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { parseAbi } from "viem";

const ORACLE = "0xc9C5FFd2Ee5747Ae87FfC121d22e26E06f5F22a4" as const;

// Candidate real Fluid oracle interfaces to probe - names taken from Fluid's public
// fluid-contracts-public repo's oracle implementations (FluidCappedRate, FluidGenericOracle,
// FluidDexSmartColOracle-style contracts referenced in docs/decisions.md's earlier oracle
// investigation), not guessed at random.
const CANDIDATES = [
  { name: "getExchangeRate()", abi: ["function getExchangeRate() view returns (uint256)"] },
  { name: "getExchangeRateOperate()", abi: ["function getExchangeRateOperate() view returns (uint256)"] },
  { name: "getExchangeRateLiquidate()", abi: ["function getExchangeRateLiquidate() view returns (uint256)"] },
  { name: "infoName()", abi: ["function infoName() view returns (string)"] },
  { name: "DEX_TYPE()", abi: ["function DEX_TYPE() view returns (uint256)"] },
  { name: "dexPool()", abi: ["function dexPool() view returns (address)"] },
  { name: "reserveContract()", abi: ["function reserveContract() view returns (address)"] },
  { name: "getOracleHopSources()", abi: ["function getOracleHopSources() view returns ((address source, bool invertRate, uint256 multiplier, uint256 divisor, uint8 sourceType)[])"] },
  { name: "getFinalPriceOperate()", abi: ["function getFinalPriceOperate() view returns (uint256)"] },
  { name: "quoteColPerDebt()", abi: ["function quoteColPerDebt() view returns (uint256)"] },
] as const;

async function main() {
  await assertAllowedChain();
  const code = await publicClient.getCode({ address: ORACLE });
  console.log(`bytecode length: ${code ? code.length : 0}`);
  for (const c of CANDIDATES) {
    try {
      const abi = parseAbi(c.abi as unknown as string[]);
      const result = await publicClient.readContract({ address: ORACLE, abi, functionName: c.name.split("(")[0] as any });
      console.log(`${c.name}: OK -> ${result}`);
    } catch (e) {
      console.log(`${c.name}: revert/fail (${(e as Error).message.slice(0, 80)})`);
    }
  }
}
main().catch(console.error);
