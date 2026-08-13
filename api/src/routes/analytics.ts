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
import { loadLatestAaveSnapshot, loadLatestFluidSnapshot } from "./latestSnapshot.js";

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

      if (protocol !== "aave" && protocol !== "fluid") {
        reply.code(400).send({ error: `Unknown protocol "${protocol}". Valid: aave, fluid.` });
        return;
      }
      const preset = getShockPreset(presetId);
      if (!preset) {
        reply.code(400).send({ error: `Unknown presetId "${presetId}".` });
        return;
      }

      const reserveConfigs = await getCachedReserveConfigs(deps.client);
      const snapshot =
        protocol === "aave" ? await loadLatestAaveSnapshot(deps.db) : await loadLatestFluidSnapshot(deps.db);
      if (!snapshot) return [];

      const assetConfig =
        protocol === "aave"
          ? Object.fromEntries(reserveConfigs.map((r) => [r.asset, classifyForShock(r)]))
          : classifyFluidAssets(snapshot.positions, reserveConfigs);

      return computeKillMagnitudes(snapshot.positions, snapshot.basePrices, assetConfig, preset, sweepMagnitudes());
    },
  );

  // Per-isolated-market at-risk debt: Aave grouped by reserve (leg-level - a position can
  // hold debt across several reserves at once), Fluid grouped by vault (position-level -
  // always exactly one debt leg). Deliberately different grouping keys per protocol,
  // matching each protocol's own actual isolated-market unit rather than forcing a
  // common shape.
  app.get(
    "/api/market-concentration",
    { config: { rateLimit: DRILLDOWN_RATE_LIMIT } },
    async (request: FastifyRequest<{ Querystring: ConcentrationQuery }>, reply) => {
      const { protocol, presetId, magnitudePct } = request.query;

      if (protocol !== "aave" && protocol !== "fluid") {
        reply.code(400).send({ error: `Unknown protocol "${protocol}". Valid: aave, fluid.` });
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

      const reserveConfigs = await getCachedReserveConfigs(deps.client);
      const snapshot =
        protocol === "aave" ? await loadLatestAaveSnapshot(deps.db) : await loadLatestFluidSnapshot(deps.db);
      if (!snapshot) return [];

      const assetConfig =
        protocol === "aave"
          ? Object.fromEntries(reserveConfigs.map((r) => [r.asset, classifyForShock(r)]))
          : classifyFluidAssets(snapshot.positions, reserveConfigs);
      const prices = applyShock(snapshot.basePrices, assetConfig, magnitude / 100, preset);

      if (protocol === "aave") {
        const symbolByAddress = new Map(reserveConfigs.map((r) => [r.asset.toLowerCase(), r.symbol]));
        return aaveMarketConcentration(snapshot.positions, prices, symbolByAddress);
      }
      return fluidMarketConcentration(snapshot.positions, prices);
    },
  );
}
