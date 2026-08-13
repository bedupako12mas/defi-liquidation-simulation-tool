import type { Position, PriceVector, ShockPreset } from "./types.js";
import { isLiquidatable, totalCollateralValueUsd8, totalDebtValueUsd8 } from "./healthFactor.js";
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

  // Added so a comparison across very differently-sized real samples (Aave vs Fluid) is
  // possible without one side being dominated purely by having fewer/smaller positions -
  // see docs/decisions.md's "5 rigorous comparison metrics" entry. Count-based %, not
  // dollar-based, is the primary comparison field - dollar-based % is still included
  // (liquidatableCollateralPct) but is more whale-sensitive (see concentrationPct below,
  // which exists specifically to surface that sensitivity explicitly rather than hide it).
  totalPositionCount: number;
  liquidatablePositionPct: number; // 0-100, liquidatablePositionCount / totalPositionCount
  toxicPositionPct: number; // 0-100

  totalCollateralUsd: number; // base-price total across every sampled position - the % denominator
  liquidatableCollateralPct: number; // 0-100, dollar-based - still whale-sensitive, see concentrationPct

  // Largest single at-risk position's share of at-risk collateral (shocked-price valued,
  // matching routes/positions.ts's convention) - null when nothing is at risk yet. High
  // value means the dollar totals above are being driven by one/few positions, not a
  // broad-based signal - this is what makes liquidatableCollateralUsd/Pct interpretable
  // instead of misleading when a single real whale (like the ~$150M Fluid position found
  // live this session) dominates the sample.
  concentrationPct: number | null;

  // Median debt/collateral ratio (shocked-price) among positions that are actually
  // underwater (badDebtUsd8 > 0) at this magnitude - separates "many positions barely
  // underwater" from "one position catastrophically underwater", which badDebtUsd's
  // summed total alone conflates. Null when nothing is underwater yet.
  badDebtSeverityMedian: number | null;
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

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function sweep(input: SweepInput): SweepPoint[] {
  const { positions, basePrices, assetConfig, preset, magnitudes } = input;

  // Base-price total, computed once - doesn't vary by shock magnitude, same convention as
  // liquidatableCollateralUsd's own base-price valuation (see the comment on that field
  // below for why base price, not shocked price).
  let totalCollateralUsd8 = 0n;
  for (const position of positions) {
    totalCollateralUsd8 += totalCollateralValueUsd8(position, basePrices);
  }
  const totalCollateralUsd = Number(totalCollateralUsd8) / USD8;
  const totalPositionCount = positions.length;

  return magnitudes.map((magnitude) => {
    const prices = applyShock(basePrices, assetConfig, magnitude, preset);

    let liquidatableCollateralUsd8 = 0n;
    let liquidatableCount = 0;
    let toxicCount = 0;
    let badDebtTotalUsd8 = 0n;
    let largestAtRiskCollateralUsd8 = 0n;
    let atRiskCollateralUsd8ShockedSum = 0n;
    const underwaterRatios: number[] = [];

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

        // Concentration and severity use shocked-price valuation, matching
        // routes/positions.ts's toPositionSnapshot - these are diagnostic ratios, not
        // meant to be monotonic the way the dollar total above is, so the argument for
        // base-price valuation doesn't apply here.
        const shockedCollateralUsd8 = totalCollateralValueUsd8(position, prices);
        const shockedDebtUsd8 = totalDebtValueUsd8(position, prices);
        atRiskCollateralUsd8ShockedSum += shockedCollateralUsd8;
        if (shockedCollateralUsd8 > largestAtRiskCollateralUsd8) {
          largestAtRiskCollateralUsd8 = shockedCollateralUsd8;
        }
        if (shockedDebtUsd8 > shockedCollateralUsd8 && shockedCollateralUsd8 > 0n) {
          underwaterRatios.push(Number(shockedDebtUsd8) / Number(shockedCollateralUsd8));
        }
      }
      if (isToxicLiquidation(position, prices)) {
        toxicCount += 1;
      }
    }

    const liquidatableCollateralUsd = Number(liquidatableCollateralUsd8) / USD8;

    return {
      magnitudePct: Math.round(magnitude * 1000) / 10,
      liquidatableCollateralUsd,
      liquidatablePositionCount: liquidatableCount,
      toxicPositionCount: toxicCount,
      badDebtUsd: Number(badDebtTotalUsd8) / USD8,

      totalPositionCount,
      liquidatablePositionPct: totalPositionCount > 0 ? (liquidatableCount / totalPositionCount) * 100 : 0,
      toxicPositionPct: totalPositionCount > 0 ? (toxicCount / totalPositionCount) * 100 : 0,

      totalCollateralUsd,
      liquidatableCollateralPct: totalCollateralUsd > 0 ? (liquidatableCollateralUsd / totalCollateralUsd) * 100 : 0,

      concentrationPct:
        atRiskCollateralUsd8ShockedSum > 0n
          ? (Number(largestAtRiskCollateralUsd8) / Number(atRiskCollateralUsd8ShockedSum)) * 100
          : null,
      badDebtSeverityMedian: median(underwaterRatios),
    };
  });
}
