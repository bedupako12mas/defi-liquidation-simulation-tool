import type { Position, PriceVector } from "./types.js";

export const WAD = 10n ** 18n;
const BPS = 10_000n;

function requirePrice(prices: PriceVector, asset: string): bigint {
  const p = prices[asset];
  if (p === undefined) throw new Error(`No price for asset "${asset}"`);
  return p;
}

/**
 * USD value of an asset leg, in 8-decimal fixed point (matches the price convention).
 * amount is in the asset's native decimals; price is 8-decimal USD.
 */
export function assetValueUsd8(amount: bigint, decimals: number, price8dec: bigint): bigint {
  const scale = 10n ** BigInt(decimals);
  return (amount * price8dec) / scale;
}

export function totalCollateralValueUsd8(position: Position, prices: PriceVector): bigint {
  let total = 0n;
  for (const c of position.collateral) {
    total += assetValueUsd8(c.amount, c.decimals, requirePrice(prices, c.asset));
  }
  return total;
}

export function totalDebtValueUsd8(position: Position, prices: PriceVector): bigint {
  let total = 0n;
  for (const d of position.debt) {
    total += assetValueUsd8(d.amount, d.decimals, requirePrice(prices, d.asset));
  }
  return total;
}

/**
 * Health factor. Mirrors Aave's Pool.getUserAccountData() / GenericLogic.calculateUserAccountData:
 *
 *         Σ collateral_i * price_i * liquidationThreshold_i
 *  HF =  ─────────────────────────────────────────────────
 *                    Σ debt_j * price_j
 *
 * Returned in 1e18 fixed point - the same convention as the real on-chain `healthFactor`
 * field, so this can be diffed directly against a live `getUserAccountData` call later.
 *
 * A position with zero debt has no meaningful HF. Aave itself returns type(uint256).max
 * in that case; we return null instead so a caller can't accidentally compare it as a number.
 */
export function healthFactor(position: Position, prices: PriceVector): bigint | null {
  let adjustedCollateralUsd8 = 0n;
  for (const c of position.collateral) {
    const price = requirePrice(prices, c.asset);
    const valueUsd8 = assetValueUsd8(c.amount, c.decimals, price);
    adjustedCollateralUsd8 += (valueUsd8 * c.liquidationThresholdBps) / BPS;
  }

  const totalDebtUsd8 = totalDebtValueUsd8(position, prices);
  if (totalDebtUsd8 === 0n) return null;

  return (adjustedCollateralUsd8 * WAD) / totalDebtUsd8;
}

/** Liquidatable when HF < 1 (context.md §4). */
export function isLiquidatable(position: Position, prices: PriceVector): boolean {
  const hf = healthFactor(position, prices);
  return hf !== null && hf < WAD;
}
