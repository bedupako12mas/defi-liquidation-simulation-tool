import type { PublicClient } from "viem";
import { loadReserveConfigs, type AaveReserveConfig } from "../loaders/aaveReserveConfig.js";

// protocol_params / reserve configs change rarely (governance-cadence, not per-block) -
// hitting the RPC on every single /api/meta or /api/simulate request would be a real,
// avoidable cost/rate-limit exposure (context.md §10's "denial of wallet" concern),
// unbounded by how often a caller hits the endpoint. A short TTL cache means normal
// traffic costs ~0 extra RPC calls while still staying reasonably fresh.
const TTL_MS = 5 * 60 * 1000;

let cached: { configs: AaveReserveConfig[]; expiresAt: number } | null = null;

// Single-flight: memoize the in-flight PROMISE, not just the resolved value. Without
// this, every request that lands in the window between the cache expiring and the
// refresh resolving triggers its own independent loadReserveConfigs() call - each one a
// getReservesList + two 67-contract multicalls + a price call. Under any real concurrent
// traffic (or the rate limiter's own 20-req/min ceiling being hit right at TTL expiry),
// that's N simultaneous RPC bursts instead of one - the exact "denial of wallet" cost
// concern this cache exists to prevent, just reintroduced at the refresh boundary
// instead of on every request. Caught in review, not designed in from the start.
let inFlight: Promise<AaveReserveConfig[]> | null = null;

export async function getCachedReserveConfigs(client: PublicClient): Promise<AaveReserveConfig[]> {
  if (cached && cached.expiresAt > Date.now()) {
    return cached.configs;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = loadReserveConfigs(client)
    .then((configs) => {
      cached = { configs, expiresAt: Date.now() + TTL_MS };
      return configs;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
