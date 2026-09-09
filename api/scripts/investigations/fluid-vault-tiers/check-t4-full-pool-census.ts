import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { detectSmartLegs } from "../../../src/loaders/fluidSmartLeg.js";
import { FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";
import { parseAbi } from "viem";

const RESOLVER_ABI = parseAbi([
  "function getAllVaultsAddresses() view returns (address[])",
  "function getVaultType(address) view returns (uint256)",
]);

async function main() {
  await assertAllowedChain();
  const allVaults = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: RESOLVER_ABI, functionName: "getAllVaultsAddresses" });
  const t4Vaults: `0x${string}`[] = [];
  for (const vault of allVaults) {
    const type = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: RESOLVER_ABI, functionName: "getVaultType", args: [vault] });
    if (Number(type) === 40000) t4Vaults.push(vault);
  }
  console.log(`Found ${t4Vaults.length} real T4 vaults\n`);

  let samePool = 0, differentPool = 0;
  for (const vault of t4Vaults) {
    const legs = await detectSmartLegs(publicClient, vault);
    const same = legs.collateralDex?.toLowerCase() === legs.debtDex?.toLowerCase();
    console.log(`${vault}: collateralDex=${legs.collateralDex} debtDex=${legs.debtDex} SAME=${same}`);
    if (same) samePool++; else differentPool++;
  }
  console.log(`\nSame pool: ${samePool}, different pool: ${differentPool} (of all ${t4Vaults.length})`);
}
main().catch(console.error);
