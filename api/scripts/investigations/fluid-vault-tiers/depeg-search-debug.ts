import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { detectSmartLegs } from "../../../src/loaders/fluidSmartLeg.js";
import { loadDexCollateralReserves } from "../../../src/loaders/fluidDexPoolState.js";
import { FLUID_DEX_RESERVES_RESOLVER } from "../../../src/loaders/fluidAddresses.js";
import { parseAbi } from "viem";

const SWAP_ESTIMATE_ABI = parseAbi([
  "function estimateSwapIn(address dex, bool swap0to1, uint256 amountIn, uint256 amountOutMin) returns (uint256 amountOut)",
]);

// Larger, more liquid pool - the active T4 pool from earlier (billions-scale real reserves).
const LARGE_POOL_VAULT = "0x528CF7DBBff878e02e48E83De5097F8071af768D" as const;
const SMALL_POOL_VAULT = "0x5eb4ba0c320b59f825cc8d2291f672247aa5d06f" as const; // WBTC-cbBTC, ~200k raw units

async function probe(label: string, vault: `0x${string}`) {
  console.log(`\n=== ${label} ===`);
  const legs = await detectSmartLegs(publicClient, vault);
  if (!legs.collateralDex) {
    console.log("no smart collateral leg");
    return;
  }
  const reserves = await loadDexCollateralReserves(publicClient, legs.collateralDex);
  console.log(`token0RealReserves=${reserves.token0RealReserves} token1RealReserves=${reserves.token1RealReserves}`);

  // Try a range of swap sizes as fractions of the reserve, log raw amountOut each time.
  const fractions = [0.0000001, 0.000001, 0.00001, 0.0001, 0.001, 0.01, 0.05, 0.1, 0.2, 0.4];
  for (const frac of fractions) {
    const amountIn = BigInt(Math.floor(Number(reserves.token0RealReserves) * frac));
    if (amountIn === 0n) {
      console.log(`  frac=${frac}: amountIn=0, skipped`);
      continue;
    }
    try {
      const amountOut = await publicClient.simulateContract({
        address: FLUID_DEX_RESERVES_RESOLVER,
        abi: SWAP_ESTIMATE_ABI,
        functionName: "estimateSwapIn",
        args: [legs.collateralDex, true, amountIn, 0n],
      });
      const ratio = Number(amountOut.result) / Number(amountIn);
      console.log(`  frac=${frac} amountIn=${amountIn}: amountOut=${amountOut.result} ratio=${ratio}`);
    } catch (err) {
      console.log(`  frac=${frac} amountIn=${amountIn}: REVERTED - ${(err as Error).message.slice(0, 150)}`);
    }
  }
}

async function main() {
  await assertAllowedChain();
  await probe("Large, liquid T4 pool", LARGE_POOL_VAULT);
  await probe("Small T2 pool (WBTC-cbBTC)", SMALL_POOL_VAULT);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
