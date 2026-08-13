import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { PublicClient } from "viem";
import type { DB } from "../db/types.js";
import { applyShock, getShockPreset } from "../engine/shockModel.js";
import { healthFactor, totalCollateralValueUsd8, totalDebtValueUsd8 } from "../engine/healthFactor.js";
import { currentLtv, isToxicLiquidation, badDebtUsd8, undercollateralizationFrontier } from "../engine/toxicLiquidation.js";
import type { Position, PriceVector, Protocol } from "../engine/types.js";
import { getCachedReserveConfigs } from "./reserveConfigCache.js";
import { classifyForShock } from "./aaveShockClassification.js";
import { classifyFluidAssets } from "./fluidShockClassification.js";
import { loadLatestAaveSnapshot, loadLatestFluidSnapshot } from "./latestSnapshot.js";

const USD8 = 100_000_000;

interface PositionsQuery {
  presetId?: string;
  magnitudePct?: string;
  protocol?: string;
}

/**
 * Shared per-position transformation - identical math for both protocols (decision #3:
 * the engine is reused unchanged for Fluid). Extracted once both branches needed it,
 * rather than duplicating this block.
 */
function toPositionSnapshot(position: Position, prices: PriceVector, protocol: Protocol) {
  const hf = healthFactor(position, prices);
  const ltv = currentLtv(position, prices);
  const frontierWad = undercollateralizationFrontier(position.liquidationIncentiveBps);
  const toxic = isToxicLiquidation(position, prices);
  const belowThreshold = hf !== null && hf < 10n ** 18n;
  // "eligible", not "liquidatable", for Fluid - deliberately different word (decision
  // logged in docs/decisions.md). Aave's HF<1 is individually actionable: a liquidator
  // can target that exact position directly, right now. Fluid's equivalent boundary only
  // means the position's ratio has entered the zone a real tick-sweep *could* reach -
  // whether it's actually swept depends on aggregate sweep depth and what else is queued
  // ahead of it in the same vault, not on this position alone. Same underlying number,
  // different real-world guarantee - reusing Aave's word here would silently overclaim.
  const belowThresholdState = protocol === "fluid" ? "eligible" : "liquidatable";

  // HF = (Σcollateral*price*threshold) / debtValue, LTV = debtValue / (Σcollateral*price)
  // (unweighted) -> HF * LTV = (Σcollateral*price*threshold) / (Σcollateral*price), the
  // collateral-value-weighted average threshold across every leg. Recovers a single,
  // honest "effective threshold" percentage from numbers already computed above - valid
  // for a single-leg Fluid position and a multi-leg Aave position alike, no new engine
  // math needed.
  const effectiveThresholdPct = hf === null || ltv === null ? null : (Number(hf) / 1e18) * (Number(ltv) / 1e18) * 100;

  return {
    id: position.id,
    protocol,
    collateralUsd: Number(totalCollateralValueUsd8(position, prices)) / USD8,
    debtUsd: Number(totalDebtValueUsd8(position, prices)) / USD8,
    healthFactor: hf === null ? null : Number(hf) / 1e18,
    ltvPct: ltv === null ? null : (Number(ltv) / 1e18) * 100,
    effectiveThresholdPct,
    ucFrontierPct: (Number(frontierWad) / 1e18) * 100,
    state: toxic ? "toxic" : belowThreshold ? belowThresholdState : "healthy",
    badDebtUsd: Number(badDebtUsd8(position, prices)) / USD8,
  };
}

// The global 20/min limit (server.ts) was sized around /api/simulate's expensive full
// 81-point sweep per request - it was never sized for this route, which does a single,
// cheap per-position pass. Dragging PositionDrilldown's magnitude slider around a few
// times burned through the shared global budget for real (caught live - HTTP 429).
// Independent, more generous budget, not shared with /api/simulate's stricter one.
const DRILLDOWN_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };

export function registerPositionsRoute(app: FastifyInstance, deps: { db: Kysely<DB>; client: PublicClient }) {
  app.get(
    "/api/positions",
    { config: { rateLimit: DRILLDOWN_RATE_LIMIT } },
    async (request: FastifyRequest<{ Querystring: PositionsQuery }>, reply) => {
      const { presetId, magnitudePct, protocol } = request.query;

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
        // Same server-controlled range as /api/simulate's sweep - reject anything outside
        // it rather than run applyShock on an arbitrary caller-supplied magnitude.
        reply.code(400).send({ error: "magnitudePct must be a number between -80 and 0." });
        return;
      }

      const reserveConfigs = await getCachedReserveConfigs(deps.client);

      if (protocol === "aave") {
        const snapshot = await loadLatestAaveSnapshot(deps.db);
        if (!snapshot) return [];

        const assetConfig = Object.fromEntries(reserveConfigs.map((r) => [r.asset, classifyForShock(r)]));
        const prices = applyShock(snapshot.basePrices, assetConfig, magnitude / 100, preset);

        return snapshot.positions.map((position) => toPositionSnapshot(position, prices, "aave"));
      }

      // protocol === "fluid"
      const snapshot = await loadLatestFluidSnapshot(deps.db);
      if (!snapshot) return []; // real answer, not an error - no Fluid snapshot synced yet

      const assetConfig = classifyFluidAssets(snapshot.positions, reserveConfigs);
      const prices = applyShock(snapshot.basePrices, assetConfig, magnitude / 100, preset);

      return snapshot.positions.map((position) => toPositionSnapshot(position, prices, "fluid"));
    },
  );
}
