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
  { protocol: "aave", positionId: "aave-0x1a2b3c4d5e6f70819293a4b5c6d7e8f901234567", presetId: "correlated", magnitudePct: "-30.00", status: "matched", expectedAmount: "120247427417", actualAmount: "120247427417", detail: null, createdAt: "2026-08-16T03:50:00Z" },
  { protocol: "aave", positionId: "aave-0x2b3c4d5e6f70819293a4b5c6d7e8f9012345678a", presetId: "correlated", magnitudePct: "-30.00", status: "matched-within-drift", expectedAmount: "39779651744", actualAmount: "39779652184", detail: "0.0011% - consistent with unpinned-block interest accrual, not a logic error", createdAt: "2026-08-16T03:50:00Z" },
  { protocol: "aave", positionId: "aave-0x3c4d5e6f70819293a4b5c6d7e8f9012345678ab1", presetId: "correlated", magnitudePct: "-30.00", status: "unexpected-revert", expectedAmount: null, actualAmount: null, detail: "HealthFactorNotBelowThreshold (position's real on-chain HF wasn't actually below 1 at call time)", createdAt: "2026-08-16T03:50:00Z" },
  { protocol: "fluid", positionId: "fluid-0x009d7471fc3bd28fc45495d38978287fdf39416d-118", presetId: "lst-depeg", magnitudePct: "-3", status: "swept", expectedAmount: null, actualAmount: "21175223775", detail: "actualColAmt=20145631548358530415456", createdAt: "2026-08-16T03:50:00Z" },
  { protocol: "fluid", positionId: "fluid-0x18b3aa2be6f10d0ea7f4491913a9e4dfa02c1b60-42", presetId: "lst-depeg", magnitudePct: "-5", status: "swept", expectedAmount: null, actualAmount: "253232000792", detail: "actualColAmt=249547975323302787906125", createdAt: "2026-08-16T03:50:00Z" },
  { protocol: "fluid", positionId: "fluid-0x18b3aa2be6f10d0ea7f4491913a9e4dfa02c1b60-77", presetId: "lst-depeg", magnitudePct: "0", status: "not-applicable", expectedAmount: null, actualAmount: null, detail: "No yield-wrapper (Fluid-type) hop in this vault's oracle - LST-depeg scenario doesn't apply to this vault", createdAt: "2026-08-16T03:50:00Z" },
];

export async function getMockValidationResults(protocol?: ValidationProtocol): Promise<ValidationResult[]> {
  if (!protocol) return MOCK_VALIDATION_RESULTS;
  return MOCK_VALIDATION_RESULTS.filter((r) => r.protocol === protocol);
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
