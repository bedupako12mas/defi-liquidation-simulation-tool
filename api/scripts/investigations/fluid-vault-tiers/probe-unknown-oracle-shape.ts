import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { parseAbi } from "viem";

const ORACLE = "0x79ad9500CA248D263553d2447b134a4A2c7934b9" as const; // WBTC/CBBTC "NoBorrow-or-unknown"

async function tryCall(name: string, sig: string, fnName: string) {
  try {
    const abi = parseAbi([sig]);
    const result = await publicClient.readContract({ address: ORACLE, abi, functionName: fnName as any });
    console.log(`${name}: OK -> ${JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  } catch (e) {
    console.log(`${name}: FAIL -> ${(e as Error).message.slice(0, 200)}`);
  }
}

async function main() {
  await assertAllowedChain();
  const code = await publicClient.getCode({ address: ORACLE });
  console.log(`bytecode length: ${code?.length}`);
  await tryCall("dexOracleData", "function dexOracleData() view returns (address,bool,address,uint256,uint256)", "dexOracleData");
  await tryCall("infoName", "function infoName() view returns (string)", "infoName");
  await tryCall("getExchangeRate", "function getExchangeRate() view returns (uint256)", "getExchangeRate");
  await tryCall("dexSmartColSharesRates", "function dexSmartColSharesRates() view returns (uint256,uint256)", "dexSmartColSharesRates");
  await tryCall("getDexColDebtOracleData", "function getDexColDebtOracleData() view returns (address,bool)", "getDexColDebtOracleData");
  await tryCall("targetDecimals", "function targetDecimals() view returns (uint8)", "targetDecimals");
  await tryCall("DEX", "function DEX() view returns (address)", "DEX");
  await tryCall("dex", "function dex() view returns (address)", "dex");
}
main().catch(console.error);
