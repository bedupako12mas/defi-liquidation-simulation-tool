import type { Position, PriceVector, ShockPreset } from "./types.js";
import { isLiquidatable, totalCollateralValueUsd8 } from "./healthFactor.js";
import { isToxicLiquidation, badDebtUsd8 } from "./toxicLiquidation.js";
import { applyShock, type AssetShockConfig } from "./shockModel.js";

/**
 * NOTE ON APPROACH: this is the naive O(positions x magnitudes) sweep - for every swept
 * shock magnitude, recompute every position from scratch. context.md §6 describes a
 * sorted-kill-price index that turns this into an O(n log n) precompute + O(log n) per
 * point. That optimization is NOT implemented here - for a few dozen fixture positions
 * and ~60 sweep points this naive version is instant, and getting the math right first is
 * the actual priority (context.md's own build order: validate correctness before
 * optimizing). Treat the sorted-index version as a documented next iteration once this is
 * running against real position counts (thousands, not dozens) - see STUDY_GUIDE.md.
 */

export interface SweepPoint {
  magnitudePct: number; // e.g. -23.4 means -23.4%
  liquidatableCollateralUsd: number;
  liquidatablePositionCount: number;
  toxicPositionCount: number;
  badDebtUsd: number;
}

export interface SweepInput {
  positions: Position[];
  basePrices: PriceVector;
  assetConfig: Record<string, AssetShockConfig>;
  preset: ShockPreset;
  /** Magnitudes to sweep, as fractions (e.g. -0.1 = -10%). Capped server-side before this is called - see routes/simulate.ts. */
  magnitudes: number[];
}

const USD8 = 100_000_000; // 1e8, for converting 8-decimal fixed point to a display float

export function sweep(input: SweepInput): SweepPoint[] {
  const { positions, basePrices, assetConfig, preset, magnitudes } = input;

  return magnitudes.map((magnitude) => {
    const prices = applyShock(basePrices, assetConfig, magnitude, preset);

    let liquidatableCollateralUsd8 = 0n;
    let liquidatableCount = 0;
    let toxicCount = 0;
    let badDebtTotalUsd8 = 0n;

    for (const position of positions) {
      if (isLiquidatable(position, prices)) {
        // Valued at BASE (pre-shock) price, deliberately - not the shocked price.
        // Valuing at the shocked price makes this curve non-monotonic: as the crash
        // deepens, an already-liquidatable position's collateral is worth *less* even as
        // more positions join, so the cumulative total can dip even while things are
        // strictly getting worse. Base-price valuation answers "how much of the
        // original collateral base is now at risk" - legible, and monotonic by
        // construction. (Caught by the monotonicity test below - not an assumption,
        // a fix made because the naive version failed its own property test.)
        liquidatableCollateralUsd8 += totalCollateralValueUsd8(position, basePrices);
        liquidatableCount += 1;
        badDebtTotalUsd8 += badDebtUsd8(position, prices);
      }
      if (isToxicLiquidation(position, prices)) {
        toxicCount += 1;
      }
    }

    return {
      magnitudePct: Math.round(magnitude * 1000) / 10,
      liquidatableCollateralUsd: Number(liquidatableCollateralUsd8) / USD8,
      liquidatablePositionCount: liquidatableCount,
      toxicPositionCount: toxicCount,
      badDebtUsd: Number(badDebtTotalUsd8) / USD8,
    };
  });
}
