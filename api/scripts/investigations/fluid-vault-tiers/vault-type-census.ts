// Temporary, read-only diagnostic - not part of the app. Confirms whether the T1-only
// resolver's getAllVaultsAddresses() is already filtered to real T1 vaults, or blindly
// enumerates the shared factory's full vault list across all types.
import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { parseAbi } from "viem";
import { FLUID_VAULT_T1_RESOLVER, FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";

const T1_ABI = parseAbi(["function getAllVaultsAddresses() view returns (address[])"]);
const GENERAL_ABI = parseAbi([
  "function getAllVaultsAddresses() view returns (address[])",
  "function getVaultType(address) view returns (uint256)",
]);

async function main() {
  await assertAllowedChain();

  const t1ResolverVaults = await publicClient.readContract({
    address: FLUID_VAULT_T1_RESOLVER,
    abi: T1_ABI,
    functionName: "getAllVaultsAddresses",
  });

  const generalResolverVaults = await publicClient.readContract({
    address: FLUID_VAULT_RESOLVER,
    abi: GENERAL_ABI,
    functionName: "getAllVaultsAddresses",
  });

  console.log(`T1 resolver's getAllVaultsAddresses(): ${t1ResolverVaults.length} vaults`);
  console.log(`General resolver's getAllVaultsAddresses(): ${generalResolverVaults.length} vaults`);

  const typeCounts = new Map<number, number>();
  const typeByAddr = new Map<string, number>();

  for (const vault of generalResolverVaults) {
    const type = await publicClient.readContract({
      address: FLUID_VAULT_RESOLVER,
      abi: GENERAL_ABI,
      functionName: "getVaultType",
      args: [vault],
    });
    const t = Number(type);
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    typeByAddr.set(vault.toLowerCase(), t);
  }

  console.log("Real vault-type breakdown (10000=T1, 20000=T2, 30000=T3, 40000=T4):", Object.fromEntries(typeCounts));

  const t1ResolverSetLower = new Set(t1ResolverVaults.map((v) => v.toLowerCase()));
  const allType1FromGeneral = generalResolverVaults
    .filter((v) => typeByAddr.get(v.toLowerCase()) === 10000)
    .map((v) => v.toLowerCase());

  const isExactMatch =
    t1ResolverSetLower.size === allType1FromGeneral.length &&
    allType1FromGeneral.every((v) => t1ResolverSetLower.has(v));

  console.log(`\nT1 resolver's list === {every real type=10000 vault}, exactly? ${isExactMatch}`);
  console.log(`(T1 resolver count: ${t1ResolverVaults.length}, real type=10000 count: ${allType1FromGeneral.length})`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
