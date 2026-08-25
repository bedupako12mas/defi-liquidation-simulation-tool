import type { AssetShockConfig } from "../engine/shockModel.js";
import { applyShock } from "../engine/shockModel.js";
import { assetValueUsd8 } from "../engine/healthFactor.js";
import type { PriceVector, ShockPreset } from "../engine/types.js";
import type { DexCollateralReserves } from "./fluidDexPoolState.js";

/**
 * Values a smart-collateral leg under a shock by directly repricing its two underlying
 * tokens - the same mechanism T1 already uses (applyShock()/SHOCK_PRESETS, calibrated
 * against real historical events: June 2022 stETH, March 2023 USDC/SVB) - rather than
 * simulating the pool's internal rebalancing via a real swap.
 *
 * A swap-simulation approach (search a real swap size via the DEX resolver's estimateSwapIn
 * until the pool's price reflects the target depeg) was tried first and abandoned - see
 * docs/decisions.md's 2026-08-25 entry for the full investigation. Short version: a single
 * simulated swap turned out to be architecturally incapable of reaching a realistic depeg
 * magnitude for a well-capitalized pool, because Fluid's own contract caps a single swap's
 * price impact (50% of imaginary reserves) far below what a real depeg represents - real
 * depegs happen via the underlying asset's fair value shifting and/or many trades
 * accumulating over time, not one bounded transaction.
 *
 * KNOWN LIMITATION (disclosed, not hidden): this reprices both tokens but leaves the pool's
 * real token0/token1 SPLIT unchanged - it does not model how a real depeg's arbitrage
 * pressure would shift the pool's actual composition. The leg's aggregate USD value under
 * the shock is correct; the composition-shift dynamic (and any resulting change to a
 * liquidator's real payout mix between the two tokens) is not represented. A real,
 * scoped-out follow-up, not a silently-accepted gap.
 */
export function computeSmartLegValueUsd8(
  reserves: DexCollateralReserves,
  token0Decimals: number,
  token1Decimals: number,
  basePrices: PriceVector,
  assetConfig: Record<string, AssetShockConfig>,
  magnitude: number,
  preset: ShockPreset
): bigint {
  const shockedPrices = applyShock(basePrices, assetConfig, magnitude, preset);
  const token0Price = shockedPrices[reserves.token0];
  const token1Price = shockedPrices[reserves.token1];
  if (token0Price === undefined || token1Price === undefined) {
    throw new Error(`No price for smart-leg token (token0=${reserves.token0}, token1=${reserves.token1})`);
  }

  return (
    assetValueUsd8(reserves.token0RealReserves, token0Decimals, token0Price) +
    assetValueUsd8(reserves.token1RealReserves, token1Decimals, token1Price)
  );
}
