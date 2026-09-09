import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";
import { parseAbi } from "viem";

const RESOLVER_ABI = parseAbi([
  "function getAllVaultsAddresses() view returns (address[])",
  "function getVaultType(address) view returns (uint256)",
  "function getVaultState(address) view returns (uint256 totalPositions, int256 topTick, uint256 currentBranch, uint256 totalBranch, uint256 totalBorrow, uint256 totalSupply, (uint256 status, int256 minimaTick, uint256 debtFactor, uint256 partials, uint256 debtLiquidity, uint256 baseBranchId, int256 baseBranchMinima) currentBranchState)",
]);

async function main() {
  await assertAllowedChain();
  const allVaults = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: RESOLVER_ABI, functionName: "getAllVaultsAddresses" });
  let active = 0, empty = 0;
  for (const vault of allVaults) {
    const type = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: RESOLVER_ABI, functionName: "getVaultType", args: [vault] });
    if (Number(type) !== 30000) continue;
    const state = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: RESOLVER_ABI, functionName: "getVaultState", args: [vault] });
    const label = state[0] === 0n ? "EMPTY (totalPositions=0)" : `active (totalPositions=${state[0]}, totalSupply=${state[5]})`;
    console.log(`${vault}: ${label}`);
    if (state[0] === 0n) empty++; else active++;
  }
  console.log(`\n${active} active, ${empty} empty`);
}
main().catch(console.error);
