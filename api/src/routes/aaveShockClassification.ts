import type { AssetShockConfig } from "../engine/shockModel.js";
import type { AaveReserveConfig } from "../loaders/aaveReserveConfig.js";

/**
 * Classifies a real Aave reserve into the engine's shock model (beta, subjectToDepeg) by
 * verified on-chain symbol pattern, not a hand-typed per-address table. Real Aave V3
 * mainnet has 67 reserves today (verified live, including ~15 Pendle PT tokens that
 * didn't exist when this project's original scoping was written) - a hardcoded address
 * list would already be stale, and hand-typing 67 addresses from memory is exactly the
 * transcription-error risk this session already hit twice (a wrong AddressesProvider
 * address, an incomplete checksum) before being caught by verification. Pattern rules
 * over a verified `symbol()` string are mechanical, reviewable, and correctly classify a
 * reserve Aave adds tomorrow without a code change.
 *
 * The shock model itself (shockModel.ts, SCOPE.md §5) is specifically about ETH/LST
 * depeg dynamics - it was never scoped to model BTC-correlated or governance-token
 * volatility. Anything outside "is this WETH or an ETH liquid-staking/restaking
 * derivative" is deliberately held flat (beta=0), not guessed at - that's the honest
 * boundary of what this shock model claims to represent, not a shortcut.
 */
/**
 * Extracted from what was previously this file's only function - the classification
 * logic only ever read reserve.symbol, nothing Aave-specific, so it's reusable as-is for
 * Fluid's assets (see routes/simulate.ts's Fluid wiring) once given a bare symbol
 * instead of a full AaveReserveConfig. Same shock model, same rules, for both protocols -
 * "same shock" means same classification for the same real token regardless of which
 * protocol holds it (docs/decisions.md).
 */
export function classifySymbolForShock(symbol: string): AssetShockConfig {
  const upper = symbol.toUpperCase();

  if (upper === "WETH") {
    return { beta: 1.0, subjectToDepeg: false }; // the reference asset itself
  }

  const ethLikeSuffixes = ["STETH", "CBETH", "RETH", "WEETH", "OSETH", "ETHX", "RSETH", "EZETH", "TETH"];
  if (ethLikeSuffixes.some((s) => upper.includes(s))) {
    return { beta: 1.0, subjectToDepeg: true }; // ETH LST/LRT - can depeg from ETH
  }

  // Everything else (BTC-correlated, stables, governance/other tokens, Pendle PT
  // wrappers) - held flat. Not part of this shock model's ETH/LST depeg story.
  return { beta: 0, subjectToDepeg: false };
}

export function classifyForShock(reserve: AaveReserveConfig): AssetShockConfig {
  return classifySymbolForShock(reserve.symbol);
}
