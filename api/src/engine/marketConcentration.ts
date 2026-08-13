import type { Position, PriceVector } from "./types.js";
import { isLiquidatable, assetValueUsd8 } from "./healthFactor.js";

export interface MarketConcentrationEntry {
  /** Aave: the debt asset's symbol (falls back to address if unknown) - the reserve is
   *  Aave's real isolated-market unit. Fluid: the vault address - the vault is Fluid's
   *  real isolated-market unit. Deliberately not the same kind of key across protocols -
   *  each protocol's own actual market boundary, not a forced-common shape. */
  market: string;
  atRiskDebtUsd: number;
  /** Aave: a position can appear under multiple markets (multiple debt legs) - this
   *  counts leg-contributions, not distinct positions, so summing across markets for
   *  Aave will exceed the total eligible/toxic position count. That's correct for "how
   *  much at-risk debt is denominated in this reserve", not a bug. Fluid: always 1:1
   *  with positions, since a Fluid position has exactly one debt leg. */
  contributingLegCount: number;
}

const USD8 = 100_000_000n;

/** Aave: group at-risk debt by which reserve (asset) it's denominated in - the leg
 *  level, not the position level, since one position can hold debt in several reserves
 *  simultaneously. symbolByAddress is optional; falls back to the raw address. */
export function aaveMarketConcentration(
  positions: Position[],
  prices: PriceVector,
  symbolByAddress: Map<string, string> = new Map(),
): MarketConcentrationEntry[] {
  const byMarket = new Map<string, { usd8: bigint; count: number }>();

  for (const position of positions) {
    if (!isLiquidatable(position, prices)) continue;
    for (const leg of position.debt) {
      const valueUsd8 = assetValueUsd8(leg.amount, leg.decimals, prices[leg.asset] ?? 0n);
      const market = symbolByAddress.get(leg.asset.toLowerCase()) ?? leg.asset;
      const entry = byMarket.get(market) ?? { usd8: 0n, count: 0 };
      entry.usd8 += valueUsd8;
      entry.count += 1;
      byMarket.set(market, entry);
    }
  }

  return [...byMarket.entries()]
    .map(([market, { usd8, count }]) => ({
      market,
      atRiskDebtUsd: Number(usd8) / Number(USD8),
      contributingLegCount: count,
    }))
    .sort((a, b) => b.atRiskDebtUsd - a.atRiskDebtUsd);
}

/** Fluid: group at-risk debt by vault - parsed from the position id's `fluid-<vault>-
 *  <nftId>` format (fluidPositions.ts's write-time encoding), not a new lookup. Always
 *  1:1 with positions since a Fluid position has exactly one debt leg (decision #1). */
export function fluidMarketConcentration(positions: Position[], prices: PriceVector): MarketConcentrationEntry[] {
  const byVault = new Map<string, { usd8: bigint; count: number }>();

  for (const position of positions) {
    if (!isLiquidatable(position, prices)) continue;
    const match = /^fluid-(0x[a-f0-9]+)-\d+$/.exec(position.id);
    const vault = match?.[1] ?? "unknown-vault";

    let usd8 = 0n;
    for (const leg of position.debt) {
      usd8 += assetValueUsd8(leg.amount, leg.decimals, prices[leg.asset] ?? 0n);
    }

    const entry = byVault.get(vault) ?? { usd8: 0n, count: 0 };
    entry.usd8 += usd8;
    entry.count += 1;
    byVault.set(vault, entry);
  }

  return [...byVault.entries()]
    .map(([market, { usd8, count }]) => ({
      market,
      atRiskDebtUsd: Number(usd8) / Number(USD8),
      contributingLegCount: count,
    }))
    .sort((a, b) => b.atRiskDebtUsd - a.atRiskDebtUsd);
}
