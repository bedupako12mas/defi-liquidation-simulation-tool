import type { AaveReserveConfig } from "../loaders/aaveReserveConfig.js";
import type { AssetShockConfig } from "../engine/shockModel.js";
import type { Position } from "../engine/types.js";
import { classifySymbolForShock } from "./aaveShockClassification.js";

// Matches fluidPriceResolution.ts's sentinel constant - Fluid represents native ETH with
// this address, Aave only lists WETH. Symbol-only special case (classification, not
// price) - reusing a token's real symbol across protocols isn't the same kind of
// cross-protocol dependency reusing a *price* would be (docs/decisions.md).
const FLUID_NATIVE_ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE".toLowerCase();

/**
 * Builds a shock-classification assetConfig for whatever assets actually appear in the
 * given Fluid positions, reusing Aave's already-loaded reserve symbols (no new RPC calls -
 * simulate.ts/positions.ts already fetch these live for Aave's own assetConfig). Any
 * Fluid asset not found in Aave's list (or the native-ETH sentinel) classifies as
 * "UNKNOWN" -> flat/uncorrelated, the classifier's own safe default - never guessed at.
 */
export function classifyFluidAssets(
  positions: Position[],
  aaveReserves: AaveReserveConfig[],
): Record<string, AssetShockConfig> {
  const symbolByAddress = new Map(aaveReserves.map((r) => [r.asset.toLowerCase(), r.symbol]));

  const assets = new Set<string>();
  for (const p of positions) {
    for (const c of p.collateral) assets.add(c.asset.toLowerCase());
    for (const d of p.debt) assets.add(d.asset.toLowerCase());
  }

  const assetConfig: Record<string, AssetShockConfig> = {};
  for (const asset of assets) {
    const symbol = asset === FLUID_NATIVE_ETH_SENTINEL ? "WETH" : symbolByAddress.get(asset);
    assetConfig[asset] = classifySymbolForShock(symbol ?? "UNKNOWN");
  }
  return assetConfig;
}
