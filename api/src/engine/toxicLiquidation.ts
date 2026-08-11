import type { Position, PriceVector } from "./types.js";
import { WAD, totalCollateralValueUsd8, totalDebtValueUsd8 } from "./healthFactor.js";

const BPS = 10_000n;

/**
 * Undercollateralization (UC) frontier: LTV_UC = 1 / (1 + i)
 *
 * Warmuz, Chaudhary & Pinna, "Toxic Liquidation Spirals", arXiv:2212.07306 (Dec 2022),
 * Equations 4-5 - verified against the actual paper text, not a summary of it (SCOPE.md §4.3).
 * `incentiveBps` is `i` in basis points (e.g. 450n = 4.5%, the Nov-2022 Aave USDC incentive
 * from the paper's own case study). Returned in WAD (1e18) fixed point, same scale as currentLtv().
 */
export function undercollateralizationFrontier(incentiveBps: bigint): bigint {
  return (WAD * BPS) / (BPS + incentiveBps);
}

/**
 * Current loan-to-value: plain debt/collateral value ratio - NOT threshold-weighted,
 * that's healthFactor's job. This is the paper's `LTV_init` / `LTV_fin` (their Eq. 3).
 * Returns null when collateral value is zero (ratio undefined).
 */
export function currentLtv(position: Position, prices: PriceVector): bigint | null {
  const collateral = totalCollateralValueUsd8(position, prices);
  const debt = totalDebtValueUsd8(position, prices);
  if (collateral === 0n) return null;
  return (debt * WAD) / collateral;
}

/**
 * True once a liquidation against this position would be "toxic" (paper's Eq. 4:
 * LTV_init > 1/(1+i)). Past this point, every subsequent liquidation under a fixed
 * incentive makes the position's LTV *worse*, not better - guaranteed algebraically,
 * not merely likely. This does NOT by itself mean bad debt has occurred yet (see
 * badDebtUsd8) - only that continuing to liquidate is guaranteed to create it, absent
 * a price recovery. See SCOPE.md §4.3 for the "guaranteed under current policy, not
 * physics" nuance - halting liquidations once toxic is a real, cheaper alternative the
 * paper itself demonstrates, which this simulator does not model as a policy option.
 */
export function isToxicLiquidation(position: Position, prices: PriceVector): boolean {
  const ltv = currentLtv(position, prices);
  if (ltv === null) return false;
  return ltv > undercollateralizationFrontier(position.liquidationIncentiveBps);
}

/**
 * Realized bad debt at these (frozen) prices: the shortfall once debt value exceeds
 * collateral value outright. This is a mark-to-market snapshot, not a simulated
 * liquidation replay - "if this position had to be closed out right now, at this
 * price, what's left uncovered" (SCOPE.md §4.4's sharpened definition, deliberately
 * not "seized collateral < debt", which requires simulating the liquidation itself).
 */
export function badDebtUsd8(position: Position, prices: PriceVector): bigint {
  const collateral = totalCollateralValueUsd8(position, prices);
  const debt = totalDebtValueUsd8(position, prices);
  return debt > collateral ? debt - collateral : 0n;
}
