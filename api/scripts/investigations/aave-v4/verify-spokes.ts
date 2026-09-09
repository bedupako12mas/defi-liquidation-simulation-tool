import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { AAVE_V4_SPOKES, AAVE_V4_HUBS } from "../../../src/loaders/aaveV4Addresses.js";
import { parseAbi } from "viem";

const SPOKE_ABI = parseAbi(["function getReserveCount() view returns (uint256)", "function ORACLE() view returns (address)"]);
const HUB_ABI = parseAbi(["function getReservesCount() view returns (uint256)"]);

async function main() {
  await assertAllowedChain();
  console.log("=== Spokes ===");
  for (const [name, address] of Object.entries(AAVE_V4_SPOKES)) {
    try {
      const [count, oracle] = await Promise.all([
        publicClient.readContract({ address: address as `0x${string}`, abi: SPOKE_ABI, functionName: "getReserveCount" }),
        publicClient.readContract({ address: address as `0x${string}`, abi: SPOKE_ABI, functionName: "ORACLE" }),
      ]);
      console.log(`${name} (${address}): reserveCount=${count} oracle=${oracle}`);
    } catch (err) {
      console.log(`${name} (${address}): FAILED - ${(err as Error).message.split("\n")[0]}`);
    }
  }
  console.log("\n=== Hubs (best-effort, ABI guessed) ===");
  for (const [name, address] of Object.entries(AAVE_V4_HUBS)) {
    try {
      const count = await publicClient.readContract({ address: address as `0x${string}`, abi: HUB_ABI, functionName: "getReservesCount" });
      console.log(`${name} (${address}): reservesCount=${count}`);
    } catch (err) {
      console.log(`${name} (${address}): getReservesCount failed (may be wrong function name) - ${(err as Error).message.split("\n")[0]}`);
    }
  }
}
main().catch(console.error);
