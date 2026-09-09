import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";
import { detectSmartLegs } from "../../../src/loaders/fluidSmartLeg.js";
import { loadDexCollateralReserves } from "../../../src/loaders/fluidDexPoolState.js";
import { parseAbi } from "viem";

const RESOLVER_ABI = parseAbi([
  "function getAllVaultsAddresses() view returns (address[])",
  "function getVaultType(address) view returns (uint256)",
]);
const TOKEN_ABI = parseAbi(["function symbol() view returns (string)"]);

async function symbolOf(addr: `0x${string}`): Promise<string> {
  if (addr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") return "ETH(native)";
  try {
    return await publicClient.readContract({ address: addr, abi: TOKEN_ABI, functionName: "symbol" });
  } catch {
    return `(unreadable: ${addr})`;
  }
}

async function main() {
  await assertAllowedChain();
  const allVaults = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: RESOLVER_ABI, functionName: "getAllVaultsAddresses" });
  const t2Vaults: `0x${string}`[] = [];
  for (const v of allVaults) {
    const type = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: RESOLVER_ABI, functionName: "getVaultType", args: [v] });
    if (Number(type) === 20000) t2Vaults.push(v);
  }
  console.log(`Total real T2 vaults: ${t2Vaults.length}\n`);

  for (const vault of t2Vaults) {
    try {
      const legs = await detectSmartLegs(publicClient, vault);
      if (!legs.collateralDex) continue;
      const reserves = await loadDexCollateralReserves(publicClient, legs.collateralDex);
      const [sym0, sym1] = await Promise.all([symbolOf(reserves.token0), symbolOf(reserves.token1)]);
      console.log(`${vault}: ${sym0} / ${sym1}`);
    } catch (err) {
      console.log(`${vault}: FAILED - ${(err as Error).message.slice(0, 80)}`);
    }
  }
}
main().catch((e) => console.error(e));
