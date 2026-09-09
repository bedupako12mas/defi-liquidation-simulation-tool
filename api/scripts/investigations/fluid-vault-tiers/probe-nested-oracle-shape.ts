import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { parseAbi } from "viem";

const ORACLES = [
  { addr: "0x503Ef5B869b3f32D407c7816710f87b1D686C103", label: "WBTC/LBTC-family reserves-conversion" },
  { addr: "0x2F95631D59F564D5e2dD0c028d4DAF3B876D84Fd", label: "shared LST col-debt" },
  { addr: "0x0964957869B2FDd70f0a120E8d8D7A5A187abB6C", label: "reUSD/USDT reserves-conversion" },
] as const;

const CANDIDATES = [
  { name: "getExchangeRate()", fn: "getExchangeRate", sig: "function getExchangeRate() view returns (uint256)" },
  { name: "infoName()", fn: "infoName", sig: "function infoName() view returns (string)" },
  { name: "getOracleHopSources()", fn: "getOracleHopSources", sig: "function getOracleHopSources() view returns ((address source, bool invertRate, uint256 multiplier, uint256 divisor, uint8 sourceType)[])" },
  { name: "configData()", fn: "configData", sig: "function configData() view returns (address,uint16,uint24,uint40,address,bool,bool,bool,uint256,uint24,uint24,uint256)" },
  { name: "targetContract()", fn: "targetContract", sig: "function targetContract() view returns (address)" },
  { name: "aggregatorV3()", fn: "aggregatorV3", sig: "function aggregatorV3() view returns (address)" },
  { name: "RATE_SOURCE()", fn: "RATE_SOURCE", sig: "function RATE_SOURCE() view returns (address)" },
] as const;

async function main() {
  await assertAllowedChain();
  for (const o of ORACLES) {
    console.log(`\n=== ${o.label} (${o.addr}) ===`);
    const code = await publicClient.getCode({ address: o.addr as `0x${string}` });
    console.log(`bytecode length: ${code?.length}`);
    for (const c of CANDIDATES) {
      try {
        const abi = parseAbi([c.sig]);
        const result = await publicClient.readContract({ address: o.addr as `0x${string}`, abi, functionName: c.fn as any });
        console.log(`  ${c.name}: OK -> ${JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      } catch (e) {
        console.log(`  ${c.name}: FAIL`);
      }
    }
  }
}
main().catch(console.error);
