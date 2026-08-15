/**
 * Core domain types for the simulation engine.
 *
 * Units (context.md §4 "Units — get these right or everything is silently wrong"):
 *  - Prices: USD, 8 decimals (matches AaveOracle / Chainlink convention).
 *  - liquidationThresholdBps / liquidationIncentiveBps: basis points (1e4 = 100%).
 *  - Token amounts: asset-native decimals (WETH 18, USDC 6, etc).
 *  - All of the above are bigint end to end. No float ever touches a value that
 *    represents money. The one deliberate exception is the shock magnitude itself
 *    (a simulation *input*, not an on-chain quantity) - see shockModel.ts.
 */

export type Address = string; // symbolic asset/user id in this demo, not a checksummed address

export interface AssetAmount {
  asset: Address;
  amount: bigint;
  decimals: number;
}

export interface CollateralLeg extends AssetAmount {
  /** Mirrors Aave's ReserveConfiguration.getLiquidationThreshold() / a Fluid vault's
   *  configured liquidation threshold. Basis points, e.g. 8300n = 83%. */
  liquidationThresholdBps: bigint;
}

export type DebtLeg = AssetAmount;

export type Protocol = "aave" | "fluid";

export interface Position {
  id: string;
  protocol: Protocol;
  user: Address;
  collateral: CollateralLeg[];
  debt: DebtLeg[];
  /**
   * `i` in the toxic-liquidation formula (Warmuz, Chaudhary & Pinna, arXiv:2212.07306).
   * Aave calls this the liquidation bonus (stored on-chain as e.g. 10500 = 105%,
   * i.e. a 5% bonus - here we store the bonus itself: 500n). Basis points.
   */
  liquidationIncentiveBps: bigint;
}

/** USD, 8 decimals, keyed by asset id - matches AaveOracle.getAssetsPrices() convention. */
export type PriceVector = Record<Address, bigint>;

export interface ShockPreset {
  id: "correlated" | "mild-depeg" | "severe-depeg" | "stablecoin-depeg" | "lst-slashing-hypothetical";
  label: string;
  /** Extra underperformance of LSTs vs ETH, as a fraction (0.07 = 7%). */
  depegSpread: number;
  /** Extra underperformance of plain stablecoins vs their $1 peg, as a fraction. Separate
   *  from depegSpread - a stablecoin depeg (market-price event, e.g. USDC/SVB) and an LST
   *  depeg are different real phenomena with different real triggers, not one dial. */
  stablecoinDepegSpread: number;
  /** Which on-chain price signal this preset's depeg represents, for yield-bearing-wrapper
   *  assets specifically (wstETH, sUSDe-style - assets with both a market price and a
   *  separate internal exchange rate). "internal-exchange-rate" means the depeg represents
   *  the wrapper's own accounting rate moving (e.g. a real slashing event) - the case
   *  Fluid's avoidForcedLiquidations guardian flag can dampen. "market" means an ordinary
   *  market-price move, which passes through uncapped for every asset regardless of
   *  wrapper status. Irrelevant (omit) for plain, non-wrapped assets - a stablecoin or ETH
   *  itself only ever has one price, so the distinction doesn't apply to them at all.
   *  Confirmed against real source this session, not assumed - see fluidCappedRate.sol's
   *  getExchangeRateLiquidate() vs the raw Chainlink ETH/USD feed. */
  priceComponent?: "market" | "internal-exchange-rate";
  /** True for presets with no real historical event to cite (a hypothetical stress test,
   *  e.g. a slashing scenario that's never happened at scale) - must be surfaced to the
   *  user as explicitly hypothetical, not presented with the same evidentiary weight as a
   *  preset grounded in a real, cited event. */
  isHypothetical?: boolean;
  citation: string;
}
