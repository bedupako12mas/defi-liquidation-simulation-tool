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
  detail: string | null;
  createdAt: string;
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
        detail: r.detail,
        createdAt: r.created_at.toISOString(),
      }));
    },
  );
}
