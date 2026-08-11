/**
 * Reads `fixtures.generated.json` (produced by `scripts/generate-mock-fixtures.ts` from the
 * real, tested `v2/api/src/engine` - see that script's top comment) and serves it through the
 * exact return shapes `meta.ts`/`simulate.ts` expose to the rest of the app. Every function
 * here is imported dynamically (`await import("./mock/mockClient")`) from those two files
 * only when `USE_MOCK` is true, so none of this ships in a build that talks to the real API.
 */

import fixtures from "./fixtures.generated.json";
import type { MetaResponse, ShockPreset } from "../meta";
import type { Protocol, PositionSnapshot, SweepPoint } from "../simulate";

type FixturesShape = {
  meta: MetaResponse;
  sweeps: Record<string, { aave: SweepPoint[]; fluid: SweepPoint[] }>;
  positionSnapshots: Record<string, { aave: Record<string, PositionSnapshot[]>; fluid: Record<string, PositionSnapshot[]> }>;
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
