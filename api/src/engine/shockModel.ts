import type { PriceVector, ShockPreset } from "./types.js";

/**
 * Named shock presets. context.md §7: a shock is a per-asset price vector, not a single
 * global multiplier - stables held flat, ETH-correlated LSTs move via a beta plus an
 * additional depeg spread that only bites on the downside.
 *
 * Calibration provenance (SCOPE.md §5, independently verified this session):
 *  - severe-depeg's 7% is grounded in the real June 2022 stETH event: stETH traded at
 *    0.9474 ETH on Curve at 21:00 UTC, June 10 2022 (~5% discount), widening to roughly
 *    6-7% mid-June as Celsius/3AC/Alameda unwound leveraged positions. Verified against
 *    independent reporting, not taken on a research summary's word.
 *  - mild-depeg has NO comparably large historical LRT depeg to calibrate against; the
 *    1-3% range is an illustrative normal-stress assumption, stated as such deliberately
 *    (SCOPE.md §14 limitation: "correlation/depeg betas are assumptions, not fitted from
 *    data").
 */
export const SHOCK_PRESETS: Record<ShockPreset["id"], ShockPreset> = {
  correlated: {
    id: "correlated",
    label: "Correlated (no depeg)",
    depegSpread: 0,
    citation: "Normal-regime behaviour: LSTs track ETH ~1:1 (beta ≈ 1.0), no additional spread.",
  },
  "mild-depeg": {
    id: "mild-depeg",
    label: "Mild depeg",
    depegSpread: 0.02,
    citation:
      "Illustrative normal-stress spread (1-3% range) - no large historical LRT depeg exists to calibrate against. Assumption, not fitted data.",
  },
  "severe-depeg": {
    id: "severe-depeg",
    label: "Severe depeg",
    depegSpread: 0.07,
    citation:
      "Grounded in the real June 2022 stETH depeg: 0.9474 ETH on Curve, 21:00 UTC June 10 2022, widening to ~6-7% mid-June (Celsius/3AC/Alameda unwind).",
  },
};

export interface AssetShockConfig {
  /** Correlation beta relative to the shock driver (ETH). 1.0 = moves 1:1 with ETH, 0 = unaffected. */
  beta: number;
  /** Whether the preset's depeg spread applies to this asset (true for LSTs, false for ETH itself and stables). */
  subjectToDepeg: boolean;
}

/**
 * Builds a shocked price vector from a base price vector, a shock magnitude (fraction,
 * e.g. -0.1 = -10%), and a named correlation preset.
 *
 * Deliberate, bounded exception to the "no float on money" rule: the shock magnitude and
 * beta are simulation *inputs* (hypothetical parameters), not on-chain accounted
 * quantities - the float math happens only here, at the boundary where a hypothetical
 * price is constructed, and the result is rounded back to an integer 8-decimal price
 * before anything downstream (healthFactor, toxicLiquidation) ever sees it. Every dollar
 * value derived from this price is bigint from that point on.
 */
export function applyShock(
  basePrices: PriceVector,
  assetConfig: Record<string, AssetShockConfig>,
  magnitude: number,
  preset: ShockPreset
): PriceVector {
  const shocked: PriceVector = {};
  for (const [asset, basePrice] of Object.entries(basePrices)) {
    const cfg = assetConfig[asset] ?? { beta: 0, subjectToDepeg: false };
    let multiplier = 1 + cfg.beta * magnitude;
    // Depeg only bites on the downside, and only for assets flagged as LST/correlated.
    if (cfg.subjectToDepeg && magnitude < 0) {
      multiplier *= 1 - preset.depegSpread;
    }
    if (multiplier < 0) multiplier = 0;
    shocked[asset] = BigInt(Math.round(Number(basePrice) * multiplier));
  }
  return shocked;
}

/**
 * Safe presetId lookup - `SHOCK_PRESETS[presetId as keyof typeof SHOCK_PRESETS]` (what
 * two API routes originally did independently) inherits Object.prototype, so a caller
 * passing presetId=constructor/toString/hasOwnProperty/valueOf resolves to a truthy
 * function instead of undefined, bypassing an `if (!preset)` guard entirely - confirmed
 * live in review, and it crashes downstream (`preset.depegSpread` is undefined, so
 * applyShock's multiplier becomes NaN, and BigInt(NaN) throws a RangeError). Guarding
 * with hasOwnProperty closes that off at the one place both callers should share, instead
 * of two independent copies of the same fragile lookup.
 */
export function getShockPreset(presetId: string | undefined): ShockPreset | undefined {
  if (presetId === undefined) return undefined;
  if (!Object.prototype.hasOwnProperty.call(SHOCK_PRESETS, presetId)) return undefined;
  return SHOCK_PRESETS[presetId as keyof typeof SHOCK_PRESETS];
}

/**
 * Fixed, server-controlled sweep range - never derived from a request parameter. Shared
 * across every route that sweeps a full magnitude range (simulate.ts, killPrice.ts's
 * consumers) so there's one definition, not independent copies that could drift.
 * context.md §10 "denial of wallet": capping sweep granularity server-side is the point.
 */
export function sweepMagnitudes(): number[] {
  const out: number[] = [];
  for (let pct = 0; pct >= -80; pct -= 1) out.push(pct / 100);
  return out;
}
