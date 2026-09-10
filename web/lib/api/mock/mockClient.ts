/**
 * Reads `fixtures.generated.json` (produced by `scripts/generate-mock-fixtures.ts` from the
 * real, tested `api/src/engine` - see that script's top comment) and serves it through the
 * exact return shapes `meta.ts`/`simulate.ts` expose to the rest of the app. Every function
 * here is imported dynamically (`await import("./mock/mockClient")`) from those two files
 * only when `USE_MOCK` is true, so none of this ships in a build that talks to the real API.
 */

import fixtures from "./fixtures.generated.json";
import type { MetaResponse, ShockPreset } from "../meta";
import type { Protocol, DrilldownProtocol, PositionSnapshot, SweepPoint, KillPriceResult, MarketConcentrationEntry } from "../simulate";
import type { ValidationProtocol, ValidationResult } from "../validation";
import type { ProfitabilityProtocol, LiquidationProfitability } from "../profitability";
import type { ChainedProtocol, ChainedLiquidationResult } from "../chainedLiquidation";
import type { CappedRateBreachResult } from "../cappedRateBreach";
import type { FluidT2ShockResult } from "../fluidT2Shock";
import type { FluidT3ShockResult } from "../fluidT3Shock";
import type { FluidT4ShockResult } from "../fluidT4Shock";

type FixturesShape = {
  meta: MetaResponse;
  sweeps: Record<string, { aave: SweepPoint[]; fluid: SweepPoint[] }>;
  positionSnapshots: Record<string, { aave: Record<string, PositionSnapshot[]>; fluid: Record<string, PositionSnapshot[]> }>;
  killPrices: Record<string, { aave: KillPriceResult[]; fluid: KillPriceResult[] }>;
  marketConcentration: Record<
    string,
    { aave: Record<string, MarketConcentrationEntry[]>; fluid: Record<string, MarketConcentrationEntry[]> }
  >;
};

const data = fixtures as unknown as FixturesShape;

export async function getMockMeta(): Promise<MetaResponse> {
  return data.meta;
}

export function getMockPreset(presetId: string): ShockPreset | undefined {
  return data.meta.presets.find((p) => p.id === presetId);
}

export function getMockSweep(presetId: string, protocol: Protocol): SweepPoint[] {
  const forPreset = data.sweeps[presetId];
  if (!forPreset) return [];
  return forPreset[protocol];
}

/** Snaps to the nearest available magnitude key in the (coarser) position-snapshot grid. */
function nearestMagnitudeKey(available: string[], magnitudePct: number): string {
  let best = available[0]!;
  let bestDist = Infinity;
  for (const key of available) {
    const dist = Math.abs(Number(key) - magnitudePct);
    if (dist < bestDist) {
      bestDist = dist;
      best = key;
    }
  }
  return best;
}

// aave-v4 has no fixtures generated for it (generate-mock-fixtures.ts only runs the
// engine for "aave"/"fluid" - see its own top comment) - mock mode returns a real,
// honest empty result for it rather than fabricating rows, the same way the live API
// returns [] when no aave-v4 snapshot has been synced yet (routes/positions.ts).
export async function getMockPositionSnapshot(
  presetId: string,
  magnitudePct: number,
  protocol: DrilldownProtocol
): Promise<PositionSnapshot[]> {
  if (protocol === "aave-v4") return [];
  const forPreset = data.positionSnapshots[presetId];
  if (!forPreset) return [];
  const byMagnitude = forPreset[protocol];
  const keys = Object.keys(byMagnitude);
  const key = nearestMagnitudeKey(keys, magnitudePct);
  return byMagnitude[key] ?? [];
}

export async function getMockKillPrices(presetId: string, protocol: DrilldownProtocol): Promise<KillPriceResult[]> {
  if (protocol === "aave-v4") return [];
  const forPreset = data.killPrices[presetId];
  if (!forPreset) return [];
  return forPreset[protocol];
}

/** Illustrative, not literally live data (mock mode has no real chain to call) - but shaped
 *  and proportioned to match a real sync run's actual outcome distribution (docs/decisions.md's
 *  #30/#36 entry: 3 exact matches, 9 within-drift, 5 real HF-race reverts for Aave; 25/25
 *  swept for the Fluid positions the disclosed oracle-hop coverage actually reaches), so mock
 *  mode demonstrates the real range of honest outcomes, not just the happy path. */
const MOCK_VALIDATION_RESULTS: ValidationResult[] = [
  { protocol: "aave", positionId: "aave-0x1a2b3c4d5e6f70819293a4b5c6d7e8f901234567", presetId: "correlated", magnitudePct: "-30.00", status: "matched", expectedAmount: "120247427417", actualAmount: "120247427417", debtAssetSymbol: "USDC", debtAssetDecimals: 6, actualCollateralAmount: null, collateralAssetSymbol: "WETH", collateralAssetDecimals: 18, detail: null, createdAt: "2026-08-16T03:50:00Z" },
  { protocol: "aave", positionId: "aave-0x2b3c4d5e6f70819293a4b5c6d7e8f9012345678a", presetId: "correlated", magnitudePct: "-30.00", status: "matched-within-drift", expectedAmount: "39779651744", actualAmount: "39779652184", debtAssetSymbol: "USDC", debtAssetDecimals: 6, actualCollateralAmount: null, collateralAssetSymbol: "wstETH", collateralAssetDecimals: 18, detail: "0.0011% - consistent with unpinned-block interest accrual, not a logic error", createdAt: "2026-08-16T03:50:00Z" },
  { protocol: "aave", positionId: "aave-0x3c4d5e6f70819293a4b5c6d7e8f9012345678ab1", presetId: "correlated", magnitudePct: "-30.00", status: "unexpected-revert", expectedAmount: null, actualAmount: null, debtAssetSymbol: "USDC", debtAssetDecimals: 6, actualCollateralAmount: null, collateralAssetSymbol: "WETH", collateralAssetDecimals: 18, detail: "HealthFactorNotBelowThreshold (position's real on-chain HF wasn't actually below 1 at call time)", createdAt: "2026-08-16T03:50:00Z" },
  { protocol: "fluid", positionId: "fluid-0x009d7471fc3bd28fc45495d38978287fdf39416d-118", presetId: "lst-depeg", magnitudePct: "-3", status: "swept", expectedAmount: null, actualAmount: "21175223775", debtAssetSymbol: "USDC", debtAssetDecimals: 6, actualCollateralAmount: "20145631548358530415456", collateralAssetSymbol: "wstETH", collateralAssetDecimals: 18, detail: null, createdAt: "2026-08-16T03:50:00Z" },
  { protocol: "fluid", positionId: "fluid-0x18b3aa2be6f10d0ea7f4491913a9e4dfa02c1b60-42", presetId: "lst-depeg", magnitudePct: "-5", status: "swept", expectedAmount: null, actualAmount: "253232000792", debtAssetSymbol: "USDT", debtAssetDecimals: 6, actualCollateralAmount: "249547975323302787906125", collateralAssetSymbol: "weETH", collateralAssetDecimals: 18, detail: null, createdAt: "2026-08-16T03:50:00Z" },
  { protocol: "fluid", positionId: "fluid-0x18b3aa2be6f10d0ea7f4491913a9e4dfa02c1b60-77", presetId: "lst-depeg", magnitudePct: "0", status: "not-applicable", expectedAmount: null, actualAmount: null, debtAssetSymbol: null, debtAssetDecimals: null, actualCollateralAmount: null, collateralAssetSymbol: null, collateralAssetDecimals: null, detail: "No yield-wrapper (Fluid-type) hop in this vault's oracle - LST-depeg scenario doesn't apply to this vault", createdAt: "2026-08-16T03:50:00Z" },
];

export async function getMockValidationResults(protocol?: ValidationProtocol): Promise<ValidationResult[]> {
  if (!protocol) return MOCK_VALIDATION_RESULTS;
  return MOCK_VALIDATION_RESULTS.filter((r) => r.protocol === protocol);
}

/** Illustrative, shaped to match a real sync run's actual outcome distribution
 *  (docs/decisions.md's #43 entry: real net profits from $139 to $18,155 on real matched
 *  positions, real unprofitable dust-scale cases, real MustNotLeaveDust/never-liquidatable
 *  disclosed outcomes) - same discipline as the validation-results mock above.
 *  The multiple Fluid "unable-to-validate" rows are deliberate, not padding: a real deployed
 *  run showed EVERY sampled Fluid position landing here (confirmed live, not hypothetical) -
 *  this shape is what motivated ProfitabilityTable's no-signal-row collapsing, and exercises
 *  both real grouped reasons (never-liquidatable vs. unsupported-oracle). */
const MOCK_LIQUIDATION_PROFITABILITY: LiquidationProfitability[] = [
  { protocol: "aave", positionId: "aave-0x4c5d6e7f8091a2b3c4d5e6f78091a2b3c4d5e6f7", presetId: "correlated", magnitudePct: "-20", gasUsed: "528196", gasCostUsd8: "3030000", debtClearedUsd8: "1351157000000", bonusValueUsd8: "1418715000000", netProfitUsd8: "67555000000", status: "profitable", detail: null, createdAt: "2026-08-16T07:24:00Z" },
  { protocol: "aave", positionId: "aave-0x5d6e7f8091a2b3c4d5e6f78091a2b3c4d5e6f780", presetId: "correlated", magnitudePct: "-30", gasUsed: "357168", gasCostUsd8: "2320000", debtClearedUsd8: "17094935", bonusValueUsd8: "17949681", netProfitUsd8: "-2407811", status: "unprofitable", detail: null, createdAt: "2026-08-16T07:24:00Z" },
  { protocol: "aave", positionId: "aave-0x6e7f8091a2b3c4d5e6f78091a2b3c4d5e6f78091", presetId: "correlated", magnitudePct: "-65", gasUsed: null, gasCostUsd8: null, debtClearedUsd8: null, bonusValueUsd8: null, netProfitUsd8: null, status: "unable-to-estimate-gas", detail: "MustNotLeaveDust (real Aave dust-avoidance rule, not yet modeled in computeExpectedMaxLiquidatableDebt)", createdAt: "2026-08-16T07:24:00Z" },
  { protocol: "aave", positionId: "aave-0x7f8091a2b3c4d5e6f78091a2b3c4d5e6f780912a", presetId: "correlated", magnitudePct: "-50", gasUsed: null, gasCostUsd8: null, debtClearedUsd8: null, bonusValueUsd8: null, netProfitUsd8: null, status: "unable-to-validate", detail: "never became liquidatable within the tested magnitude range", createdAt: "2026-08-16T07:24:00Z" },
  { protocol: "fluid", positionId: "fluid-0x009d7471fc3bd28fc45495d38978287fdf39416d-118", presetId: "correlated", magnitudePct: "-80", gasUsed: null, gasCostUsd8: null, debtClearedUsd8: null, bonusValueUsd8: null, netProfitUsd8: null, status: "unable-to-validate", detail: "no sweep within the tested range (HF=1.0959)", createdAt: "2026-08-16T07:24:00Z" },
  { protocol: "fluid", positionId: "fluid-0x18b3aa2be6f10d0ea7f4491913a9e4dfa02c1b60-42", presetId: "correlated", magnitudePct: "-80", gasUsed: null, gasCostUsd8: null, debtClearedUsd8: null, bonusValueUsd8: null, netProfitUsd8: null, status: "unable-to-validate", detail: "no sweep within the tested range (HF=1.0996)", createdAt: "2026-08-16T07:24:00Z" },
  { protocol: "fluid", positionId: "fluid-0x238207734adbd22037af0437ef65f13babbd1917-9718", presetId: "correlated", magnitudePct: "-80", gasUsed: null, gasCostUsd8: null, debtClearedUsd8: null, bonusValueUsd8: null, netProfitUsd8: null, status: "unable-to-validate", detail: "no sweep within the tested range (HF=1.0999)", createdAt: "2026-08-16T07:24:00Z" },
  { protocol: "fluid", positionId: "fluid-0x888f89dd277a3e69c3607f67ded93877ed359ba7-7506", presetId: "correlated", magnitudePct: "0", gasUsed: null, gasCostUsd8: null, debtClearedUsd8: null, bonusValueUsd8: null, netProfitUsd8: null, status: "unable-to-validate", detail: "Oracle doesn't expose getOracleHopSources() - not a recognized GenericOracle instance", createdAt: "2026-08-16T07:24:00Z" },
  { protocol: "fluid", positionId: "fluid-0xece156bed5af2621b80b87ff4fe8fd3a929e3644-10149", presetId: "correlated", magnitudePct: "0", gasUsed: null, gasCostUsd8: null, debtClearedUsd8: null, bonusValueUsd8: null, netProfitUsd8: null, status: "unable-to-validate", detail: "Oracle doesn't expose getOracleHopSources() - not a recognized GenericOracle instance", createdAt: "2026-08-16T07:24:00Z" },
];

export async function getMockLiquidationProfitability(protocol?: ProfitabilityProtocol): Promise<LiquidationProfitability[]> {
  if (!protocol) return MOCK_LIQUIDATION_PROFITABILITY;
  return MOCK_LIQUIDATION_PROFITABILITY.filter((r) => r.protocol === protocol);
}

/** These are the ACTUAL real result of a real sync-chained-liquidation.ts run (#37/#38,
 *  docs/decisions.md) - not illustrative.
 *  Aave: a real reserve-index-drift effect - tiny (~0.000001% of the isolated amount) but
 *  genuinely nonzero, a fork-only-observable effect an isolated eth_call cannot detect.
 *  Fluid: liquidate() is vault-level/tick-based (not per-user), so A and B request the
 *  IDENTICAL full vault debt amount - the real, decisive, reproducible finding (confirmed
 *  across all 5 real candidates found) is a full 100% consumption: once A's real liquidation
 *  takes what's genuinely available, B's identical follow-up request finds exactly zero left,
 *  unlike Aave's marginal drift - a qualitatively different, more consequential real effect. */
const MOCK_CHAINED_LIQUIDATION: ChainedLiquidationResult[] = [
  { protocol: "aave", presetId: "correlated", magnitudePct: "-30", positionAId: "aave-0xbccbaad9c7a2ef2f4d4007c5ad1fed3786e14fff", positionBId: "aave-0x20a21207fb4b11cd2b3d0dfc779d622cf13e0a5e", debtAssetSymbol: "USDT", debtAssetDecimals: 6, positionATxStatus: "success", isolatedStatus: "liquidated", isolatedDebtRepaid: "4413040418", chainedStatus: "liquidated", chainedDebtRepaid: "4413040448", debtRepaidDiff: "30", debtRepaidDiffPct: "0.000001", detail: null, createdAt: "2026-08-16T10:43:08.238Z" },
  { protocol: "fluid", presetId: "lst-depeg", magnitudePct: "-3", positionAId: "fluid-0xAf1a5Ce79f93b9F157cd10b3aABeF151236bA6B7-request-A", positionBId: "fluid-0xAf1a5Ce79f93b9F157cd10b3aABeF151236bA6B7-request-B", debtAssetSymbol: "USDC", debtAssetDecimals: 6, positionATxStatus: "success", isolatedStatus: "swept", isolatedDebtRepaid: "1559895", chainedStatus: "swept", chainedDebtRepaid: "0", debtRepaidDiff: "-1559895", debtRepaidDiffPct: "-100.000000", detail: "A and B request the IDENTICAL full totalBorrowVault amount (Fluid's liquidate() is vault-level/tick-based, not per-user) - a real diff here measures real tick consumption, not index drift.", createdAt: "2026-08-16T10:43:08.238Z" },
  { protocol: "fluid", presetId: "lst-depeg", magnitudePct: "-5", positionAId: "fluid-0xc8Ea45f5af4eeb4DD226928d7E93440547B59C7D-request-A", positionBId: "fluid-0xc8Ea45f5af4eeb4DD226928d7E93440547B59C7D-request-B", debtAssetSymbol: "USDT", debtAssetDecimals: 6, positionATxStatus: "success", isolatedStatus: "swept", isolatedDebtRepaid: "22657493", chainedStatus: "swept", chainedDebtRepaid: "0", debtRepaidDiff: "-22657493", debtRepaidDiffPct: "-100.000000", detail: "A and B request the IDENTICAL full totalBorrowVault amount (Fluid's liquidate() is vault-level/tick-based, not per-user) - a real diff here measures real tick consumption, not index drift.", createdAt: "2026-08-16T10:43:08.238Z" },
  { protocol: "fluid", presetId: "lst-depeg", magnitudePct: "-30", positionAId: "fluid-0x13F82C0c281a3B973A7288d3ebc468495AA4Eed7-request-A", positionBId: "fluid-0x13F82C0c281a3B973A7288d3ebc468495AA4Eed7-request-B", debtAssetSymbol: "GHO", debtAssetDecimals: 18, positionATxStatus: "success", isolatedStatus: "swept", isolatedDebtRepaid: "10516739316072448049", chainedStatus: "swept", chainedDebtRepaid: "0", debtRepaidDiff: "-10516739316072448049", debtRepaidDiffPct: "-100.000000", detail: "A and B request the IDENTICAL full totalBorrowVault amount (Fluid's liquidate() is vault-level/tick-based, not per-user) - a real diff here measures real tick consumption, not index drift.", createdAt: "2026-08-16T10:43:08.238Z" },
  // Real result from Deploy 2/6 (#66, T2 fork tier) - a real WEETH/ETH smart-collateral
  // vault, real -65% depeg via a real oracle-bytecode override, real mined liquidate() (the
  // real six-param signature, not T1's four - see docs/decisions.md's 2026-09-03 entry). The
  // exact same 100% consumption effect as T1, confirmed live.
  { protocol: "fluid-t2", presetId: "correlated", magnitudePct: "-65", positionAId: "fluid-t2-0xb4a15526d427f4d20b0dAdaF3baB4177C85A699A-request-A", positionBId: "fluid-t2-0xb4a15526d427f4d20b0dAdaF3baB4177C85A699A-request-B", debtAssetSymbol: "WSTETH", debtAssetDecimals: 18, positionATxStatus: "success", isolatedStatus: "swept", isolatedDebtRepaid: "1334821146350000704", chainedStatus: "not-applicable", chainedDebtRepaid: null, debtRepaidDiff: null, debtRepaidDiffPct: null, detail: "A and B request the IDENTICAL full totalBorrowVault amount (Fluid's liquidate() is vault-level/tick-based, not per-user, for every vault type including T2) - a real diff here measures real tick consumption, not index drift.", createdAt: "2026-09-03T05:00:00.000Z" },
  // Real result from Deploy 4/6 (#68, T3 fork tier) - a real vault, real -5% depeg, real
  // mined liquidate() (the real six-param debt-side signature). Genuinely different from
  // T1/T2: a small, nonzero amount remains liquidatable afterward, not exactly zero - an
  // honest approximation gap converting "shares genuinely liquidatable" into the debt
  // pool's two real token amounts, not a different underlying mechanism. debtAssetSymbol/
  // Decimals are null - actualDebtAmt_ for a smart-debt vault is in debt-SHARE units, not a
  // single real token's amount.
  { protocol: "fluid-t3", presetId: "correlated", magnitudePct: "-5", positionAId: "fluid-t3-0xC8c9EF21613eB49F6959252154eE8632E40A67Ce-request-A", positionBId: "fluid-t3-0xC8c9EF21613eB49F6959252154eE8632E40A67Ce-request-B", debtAssetSymbol: null, debtAssetDecimals: null, positionATxStatus: "success", isolatedStatus: "swept", isolatedDebtRepaid: "105571155409783929901911", chainedStatus: "swept", chainedDebtRepaid: "63724952195345243", debtRepaidDiff: "-105571091684831734556668", debtRepaidDiffPct: "-99.999940", detail: "A and B request the IDENTICAL real per-vault-share debt repayment (Fluid's liquidate() is vault-level/tick-based, not per-user, for every vault type including T3) - a real diff here measures real tick consumption, not index drift.", createdAt: "2026-09-03T06:00:00.000Z" },
  // Real result from Deploy 6/6 (#70, T4 fork tier) - a real two-pool T4 vault, real -3%
  // depeg, real mined liquidate() (the real 8-param signature - T3's debt params concatenated
  // with T2's collateral params). Same T3-style genuinely-nonzero residual, not T1/T2's exact
  // zero - confirmed live, not assumed to transfer just because the code does. Building this
  // also found and fixed a real cross-tier bug: eth_estimateGas undershot for two real T4
  // candidates (empty-revert-data reverts on a mined tx, indistinguishable from an
  // unrecognized error until traced) - fixed with an explicit gas limit, applied to every
  // Fluid tier once a T3 candidate was directly observed hitting the same failure.
  { protocol: "fluid-t4", presetId: "correlated", magnitudePct: "-3", positionAId: "fluid-t4-0xB170B94BeFe21098966aa9905Da6a2F569463A21-request-A", positionBId: "fluid-t4-0xB170B94BeFe21098966aa9905Da6a2F569463A21-request-B", debtAssetSymbol: null, debtAssetDecimals: null, positionATxStatus: "success", isolatedStatus: "swept", isolatedDebtRepaid: "7820185448014809619", chainedStatus: "swept", chainedDebtRepaid: "16565337584298", debtRepaidDiff: "-7820168882677225321", debtRepaidDiffPct: "-99.999788", detail: "A and B request the IDENTICAL real per-vault-share debt repayment (Fluid's liquidate() is vault-level/tick-based, not per-user, for every vault type including T4) - a real diff here measures real tick consumption, not index drift.", createdAt: "2026-09-03T07:56:48.801Z" },
];

export async function getMockChainedLiquidation(protocol?: ChainedProtocol): Promise<ChainedLiquidationResult[]> {
  if (!protocol) return MOCK_CHAINED_LIQUIDATION;
  return MOCK_CHAINED_LIQUIDATION.filter((r) => r.protocol === protocol);
}

/** The ACTUAL real result of a real sync-capped-rate-breach.ts run (#38, SCOPE.md item 3b) -
 *  not illustrative. All 10 real, currently-fresh CappedRate vaults swept show the SAME
 *  verdict: avoidForcedLiquidationsCol_ is false for every one of them - a real, decisive,
 *  protocol-wide pattern (not a per-vault quirk), meaning Fluid's down-cap protection for the
 *  collateral leg is administratively disabled across every vault checked right now. An
 *  earlier draft of this test reported a misleadingly reassuring "protection works" verdict
 *  by checking only the numeric bound (100% >= 100%, vacuously true) - fixed to check the
 *  real admin-set gate directly before drawing a conclusion. */
const MOCK_CAPPED_RATE_BREACH: CappedRateBreachResult[] = [
  { vault: "0xee327311D8640156E87eC33ea55FcbF2309e0ce6", cappedRateAddress: "0x1FC9a029e8e84cF0C5c7c68221bE5d1573c0FB05", minHeartbeatSeconds: 90000, avoidForcedLiquidationsCol: false, maxDownFromMaxReachedPctCol: "1000000", rateBefore: "1132966158918315225640531776", rateImmediatelyAfterOverride: "1132966158918315225640531776", rateAfterHeartbeat: "1", realDropPct: "100.000000", verdict: "protection-disabled", createdAt: "2026-08-16T11:13:03.737Z" },
  { vault: "0xAf1a5Ce79f93b9F157cd10b3aABeF151236bA6B7", cappedRateAddress: "0x05Cad896ED76F080bAB4da37c407928B994fF9B3", minHeartbeatSeconds: 90000, avoidForcedLiquidationsCol: false, maxDownFromMaxReachedPctCol: "1000000", rateBefore: "1178499614161355102652993425", rateImmediatelyAfterOverride: "1178499614161355102652993425", rateAfterHeartbeat: "1", realDropPct: "100.000000", verdict: "protection-disabled", createdAt: "2026-08-16T11:13:03.737Z" },
  { vault: "0xcf3D09dA35bc6Af5d80544DaA97F4aFDdC4D7437", cappedRateAddress: "0x40DE3E66D6E267Cff8A97a45B9c12388a9a32352", minHeartbeatSeconds: 90000, avoidForcedLiquidationsCol: false, maxDownFromMaxReachedPctCol: "1000000", rateBefore: "1139051427573356400726397570", rateImmediatelyAfterOverride: "1139051427573356400726397570", rateAfterHeartbeat: "1", realDropPct: "100.000000", verdict: "protection-disabled", createdAt: "2026-08-16T11:13:03.737Z" },
];

export async function getMockCappedRateBreach(): Promise<CappedRateBreachResult[]> {
  return MOCK_CAPPED_RATE_BREACH;
}

// Real rows from a local sync run (Deploy 1/6) - one real T2 vault (WBTC-cbBTC smart
// collateral, USDC normal debt) at three representative magnitudes, correlated preset only
// (a small, illustrative slice - the real table has 6,480 rows across 16 vaults x 5 presets
// x 81 magnitudes).
const MOCK_FLUID_T2_SHOCK: FluidT2ShockResult[] = [
  { vault: "0x5eb4ba0C320B59f825cc8D2291f672247Aa5D06F", collateralDex: "0x1d3e52a11B98Ed2AAB7eB0Bfe1cbB6525233204d", token0: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", token1: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", token0Decimals: 8, token1Decimals: 8, debtToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", debtDecimals: 6, presetId: "correlated", magnitudePct: "0", poolValueUsd8: "31897529237", poolValueUsd8Baseline: "31897529237", vaultCollateralValueUsd8: "31897529237", vaultDebtValueUsd8: "0", liquidatable: false, createdAt: "2026-08-25T12:16:13.452Z" },
  { vault: "0x5eb4ba0C320B59f825cc8D2291f672247Aa5D06F", collateralDex: "0x1d3e52a11B98Ed2AAB7eB0Bfe1cbB6525233204d", token0: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", token1: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", token0Decimals: 8, token1Decimals: 8, debtToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", debtDecimals: 6, presetId: "correlated", magnitudePct: "-50", poolValueUsd8: "31897529237", poolValueUsd8Baseline: "31897529237", vaultCollateralValueUsd8: "31897529237", vaultDebtValueUsd8: "0", liquidatable: false, createdAt: "2026-08-25T12:16:13.452Z" },
];

export async function getMockFluidT2Shock(): Promise<FluidT2ShockResult[]> {
  return MOCK_FLUID_T2_SHOCK;
}

// Real rows from a local sync run (Deploy 3/6, T3 - normal collateral, smart debt) - one
// real, active native-ETH-collateral vault (93 real positions) at two magnitudes, correlated
// preset only. vaultDebtValueUsd8 is the REAL per-vault share of the debt pool (this vault
// owns ~0.92% of the pool's debt shares) - not the raw pool total (poolValueUsd8), which
// would make this healthy vault look ~38x over-indebted - see
// api/src/db/migrations/0009_fluid_t3_shock_results.ts's top comment for the real bug this
// fixes.
const MOCK_FLUID_T3_SHOCK: FluidT3ShockResult[] = [
  { vault: "0x3E11B9aEb9C7dBbda4DD41477223Cc2f3f24b9d7", collateralToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", collateralDecimals: 18, debtDex: "0x667701e51B4D1Ca244F17C78F7aB8744B4C99F9B", token0: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", token1: "0xdAC17F958D2ee523a2206206994597C13D831ec7", token0Decimals: 6, token1Decimals: 6, presetId: "correlated", magnitudePct: "0", poolValueUsd8: "3285832119717321", poolValueUsd8Baseline: "3285832119717321", vaultCollateralValueUsd8: "86033776528827", vaultDebtValueUsd8: "30238017944144", liquidatable: false, createdAt: "2026-09-03T05:00:00.000Z" },
  { vault: "0x3E11B9aEb9C7dBbda4DD41477223Cc2f3f24b9d7", collateralToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", collateralDecimals: 18, debtDex: "0x667701e51B4D1Ca244F17C78F7aB8744B4C99F9B", token0: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", token1: "0xdAC17F958D2ee523a2206206994597C13D831ec7", token0Decimals: 6, token1Decimals: 6, presetId: "correlated", magnitudePct: "-50", poolValueUsd8: "3285832119717321", poolValueUsd8Baseline: "3285832119717321", vaultCollateralValueUsd8: "43016888264413", vaultDebtValueUsd8: "30238017944144", liquidatable: false, createdAt: "2026-09-03T05:00:00.000Z" },
];

export async function getMockFluidT3Shock(): Promise<FluidT3ShockResult[]> {
  return MOCK_FLUID_T3_SHOCK;
}

// Real rows from a local sync run (Deploy 5/6, T4 - smart collateral AND smart debt). One
// real, active same-pool vault (col_token0 === debt_token0, col_token1 === debt_token1,
// collateralDex === debtDex - a WETH-native-ETH pool serving both legs) at two magnitudes,
// correlated preset only. vaultCollateralValueUsd8/vaultDebtValueUsd8 are each this vault's
// real, precise share of that ONE pool - two independent fractions (supply shares vs borrow
// shares), not a shared one - see api/src/db/migrations/0010_fluid_t4_shock_results.ts's top
// comment.
const MOCK_FLUID_T4_SHOCK: FluidT4ShockResult[] = [
  { vault: "0x528CF7DBBff878e02e48E83De5097F8071af768D", collateralDex: "0x0B1a513ee24972DAEf112bC777a5610d4325C9e7", colToken0: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", colToken1: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", colToken0Decimals: 18, colToken1Decimals: 18, debtDex: "0x0B1a513ee24972DAEf112bC777a5610d4325C9e7", debtToken0: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", debtToken1: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", debtToken0Decimals: 18, debtToken1Decimals: 18, presetId: "correlated", magnitudePct: "0", colPoolValueUsd8: "4429538753624599", colPoolValueUsd8Baseline: "4429538753624599", debtPoolValueUsd8: "3958734659302978", debtPoolValueUsd8Baseline: "3958734659302978", vaultCollateralValueUsd8: "4429532813613130", vaultDebtValueUsd8: "3958728812251886", liquidatable: false, createdAt: "2026-09-03T01:20:34.680Z" },
  { vault: "0x528CF7DBBff878e02e48E83De5097F8071af768D", collateralDex: "0x0B1a513ee24972DAEf112bC777a5610d4325C9e7", colToken0: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", colToken1: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", colToken0Decimals: 18, colToken1Decimals: 18, debtDex: "0x0B1a513ee24972DAEf112bC777a5610d4325C9e7", debtToken0: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", debtToken1: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", debtToken0Decimals: 18, debtToken1Decimals: 18, presetId: "correlated", magnitudePct: "-50", colPoolValueUsd8: "2214769376812299", colPoolValueUsd8Baseline: "4429538753624599", debtPoolValueUsd8: "1979367329651489", debtPoolValueUsd8Baseline: "3958734659302978", vaultCollateralValueUsd8: "2214766406806564", vaultDebtValueUsd8: "1979364406125943", liquidatable: false, createdAt: "2026-09-03T01:20:34.680Z" },
];

export async function getMockFluidT4Shock(): Promise<FluidT4ShockResult[]> {
  return MOCK_FLUID_T4_SHOCK;
}

export async function getMockMarketConcentration(
  presetId: string,
  magnitudePct: number,
  protocol: DrilldownProtocol
): Promise<MarketConcentrationEntry[]> {
  if (protocol === "aave-v4") return [];
  const forPreset = data.marketConcentration[presetId];
  if (!forPreset) return [];
  const byMagnitude = forPreset[protocol];
  const keys = Object.keys(byMagnitude);
  const key = nearestMagnitudeKey(keys, magnitudePct);
  return byMagnitude[key] ?? [];
}
