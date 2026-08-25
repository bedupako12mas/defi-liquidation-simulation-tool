import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { parseAbi } from "viem";
import { FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";

const ABI = parseAbi([
  "function getVaultType(address) view returns (uint256)",
  "function getVaultState(address) view returns (uint256 totalPositions, int256 topTick, uint256 currentBranch, uint256 totalBranch, uint256 totalBorrow, uint256 totalSupply, (uint256 status, int256 minimaTick, uint256 debtFactor, uint256 partials, uint256 debtLiquidity, uint256 baseBranchId, int256 baseBranchMinima) currentBranchState)",
  "function getAllVaultsAddresses() view returns (address[])",
]);

async function main() {
  await assertAllowedChain();
  const vaults = await publicClient.readContract({
    address: FLUID_VAULT_RESOLVER,
    abi: ABI,
    functionName: "getAllVaultsAddresses",
  });

  let checked = 0;
  let allZero = true;
  for (const vault of vaults) {
    const type = await publicClient.readContract({
      address: FLUID_VAULT_RESOLVER,
      abi: ABI,
      functionName: "getVaultType",
      args: [vault],
    });
    if (Number(type) === 10000) continue;
    checked++;
    try {
      const state = await publicClient.readContract({
        address: FLUID_VAULT_RESOLVER,
        abi: ABI,
        functionName: "getVaultState",
        args: [vault],
      });
      const [totalPositions, , , , totalBorrow, totalSupply] = state;
      if (totalPositions > 0n || totalBorrow > 0n || totalSupply > 0n) {
        allZero = false;
        console.log(`${vault} (type ${type}): totalPositions=${totalPositions} totalBorrow=${totalBorrow} totalSupply=${totalSupply}`);
      }
    } catch (err) {
      console.log(`${vault} (type ${type}): getVaultState() reverted - ${(err as Error).message.slice(0, 100)}`);
    }
    if (checked >= 15) break; // sample, not exhaustive
  }
  console.log(`\nChecked ${checked} non-T1 vaults. All zero/reverted? ${allZero}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
