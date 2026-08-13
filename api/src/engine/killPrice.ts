import type { Position, PriceVector, ShockPreset } from "./types.js";
import { isLiquidatable } from "./healthFactor.js";
import { applyShock, type AssetShockConfig } from "./shockModel.js";

export interface KillPriceResult {
  id: string;
  /** Shock magnitude (fraction, e.g. -0.23) at which this position first becomes
   *  liquidatable/eligible, scanning the same 0 to -80%, 1% grid as the sweep. Null if it
   *  never crosses within that range - a real, meaningful answer ("safe even at -80%"),
   *  not a missing value. */
  killMagnitudePct: number | null;
}

/**
 * Per-position headroom: at what shock does THIS position cross its own threshold,
 * rather than "how much is liquidatable at shock X" (sweep.ts's question, aggregated
 * across positions). Answers "how fragile is a typical position" - a distribution,
 * robust to sample-size and whale-domination in a way a summed dollar total isn't. Same
 * O(positions x magnitudes) approach as sweep.ts, same reasoning for not optimizing yet
 * (see that file's note) - real position counts (thousands) still run this in well under
 * a second, pure arithmetic on already-loaded data, no RPC calls.
 */
export function computeKillMagnitudes(
  positions: Position[],
  basePrices: PriceVector,
  assetConfig: Record<string, AssetShockConfig>,
  preset: ShockPreset,
  magnitudes: number[],
): KillPriceResult[] {
  // Sort so we scan from 0 toward -80% - the first crossing found while iterating is
  // guaranteed to be the true first crossing since we're going in shock-severity order.
  const sortedMagnitudes = [...magnitudes].sort((a, b) => b - a);

  return positions.map((position) => {
    for (const magnitude of sortedMagnitudes) {
      const prices = applyShock(basePrices, assetConfig, magnitude, preset);
      if (isLiquidatable(position, prices)) {
        return { id: position.id, killMagnitudePct: Math.round(magnitude * 1000) / 10 };
      }
    }
    return { id: position.id, killMagnitudePct: null };
  });
}
