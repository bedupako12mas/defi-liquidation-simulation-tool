import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { parseAbi } from "viem";
import { FLUID_VAULT_RESOLVER, FLUID_VAULT_T1_RESOLVER } from "../../../src/loaders/fluidAddresses.js";

const ABI = parseAbi([
  "function getAllVaultsAddresses() view returns (address[])",
  "function getDexFromAddress(address) view returns (address)",
]);

async function main() {
  await assertAllowedChain();
  const t1Vaults = await publicClient.readContract({
    address: FLUID_VAULT_T1_RESOLVER,
    abi: ABI,
    functionName: "getAllVaultsAddresses",
  });
  console.log("Sample T1 vault:", t1Vaults[0]);
  const dex = await publicClient.readContract({
    address: FLUID_VAULT_RESOLVER,
    abi: ABI,
    functionName: "getDexFromAddress",
    args: [t1Vaults[0]],
  });
  console.log("getDexFromAddress() for a real T1 vault (expected: no DEX leg):", dex);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
