import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

// Same reasoning as validationResults.ts's rate limit - cheap, single-shot, DB-only read.
const CHAINED_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };

interface ProtocolQuery {
  protocol?: string;
}

export interface ChainedLiquidationDTO {
  protocol: "aave" | "fluid";
  presetId: string;
  magnitudePct: string;
  positionAId: string;
  positionBId: string;
  debtAssetSymbol: string | null;
  debtAssetDecimals: number | null;
  positionATxStatus: string;
  isolatedStatus: string | null;
  isolatedDebtRepaid: string | null;
  chainedStatus: string | null;
  chainedDebtRepaid: string | null;
  debtRepaidDiff: string | null;
  /** debtRepaidDiff as a percentage of isolatedDebtRepaid - the raw diff alone is not
   *  interpretable without scale (e.g. a diff of 506 sounds notable until you see it's 506
   *  out of 73 billion, i.e. 0.0007%). Null whenever debtRepaidDiff itself is null, or
   *  isolatedDebtRepaid is zero (would be a div-by-zero, not a real 0%/undefined result). */
  debtRepaidDiffPct: string | null;
  detail: string | null;
  createdAt: string;
}

function computeDiffPct(diff: string | null, isolated: string | null): string | null {
  if (diff === null || isolated === null) return null;
  const isolatedNum = Number(isolated);
  if (isolatedNum === 0) return null;
  return ((Number(diff) / isolatedNum) * 100).toFixed(6);
}

/**
 * Serves the latest results written by scripts/sync-chained-liquidation.ts (#37/#38) - for
 * each real group of currently-liquidatable positions sharing a (collateral, debt) reserve
 * pair, position B's real liquidation outcome measured in isolation (before A's real, mined
 * liquidation) vs. chained (after it), on the same ephemeral anvil fork. debtRepaidDiff is
 * the real, fork-only-observable effect - zero (or null, if either leg is non-"liquidated")
 * is a genuine, disclosed result, not a missing one.
 */
export function registerChainedLiquidationRoutes(app: FastifyInstance, deps: { db: Kysely<DB> }) {
  app.get(
    "/api/chained-liquidation",
    { config: { rateLimit: CHAINED_RATE_LIMIT } },
    async (request: FastifyRequest<{ Querystring: ProtocolQuery }>, reply): Promise<ChainedLiquidationDTO[]> => {
      const { protocol } = request.query;
      if (protocol !== undefined && protocol !== "aave" && protocol !== "fluid") {
        reply.code(400).send({ error: `Unknown protocol "${protocol}". Valid: aave, fluid.` });
        return [];
      }

      let query = deps.db.selectFrom("chained_liquidation_results").selectAll().orderBy("id", "asc");
      if (protocol) query = query.where("protocol", "=", protocol);

      const rows = await query.execute();
      return rows.map((r) => ({
        protocol: r.protocol,
        presetId: r.preset_id,
        magnitudePct: r.magnitude_pct,
        positionAId: r.position_a_id,
        positionBId: r.position_b_id,
        debtAssetSymbol: r.debt_asset_symbol,
        debtAssetDecimals: r.debt_asset_decimals,
        positionATxStatus: r.position_a_tx_status,
        isolatedStatus: r.isolated_status,
        isolatedDebtRepaid: r.isolated_debt_repaid,
        chainedStatus: r.chained_status,
        chainedDebtRepaid: r.chained_debt_repaid,
        debtRepaidDiff: r.debt_repaid_diff,
        debtRepaidDiffPct: computeDiffPct(r.debt_repaid_diff, r.isolated_debt_repaid),
        detail: r.detail,
        createdAt: r.created_at.toISOString(),
      }));
    },
  );
}
