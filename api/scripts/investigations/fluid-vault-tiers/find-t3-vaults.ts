import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";
import { parseAbi } from "viem";

const ABI = parseAbi([
  "function getAllVaultsAddresses() view returns (address[])",
  "function getVaultType(address) view returns (uint256)",
]);

async function main() {
  await assertAllowedChain();
  const allVaults = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: ABI, functionName: "getAllVaultsAddresses" });
  console.log(`Total vaults: ${allVaults.length}`);
  const byType = new Map<number, string[]>();
  for (const vault of allVaults) {
    const type = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: ABI, functionName: "getVaultType", args: [vault] });
    const t = Number(type);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(vault);
  }
  for (const [type, vaults] of byType) {
    console.log(`type ${type}: ${vaults.length} vaults, e.g. ${vaults[0]}`);
  }
}
main().catch(console.error);
