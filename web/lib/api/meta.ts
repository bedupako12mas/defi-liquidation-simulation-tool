/**
 * `/api/meta` client + the shared API-layer config (API base URL, mock switch).
 *
 * *** THE API SWAP POINT ***
 * `USE_MOCK` below is the one line that changes once `api`'s real Fastify routes exist
 * (`docs/flow.md`'s "what's next to wire in" - `src/server.ts` + route handlers matching the
 * shape this file/`simulate.ts` already assume). Today it defaults to `true` because there is
 * nothing at `NEXT_PUBLIC_API_BASE` to talk to. Once the real API is deployed:
 *
 *   1. Set `NEXT_PUBLIC_API_BASE` (Vercel project env, or `.env.local` for dev) to the real
 *      API's origin.
 *   2. Set `NEXT_PUBLIC_USE_MOCK_API=false` (or delete the mock fixtures import path - see
 *      below) in the same place.
 *
 * No component, hook, or other file changes - every consumer already calls `fetchMeta()` /
 * `openSimulationStream()` / `fetchPositionSnapshot()` and only ever sees the return shape,
 * never which branch produced it.
 */

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

// Defaults to mock ON: there is no api server to reach yet (docs/flow.md - "no server, no
// routes, no main/entry file yet"). Flip via env, not a code edit, once that changes.
export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK_API !== "false";

export interface ShockPreset {
  id: "correlated" | "mild-depeg" | "severe-depeg";
  label: string;
  depegSpread: number;
  citation: string;
}

export interface UcFrontierRow {
  protocol: string;
  asset: string;
  incentivePct: number;
  ucFrontierPct: number;
  liquidationThresholdPct: number;
  provenance: string;
}

/**
 * FRONTEND_STRATEGY.md's capability-driven rendering mechanism: the single source of truth
 * for what's live. `rpc` is always true once Milestone 1 ships (it has, here). `fork` stays
 * false until Milestone 2 actually ships server-side - the frontend never hardcodes that
 * fact, it asks `/api/meta` once at load and renders accordingly (see lib/hooks/useCapabilities.ts).
 */
export interface Capabilities {
  rpc: boolean;
  fork: boolean;
}

export interface MetaResponse {
  mode: "demo";
  pinnedBlock: string | null;
  presets: ShockPreset[];
  ucFrontier: UcFrontierRow[];
  limitations: string[];
  capabilities: Capabilities;
}

export async function fetchMeta(): Promise<MetaResponse> {
  if (USE_MOCK) {
    const { getMockMeta } = await import("./mock/mockClient");
    return getMockMeta();
  }
  const res = await fetch(`${API_BASE}/api/meta`);
  if (!res.ok) throw new Error(`GET /api/meta failed: ${res.status}`);
  return res.json();
}
