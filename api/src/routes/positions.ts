import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { PublicClient } from "viem";
import type { DB } from "../db/types.js";
import { applyShock, getShockPreset } from "../engine/shockModel.js";
import { healthFactor, totalCollateralValueUsd8, totalDebtValueUsd8 } from "../engine/healthFactor.js";
import { currentLtv, isToxicLiquidation, badDebtUsd8, undercollateralizationFrontier } from "../engine/toxicLiquidation.js";
import { getCachedReserveConfigs } from "./reserveConfigCache.js";
import { classifyForShock } from "./aaveShockClassification.js";
import { loadLatestAaveSnapshot } from "./latestSnapshot.js";

const USD8 = 100_000_000;

interface PositionsQuery {
  presetId?: string;
  magnitudePct?: string;
  protocol?: string;
}

export function registerPositionsRoute(app: FastifyInstance, deps: { db: Kysely<DB>; client: PublicClient }) {
  app.get("/api/positions", async (request: FastifyRequest<{ Querystring: PositionsQuery }>, reply) => {
    const { presetId, magnitudePct, protocol } = request.query;

    if (protocol === "fluid") {
      return []; // real answer, not an error - Fluid data genuinely doesn't exist yet
    }
    if (protocol !== "aave") {
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

    const snapshot = await loadLatestAaveSnapshot(deps.db);
    if (!snapshot) return [];

    const reserveConfigs = await getCachedReserveConfigs(deps.client);
    const assetConfig = Object.fromEntries(reserveConfigs.map((r) => [r.asset, classifyForShock(r)]));
    const prices = applyShock(snapshot.basePrices, assetConfig, magnitude / 100, preset);

    return snapshot.positions.map((position) => {
      const hf = healthFactor(position, prices);
      const ltv = currentLtv(position, prices);
      const frontierWad = undercollateralizationFrontier(position.liquidationIncentiveBps);
      const toxic = isToxicLiquidation(position, prices);
      const liquidatable = hf !== null && hf < 10n ** 18n;

      return {
        id: position.id,
        protocol: "aave",
        collateralUsd: Number(totalCollateralValueUsd8(position, prices)) / USD8,
        debtUsd: Number(totalDebtValueUsd8(position, prices)) / USD8,
        healthFactor: hf === null ? null : Number(hf) / 1e18,
        ltvPct: ltv === null ? null : (Number(ltv) / 1e18) * 100,
        ucFrontierPct: (Number(frontierWad) / 1e18) * 100,
        state: toxic ? "toxic" : liquidatable ? "liquidatable" : "healthy",
        badDebtUsd: Number(badDebtUsd8(position, prices)) / USD8,
      };
    });
  });
}
