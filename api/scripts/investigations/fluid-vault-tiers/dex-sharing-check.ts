// Corrected version - getDexFromAddress() on the general resolver reads a transient
// re-entrancy-guard variable (always DEAD_ADDRESS outside an active tx), not the real DEX
// address. The real, permanent DEX address lives in each vault's own constantsView().supply
// / .borrow, which equals constantsView().liquidity for a "normal" (non-smart) leg.
import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { parseAbi } from "viem";
import { FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";

const RESOLVER_ABI = parseAbi([
  "function getAllVaultsAddresses() view returns (address[])",
  "function getVaultType(address) view returns (uint256)",
]);

const VAULT_ABI = parseAbi([
  "struct AddressPair { address token0; address token1; }",
  "struct ConstantViews { address liquidity; address factory; address operateImplementation; address adminImplementation; address secondaryImplementation; address deployer; address supply; address borrow; AddressPair supplyToken; AddressPair borrowToken; uint256 vaultId; uint256 vaultType; bytes32 supplyExchangePriceSlot; bytes32 borrowExchangePriceSlot; bytes32 userSupplySlot; bytes32 userBorrowSlot; }",
  "function constantsView() view returns (ConstantViews)",
]);

async function main() {
  await assertAllowedChain();

  const vaults = await publicClient.readContract({
    address: FLUID_VAULT_RESOLVER,
    abi: RESOLVER_ABI,
    functionName: "getAllVaultsAddresses",
  });

  const dexByVault = new Map<string, { type: number; supplyDex: string | null; borrowDex: string | null }>();

  for (const vault of vaults) {
    const type = await publicClient.readContract({
      address: FLUID_VAULT_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: "getVaultType",
      args: [vault],
    });
    const t = Number(type);
    if (t === 10000) continue;

    const constants = await publicClient.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "constantsView",
    });

    const supplyDex = constants.supply.toLowerCase() !== constants.liquidity.toLowerCase() ? constants.supply.toLowerCase() : null;
    const borrowDex = constants.borrow.toLowerCase() !== constants.liquidity.toLowerCase() ? constants.borrow.toLowerCase() : null;
    dexByVault.set(vault.toLowerCase(), { type: t, supplyDex, borrowDex });
  }

  console.log(`Checked ${dexByVault.size} non-T1 vaults.\n`);

  const dexPoolUsage = new Map<string, string[]>(); // dex address -> vault addresses using it (any leg)
  for (const [vault, { supplyDex, borrowDex }] of dexByVault) {
    for (const dex of [supplyDex, borrowDex]) {
      if (!dex) continue;
      const list = dexPoolUsage.get(dex) ?? [];
      list.push(vault);
      dexPoolUsage.set(dex, list);
    }
  }

  console.log(`Distinct real DEX pool addresses in use: ${dexPoolUsage.size}`);
  const shared = [...dexPoolUsage.entries()].filter(([, list]) => list.length > 1);
  console.log(`Shared across multiple vaults: ${shared.length}`);
  for (const [dex, list] of shared) {
    console.log(`  ${dex} <- used by ${list.length} vaults: ${list.join(", ")}`);
  }

  console.log("\nSample of actual per-vault results:");
  let shown = 0;
  for (const [vault, info] of dexByVault) {
    if (shown >= 10) break;
    console.log(`  ${vault} type=${info.type} supplyDex=${info.supplyDex ?? "(normal)"} borrowDex=${info.borrowDex ?? "(normal)"}`);
    shown++;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
