import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { toFunctionSelector } from "viem";

const ORACLE = "0x79ad9500CA248D263553d2447b134a4A2c7934b9" as const;

async function main() {
  await assertAllowedChain();
  // Call with the real 4-byte selector for dexSmartColOracleData(), decode raw (no strict ABI shape assumption).
  const selector = toFunctionSelector("function dexSmartColOracleData()");
  const raw = await publicClient.call({ to: ORACLE, data: selector });
  const data = raw.data!.slice(2); // strip 0x
  const words = data.match(/.{1,64}/g) || [];
  console.log(`Total words: ${words.length}`);
  words.forEach((w, i) => {
    const isAddressLike = /^0{24}[0-9a-f]{40}$/.test(w) && w !== "0".repeat(64);
    const isBoolLike = /^0{63}[01]$/.test(w);
    const label = isBoolLike ? "BOOL" : isAddressLike ? "ADDRESS" : "UINT/OTHER";
    const value = isAddressLike ? "0x" + w.slice(24) : isBoolLike ? w.slice(-1) : BigInt("0x" + w).toString();
    console.log(`  [${i}] ${label}: ${value}`);
  });
}
main().catch(console.error);
