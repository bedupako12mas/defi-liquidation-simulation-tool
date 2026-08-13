import type { AaveReserveConfig } from "./aaveReserveConfig.js";
import type { FluidVaultConfig } from "./fluidVaultConfig.js";

const USD8 = 100_000_000n; // 1e8, matches engine/types.ts's PriceVector convention

// Real mainnet addresses, verified against Aave's own live reserve list this session
// (see docs/decisions.md) - not re-verified independently here, reusing the same
// already-confirmed constants rather than re-deriving them.
const RECOGNIZED_STABLECOINS = new Set([
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
]);

// Fluid represents native ETH with this sentinel address (verified live: a real T1
// vault's supplyToken read back as exactly this value). Aave has no equivalent - it only
// lists WETH. Used ONLY for the Aave-fallback lookup below, never for Fluid-native
// resolution (where the sentinel is just another real token address in Fluid's own graph).
const FLUID_NATIVE_ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE".toLowerCase();
const AAVE_WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();

export interface FluidPriceResolution {
  /** Lowercased token address -> USD, 8-decimal fixed point. */
  pricesUsd8: Map<string, bigint>;
  /** Tokens resolved via Aave's already-loaded prices, not Fluid's own oracle graph -
   *  logged, not silently blended in as Fluid-native (docs/decisions.md). */
  fallbackTokens: Set<string>;
  /** Tokens with no price from either source - positions using these are excluded
   *  entirely (fluidPositions.ts), not partially included. */
  unresolvedTokens: Set<string>;
}

/**
 * supplyPriceUsd8 = borrowPriceUsd8 * rawExchangeRate / 10^targetDecimals
 * (contracts/oracle/fluidOracle.sol's documented scaling - see fluidVaultConfig.ts).
 * Multiply-before-divide, all bigint - no float touches a price here.
 */
function scaleForward(borrowPriceUsd8: bigint, rawExchangeRate: bigint, targetDecimals: number): bigint {
  return (borrowPriceUsd8 * rawExchangeRate) / 10n ** BigInt(targetDecimals);
}

/** Inverse of scaleForward: borrowPriceUsd8 = supplyPriceUsd8 * 10^targetDecimals / rawExchangeRate. */
function scaleInverse(supplyPriceUsd8: bigint, rawExchangeRate: bigint, targetDecimals: number): bigint {
  return (supplyPriceUsd8 * 10n ** BigInt(targetDecimals)) / rawExchangeRate;
}

/**
 * Resolves a real USD price for every token used across the given Fluid vaults.
 *
 * Primary path: propagate outward from recognized-stablecoin anchors through Fluid's own
 * vault pairs (each vault is an edge with a known exchange rate) via fixed-point
 * iteration - small graph (<=101 edges), a handful of passes always converges. Each
 * protocol's own oracle stays authoritative for its own numbers this way (see
 * docs/decisions.md's "support both" entry) - no cross-protocol price is used unless
 * Fluid's own graph genuinely cannot reach a token.
 *
 * Fallback path: only for a token Fluid's own graph can't anchor, reuse Aave's
 * already-loaded price for the same real asset (same address, same pinned block) -
 * explicitly tracked in fallbackTokens for transparency, not silently merged in.
 *
 * Anything left over is genuinely unresolvable and reported in unresolvedTokens -
 * fluidPositions.ts excludes those positions entirely (healthFactor()/currentLtv() throw
 * on a missing price, no graceful partial path exists in the shared engine).
 */
export function resolveFluidPrices(
  vaults: FluidVaultConfig[],
  aaveReserves: AaveReserveConfig[],
): FluidPriceResolution {
  const priceUsd8 = new Map<string, bigint>();
  for (const stable of RECOGNIZED_STABLECOINS) priceUsd8.set(stable, USD8);

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const v of vaults) {
      const supply = v.supplyToken.toLowerCase();
      const borrow = v.borrowToken.toLowerCase();
      const supplyKnown = priceUsd8.has(supply);
      const borrowKnown = priceUsd8.has(borrow);

      if (borrowKnown && !supplyKnown) {
        priceUsd8.set(supply, scaleForward(priceUsd8.get(borrow)!, v.oraclePriceLiquidateRaw, v.targetDecimals));
        progressed = true;
      } else if (supplyKnown && !borrowKnown && v.oraclePriceLiquidateRaw > 0n) {
        priceUsd8.set(borrow, scaleInverse(priceUsd8.get(supply)!, v.oraclePriceLiquidateRaw, v.targetDecimals));
        progressed = true;
      }
    }
  }

  const allTokens = new Set<string>();
  for (const v of vaults) {
    allTokens.add(v.supplyToken.toLowerCase());
    allTokens.add(v.borrowToken.toLowerCase());
  }

  const fallbackTokens = new Set<string>();
  const aaveByAddress = new Map(aaveReserves.map((r) => [r.asset.toLowerCase(), r.priceUsd8]));
  for (const token of allTokens) {
    if (priceUsd8.has(token)) continue;
    const aaveKey = token === FLUID_NATIVE_ETH_SENTINEL ? AAVE_WETH_ADDRESS : token;
    const aavePrice = aaveByAddress.get(aaveKey);
    if (aavePrice !== undefined) {
      priceUsd8.set(token, aavePrice);
      fallbackTokens.add(token);
    }
  }

  const unresolvedTokens = new Set([...allTokens].filter((t) => !priceUsd8.has(t)));

  return { pricesUsd8: priceUsd8, fallbackTokens, unresolvedTokens };
}
