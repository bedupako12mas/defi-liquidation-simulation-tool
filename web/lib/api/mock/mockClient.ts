/**
 * Reads `fixtures.generated.json` (produced by `scripts/generate-mock-fixtures.ts` from the
 * real, tested `api/src/engine` - see that script's top comment) and serves it through the
 * exact return shapes `meta.ts`/`simulate.ts` expose to the rest of the app. Every function
 * here is imported dynamically (`await import("./mock/mockClient")`) from those two files
 * only when `USE_MOCK` is true, so none of this ships in a build that talks to the real API.
 */

import fixtures from "./fixtures.generated.json";
import type { MetaResponse, ShockPreset } from "../meta";
import type { Protocol, PositionSnapshot, SweepPoint, KillPriceResult, MarketConcentrationEntry } from "../simulate";
import type { ValidationProtocol, ValidationResult } from "../validation";
import type { ProfitabilityProtocol, LiquidationProfitability } from "../profitability";
import type { ChainedProtocol, ChainedLiquidationResult } from "../chainedLiquidation";
import type { CappedRateBreachResult } from "../cappedRateBreach";

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

export async function getMockPositionSnapshot(
  presetId: string,
  magnitudePct: number,
  protocol: Protocol
): Promise<PositionSnapshot[]> {
  const forPreset = data.positionSnapshots[presetId];
  if (!forPreset) return [];
  const byMagnitude = forPreset[protocol];
  const keys = Object.keys(byMagnitude);
  const key = nearestMagnitudeKey(keys, magnitudePct);
  return byMagnitude[key] ?? [];
}

export async function getMockKillPrices(presetId: string, protocol: Protocol): Promise<KillPriceResult[]> {
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
 *  disclosed outcomes) - same discipline as the validation-results mock above. */
const MOCK_LIQUIDATION_PROFITABILITY: LiquidationProfitability[] = [
  { protocol: "aave", positionId: "aave-0x4c5d6e7f8091a2b3c4d5e6f78091a2b3c4d5e6f7", presetId: "correlated", magnitudePct: "-20", gasUsed: "528196", gasCostUsd8: "3030000", debtClearedUsd8: "1351157000000", bonusValueUsd8: "1418715000000", netProfitUsd8: "67555000000", status: "profitable", detail: null, createdAt: "2026-08-16T07:24:00Z" },
  { protocol: "aave", positionId: "aave-0x5d6e7f8091a2b3c4d5e6f78091a2b3c4d5e6f780", presetId: "correlated", magnitudePct: "-30", gasUsed: "357168", gasCostUsd8: "2320000", debtClearedUsd8: "17094935", bonusValueUsd8: "17949681", netProfitUsd8: "-2407811", status: "unprofitable", detail: null, createdAt: "2026-08-16T07:24:00Z" },
  { protocol: "aave", positionId: "aave-0x6e7f8091a2b3c4d5e6f78091a2b3c4d5e6f78091", presetId: "correlated", magnitudePct: "-65", gasUsed: null, gasCostUsd8: null, debtClearedUsd8: null, bonusValueUsd8: null, netProfitUsd8: null, status: "unable-to-estimate-gas", detail: "MustNotLeaveDust (real Aave dust-avoidance rule, not yet modeled in computeExpectedMaxLiquidatableDebt)", createdAt: "2026-08-16T07:24:00Z" },
  { protocol: "aave", positionId: "aave-0x7f8091a2b3c4d5e6f78091a2b3c4d5e6f780912a", presetId: "correlated", magnitudePct: "-50", gasUsed: null, gasCostUsd8: null, debtClearedUsd8: null, bonusValueUsd8: null, netProfitUsd8: null, status: "unable-to-validate", detail: "never became liquidatable within the tested magnitude range", createdAt: "2026-08-16T07:24:00Z" },
  { protocol: "fluid", positionId: "fluid-0x009d7471fc3bd28fc45495d38978287fdf39416d-118", presetId: "correlated", magnitudePct: "-15", gasUsed: "238397", gasCostUsd8: "1650000", debtClearedUsd8: "2117373674500", bonusValueUsd8: "2223242358200", netProfitUsd8: "105851034200", status: "profitable", detail: null, createdAt: "2026-08-16T07:24:00Z" },
  { protocol: "fluid", positionId: "fluid-0x18b3aa2be6f10d0ea7f4491913a9e4dfa02c1b60-42", presetId: "correlated", magnitudePct: "-80", gasUsed: null, gasCostUsd8: null, debtClearedUsd8: null, bonusValueUsd8: null, netProfitUsd8: null, status: "unable-to-validate", detail: "no sweep within the tested range (HF=1.0996) - both legs are correlated assets, real, expected behavior under a uniform market shock", createdAt: "2026-08-16T07:24:00Z" },
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

export async function getMockMarketConcentration(
  presetId: string,
  magnitudePct: number,
  protocol: Protocol
): Promise<MarketConcentrationEntry[]> {
  const forPreset = data.marketConcentration[presetId];
  if (!forPreset) return [];
  const byMagnitude = forPreset[protocol];
  const keys = Object.keys(byMagnitude);
  const key = nearestMagnitudeKey(keys, magnitudePct);
  return byMagnitude[key] ?? [];
}
