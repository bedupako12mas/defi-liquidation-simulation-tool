import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { detectSmartLegs } from "../../../src/loaders/fluidSmartLeg.js";
import { loadDexCollateralReserves } from "../../../src/loaders/fluidDexPoolState.js";

const VAULT = "0x57EF7CdCdb639742Fcd4FF88Edb00BbDad1929F9" as const;

async function main() {
  await assertAllowedChain();
  const legs = await detectSmartLegs(publicClient, VAULT);
  if (!legs.collateralDex) throw new Error("no smart collateral");
  const reserves = await loadDexCollateralReserves(publicClient, legs.collateralDex);
  console.log("token0 (reUSD, 18 dec):", reserves.token0, "imaginary:", reserves.token0ImaginaryReserves);
  console.log("token1 (USDT, 6 dec):", reserves.token1, "imaginary:", reserves.token1ImaginaryReserves);
  console.log("naive raw ratio (BUGGY):", Number(reserves.token1ImaginaryReserves) / Number(reserves.token0ImaginaryReserves));
  console.log("decimal-normalized ratio (CORRECT):", (Number(reserves.token1ImaginaryReserves) / 1e6) / (Number(reserves.token0ImaginaryReserves) / 1e18));
}
main().catch((e) => console.error(e));
