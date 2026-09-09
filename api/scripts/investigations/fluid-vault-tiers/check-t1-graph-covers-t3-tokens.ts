import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { loadFluidVaultConfigs } from "../../../src/loaders/fluidVaultConfig.js";
import { loadReserveConfigs } from "../../../src/loaders/aaveReserveConfig.js";
import { resolveFluidPrices } from "../../../src/loaders/fluidPriceResolution.js";

const TOKENS = {
  wstUSR: "0x1202F5C7b4B9E47a1A484E8B270be34dbbC75055",
  reUSD: "0x5086bf358635B81D8C47C66d1C8b9E567Db70c72",
  PST: "0x22aE3D9a738471f405169Af055d31c687087d4c7",
  sUSDai: "0x0B2b2B2076d95dda7817e785989fE353fe955ef9",
};

async function main() {
  await assertAllowedChain();
  const vaults = await loadFluidVaultConfigs(publicClient);
  const aaveReserves = await loadReserveConfigs(publicClient);
  const resolution = resolveFluidPrices(vaults, aaveReserves);
  for (const [name, addr] of Object.entries(TOKENS)) {
    const price = resolution.pricesUsd8.get(addr.toLowerCase());
    console.log(`${name} (${addr}): ${price !== undefined ? `resolved via T1 graph, price=${price}` : "NOT resolved by T1 graph"}`);
  }
}
main().catch(console.error);
