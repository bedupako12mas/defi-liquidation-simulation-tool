/**
 * `/api/simulate` (SSE stream) + `/api/positions` (per-position drilldown snapshot) client.
 *
 * STREAMING PROTOCOL, real-API side (matches `app/api`'s existing `SweepPoint` shape -
 * `api/src/engine/sweep.ts` - plus the SSE framing decided this session):
 *
 *   GET /api/simulate?presetId=<id>          (EventSource, not POST - a POST body can't
 *                                              drive an EventSource, and the request is
 *                                              fully described by a preset id, so a
 *                                              query-string GET is the right shape, not a
 *                                              workaround)
 *     event: point   data: { "protocol": "aave" | "fluid", "point": SweepPoint }
 *     event: point   data: ...                 (one per (protocol, magnitude) pair, in the
 *                                                order the server computes them)
 *     event: done    data: { "preset": ShockPreset }
 *     event: error   data: { "message": string }
 *
 *   GET /api/positions?presetId=<id>&magnitudePct=<n>&protocol=aave|fluid
 *     -> PositionSnapshot[]  (per-position health/LTV/toxic-state detail at one swept
 *        magnitude - the engine already computes healthFactor/currentLtv/isToxicLiquidation
 *        per-position internally (see sweep.ts's call graph in docs/flow.md); this endpoint
 *        is the v2 extension that exposes that per-position detail instead of only the
 *        aggregated SweepPoint, which is what PositionDrilldown.tsx needs and v1 never had.
 *
 * See meta.ts's top comment for the mock/live swap point (`USE_MOCK`) - identical here.
 */

import { API_BASE, USE_MOCK, type ShockPreset } from "./meta";

export type Protocol = "aave" | "fluid";

export interface SweepPoint {
  magnitudePct: number; // e.g. -23.4 means -23.4%
  liquidatableCollateralUsd: number;
  liquidatablePositionCount: number;
  toxicPositionCount: number;
  badDebtUsd: number;
}

// "eligible" is Fluid's distinct word for the HF<1 boundary - not the same guarantee as
// Aave's "liquidatable" (a real liquidator can target an Aave position directly; Fluid's
// equivalent only means the position's ratio has entered a zone a tick-sweep could reach).
// See api/src/routes/positions.ts's toPositionSnapshot for the full reasoning.
export type PositionState = "healthy" | "liquidatable" | "eligible" | "toxic";

export interface PositionSnapshot {
  id: string;
  protocol: Protocol;
  collateralUsd: number;
  debtUsd: number;
  healthFactor: number | null; // null when the position carries no debt
  ltvPct: number | null; // null when collateral value is zero
  // Collateral-value-weighted liquidation threshold, recovered as healthFactor * ltvPct -
  // the bar LTV must cross to become "liquidatable". Null whenever either input is null.
  effectiveThresholdPct: number | null;
  ucFrontierPct: number; // 1/(1+i) for this position's incentive - the bar LTV must cross to become "toxic"
  state: PositionState;
  badDebtUsd: number;
}

export interface SimulationStreamHandlers {
  onPoint: (protocol: Protocol, point: SweepPoint, arrivedAt: number) => void;
  onDone: (preset: ShockPreset) => void;
  onError: (message: string) => void;
}

export interface SimulationStreamHandle {
  close: () => void;
}

/**
 * Opens a streaming simulation run for one preset. Returns a handle whose `close()` tears
 * down the underlying transport (EventSource in production, timers in mock mode) - callers
 * (useSimulationStream) must call it on preset change / unmount to avoid a leaked connection
 * or a stale mock stream still delivering points into unmounted state.
 */
export function openSimulationStream(
  presetId: ShockPreset["id"],
  handlers: SimulationStreamHandlers
): SimulationStreamHandle {
  if (USE_MOCK) {
    return openMockSimulationStream(presetId, handlers);
  }
  return openLiveSimulationStream(presetId, handlers);
}

function openLiveSimulationStream(
  presetId: ShockPreset["id"],
  handlers: SimulationStreamHandlers
): SimulationStreamHandle {
  const url = `${API_BASE}/api/simulate?presetId=${encodeURIComponent(presetId)}`;
  const source = new EventSource(url);

  source.addEventListener("point", (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent).data) as { protocol: Protocol; point: SweepPoint };
      handlers.onPoint(payload.protocol, payload.point, Date.now());
    } catch {
      handlers.onError("Malformed 'point' event from /api/simulate.");
    }
  });

  source.addEventListener("done", (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent).data) as { preset: ShockPreset };
      handlers.onDone(payload.preset);
    } catch {
      handlers.onError("Malformed 'done' event from /api/simulate.");
    } finally {
      source.close();
    }
  });

  source.addEventListener("error", (event) => {
    const maybeMessage = (event as MessageEvent).data;
    handlers.onError(typeof maybeMessage === "string" ? maybeMessage : "Simulation stream error.");
    source.close();
  });

  // A native connection-level error (server unreachable, dropped connection) fires the
  // EventSource's own `onerror`, not our named "error" event - handle both.
  source.onerror = () => {
    handlers.onError(`Lost connection to ${url}.`);
    source.close();
  };

  return { close: () => source.close() };
}

/**
 * Mock transport with the SAME handler contract as the live one, so useSimulationStream
 * never branches on which mode is active. Delivers real chunks on real timers (setTimeout),
 * not a synchronous loop - `arrivedAt` timestamps are genuine `Date.now()` reads at
 * dispatch time, so latency shown in the UI reflects the actual (if artificial) delay
 * between chunks, not a fabricated number. See FRONTEND_STRATEGY.md's "honest timing" note.
 */
function openMockSimulationStream(
  presetId: ShockPreset["id"],
  handlers: SimulationStreamHandlers
): SimulationStreamHandle {
  let cancelled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  import("./mock/mockClient").then(({ getMockSweep, getMockPreset }) => {
    if (cancelled) return;
    const preset = getMockPreset(presetId);
    if (!preset) {
      handlers.onError(`Unknown presetId "${presetId}".`);
      return;
    }

    const aave = getMockSweep(presetId, "aave");
    const fluid = getMockSweep(presetId, "fluid");

    // Interleave aave[i]/fluid[i] pairs, one pair per tick, with a small jittered delay -
    // mimics a server streaming points as they're computed rather than all at once.
    const steps = Math.max(aave.length, fluid.length);
    let elapsed = 0;
    for (let i = 0; i < steps; i++) {
      const delay = 12 + Math.round(Math.random() * 18); // 12-30ms per chunk
      elapsed += delay;
      const aavePoint = aave[i];
      const fluidPoint = fluid[i];
      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          if (aavePoint) handlers.onPoint("aave", aavePoint, Date.now());
          if (fluidPoint) handlers.onPoint("fluid", fluidPoint, Date.now());
        }, elapsed)
      );
    }
    timers.push(
      setTimeout(() => {
        if (!cancelled) handlers.onDone(preset);
      }, elapsed + 20)
    );
  });

  return {
    close: () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    },
  };
}

export async function fetchPositionSnapshot(
  presetId: ShockPreset["id"],
  magnitudePct: number,
  protocol: Protocol
): Promise<PositionSnapshot[]> {
  if (USE_MOCK) {
    const { getMockPositionSnapshot } = await import("./mock/mockClient");
    return getMockPositionSnapshot(presetId, magnitudePct, protocol);
  }
  const params = new URLSearchParams({
    presetId,
    magnitudePct: String(magnitudePct),
    protocol,
  });
  const res = await fetch(`${API_BASE}/api/positions?${params.toString()}`);
  if (!res.ok) throw new Error(`GET /api/positions failed: ${res.status}`);
  return res.json();
}

/** At what shock magnitude does each position first cross its own threshold - null if it
 *  never crosses within the -80% range. See api/src/engine/killPrice.ts. */
export interface KillPriceResult {
  id: string;
  killMagnitudePct: number | null;
}

export async function fetchKillPrices(presetId: ShockPreset["id"], protocol: Protocol): Promise<KillPriceResult[]> {
  if (USE_MOCK) {
    const { getMockKillPrices } = await import("./mock/mockClient");
    return getMockKillPrices(presetId, protocol);
  }
  const params = new URLSearchParams({ presetId, protocol });
  const res = await fetch(`${API_BASE}/api/kill-price?${params.toString()}`);
  if (!res.ok) throw new Error(`GET /api/kill-price failed: ${res.status}`);
  return res.json();
}

/** At-risk debt grouped by each protocol's own isolated-market unit - reserve (asset) for
 *  Aave, vault for Fluid. See api/src/engine/marketConcentration.ts. */
export interface MarketConcentrationEntry {
  market: string;
  atRiskDebtUsd: number;
  contributingLegCount: number;
}

export async function fetchMarketConcentration(
  presetId: ShockPreset["id"],
  magnitudePct: number,
  protocol: Protocol
): Promise<MarketConcentrationEntry[]> {
  if (USE_MOCK) {
    const { getMockMarketConcentration } = await import("./mock/mockClient");
    return getMockMarketConcentration(presetId, magnitudePct, protocol);
  }
  const params = new URLSearchParams({ presetId, magnitudePct: String(magnitudePct), protocol });
  const res = await fetch(`${API_BASE}/api/market-concentration?${params.toString()}`);
  if (!res.ok) throw new Error(`GET /api/market-concentration failed: ${res.status}`);
  return res.json();
}
