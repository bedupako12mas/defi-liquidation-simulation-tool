import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { PublicClient } from "viem";
import type { DB } from "../db/types.js";
import { applyShock, getShockPreset, sweepMagnitudes } from "../engine/shockModel.js";
import { computeKillMagnitudes } from "../engine/killPrice.js";
import { aaveMarketConcentration, fluidMarketConcentration } from "../engine/marketConcentration.js";
import { getCachedReserveConfigs } from "./reserveConfigCache.js";
import { classifyForShock } from "./aaveShockClassification.js";
import { classifyFluidAssets } from "./fluidShockClassification.js";
import { loadLatestAaveSnapshot, loadLatestFluidSnapshot, loadLatestAaveV4Snapshot } from "./latestSnapshot.js";
import type { LoadedSnapshot } from "./latestSnapshot.js";

interface ProtocolPresetQuery {
  protocol?: string;
  presetId?: string;
}

interface ConcentrationQuery extends ProtocolPresetQuery {
  magnitudePct?: string;
}

// Same reasoning as positions.ts's DRILLDOWN_RATE_LIMIT - these are cheap, single-shot
// routes the global 20/min (sized for /api/simulate's expensive full sweep) was never
// meant to throttle.
const DRILLDOWN_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };

type AnalyticsProtocol = "aave" | "fluid" | "aave-v4";

function isAnalyticsProtocol(protocol: unknown): protocol is AnalyticsProtocol {
  return protocol === "aave" || protocol === "fluid" || protocol === "aave-v4";
}

/**
 * Loads the right snapshot and builds its asset shock-config, one branch per protocol -
 * shared between /api/kill-price and /api/market-concentration so the two routes can't
 * silently drift apart on which classifier each protocol uses. aave-v4 reuses
 * classifyFluidAssets (not classifyForShock) for the same reason positions.ts does: V4's
 * real reserve list only partially overlaps V3's DataProvider-backed reserveConfigs (real
 * V4-only assets - PT-tokens, XAUt, EURC, sUSDe-family - have no V3 entry at all), and
 * classifyFluidAssets's "derive from what a position actually holds, fall back to UNKNOWN,
 * never guess" behavior is the honest one here too.
 */
async function loadSnapshotAndAssetConfig(
  db: Kysely<DB>,
  client: PublicClient,
  protocol: AnalyticsProtocol,
): Promise<{ snapshot: LoadedSnapshot; assetConfig: ReturnType<typeof classifyFluidAssets> } | null> {
  const reserveConfigs = await getCachedReserveConfigs(client);

  if (protocol === "aave") {
    const snapshot = await loadLatestAaveSnapshot(db);
    if (!snapshot) return null;
    return { snapshot, assetConfig: Object.fromEntries(reserveConfigs.map((r) => [r.asset, classifyForShock(r)])) };
  }

  const snapshot = protocol === "fluid" ? await loadLatestFluidSnapshot(db) : await loadLatestAaveV4Snapshot(db);
  if (!snapshot) return null;
  return { snapshot, assetConfig: classifyFluidAssets(snapshot.positions, reserveConfigs) };
}

export function registerAnalyticsRoutes(app: FastifyInstance, deps: { db: Kysely<DB>; client: PublicClient }) {
  // Per-position headroom: at what shock magnitude does each position first cross its
  // own threshold - a distribution, not a single swept curve. See docs/decisions.md's
  // "5 rigorous comparison metrics" entry for why this is more informative than
  // liquidatableCollateralUsd alone, and robust to the Aave/Fluid sample-size gap.
  app.get(
    "/api/kill-price",
    { config: { rateLimit: DRILLDOWN_RATE_LIMIT } },
    async (request: FastifyRequest<{ Querystring: ProtocolPresetQuery }>, reply) => {
      const { protocol, presetId } = request.query;

      if (!isAnalyticsProtocol(protocol)) {
        reply.code(400).send({ error: `Unknown protocol "${protocol}". Valid: aave, fluid, aave-v4.` });
        return;
      }
      const preset = getShockPreset(presetId);
      if (!preset) {
        reply.code(400).send({ error: `Unknown presetId "${presetId}".` });
        return;
      }

      const loaded = await loadSnapshotAndAssetConfig(deps.db, deps.client, protocol);
      if (!loaded) return [];

      return computeKillMagnitudes(loaded.snapshot.positions, loaded.snapshot.basePrices, loaded.assetConfig, preset, sweepMagnitudes());
    },
  );

  // Per-isolated-market at-risk debt: Aave and Aave V4 grouped by reserve (leg-level - a
  // position can hold debt across several reserves at once - real for V4 too, since a
  // V4 position is built the same multi-reserve way as V3, just scoped to one Spoke).
  // Fluid grouped by vault (position-level - always exactly one debt leg). Deliberately
  // different grouping keys per protocol, matching each protocol's own actual
  // isolated-market unit rather than forcing a common shape.
  app.get(
    "/api/market-concentration",
    { config: { rateLimit: DRILLDOWN_RATE_LIMIT } },
    async (request: FastifyRequest<{ Querystring: ConcentrationQuery }>, reply) => {
      const { protocol, presetId, magnitudePct } = request.query;

      if (!isAnalyticsProtocol(protocol)) {
        reply.code(400).send({ error: `Unknown protocol "${protocol}". Valid: aave, fluid, aave-v4.` });
        return;
      }
      const preset = getShockPreset(presetId);
      if (!preset) {
        reply.code(400).send({ error: `Unknown presetId "${presetId}".` });
        return;
      }
      const magnitude = Number(magnitudePct);
      if (!Number.isFinite(magnitude) || magnitude > 0 || magnitude < -80) {
        reply.code(400).send({ error: "magnitudePct must be a number between -80 and 0." });
        return;
      }

      const loaded = await loadSnapshotAndAssetConfig(deps.db, deps.client, protocol);
      if (!loaded) return [];

      const prices = applyShock(loaded.snapshot.basePrices, loaded.assetConfig, magnitude / 100, preset);

      if (protocol === "fluid") {
        return fluidMarketConcentration(loaded.snapshot.positions, prices);
      }
      // aave and aave-v4 both group by reserve. symbolByAddress is always V3's own
      // DataProvider-backed reserveConfigs - a real, disclosed simplification for V4-only
      // assets (falls back to the raw address), the same one classifyFluidAssets above
      // already accepts for shock classification.
      const reserveConfigs = await getCachedReserveConfigs(deps.client);
      const symbolByAddress = new Map(reserveConfigs.map((r) => [r.asset.toLowerCase(), r.symbol]));
      return aaveMarketConcentration(loaded.snapshot.positions, prices, symbolByAddress);
    },
  );
}
