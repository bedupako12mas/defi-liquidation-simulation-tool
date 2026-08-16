import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

// Same reasoning as validationResults.ts's rate limit - cheap, single-shot, DB-only read.
const PROFITABILITY_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };

interface ProtocolQuery {
  protocol?: string;
}

export interface LiquidationProfitabilityDTO {
  protocol: "aave" | "fluid";
  positionId: string;
  presetId: string;
  magnitudePct: string;
  gasUsed: string | null;
  gasCostUsd8: string | null;
  debtClearedUsd8: string | null;
  bonusValueUsd8: string | null;
  netProfitUsd8: string | null;
  status: string;
  detail: string | null;
  createdAt: string;
}

/**
 * Serves the latest results written by scripts/sync-liquidation-profitability.ts (#43) -
 * real eth_estimateGas + real gas price, compared against the real bonus a liquidator would
 * receive, both protocols tested under the SAME shock conditions (see that script's top
 * comment for why - a real, confirmed-live design correction, not the original plan).
 */
export function registerLiquidationProfitabilityRoutes(app: FastifyInstance, deps: { db: Kysely<DB> }) {
  app.get(
    "/api/liquidation-profitability",
    { config: { rateLimit: PROFITABILITY_RATE_LIMIT } },
    async (request: FastifyRequest<{ Querystring: ProtocolQuery }>, reply): Promise<LiquidationProfitabilityDTO[]> => {
      const { protocol } = request.query;
      if (protocol !== undefined && protocol !== "aave" && protocol !== "fluid") {
        reply.code(400).send({ error: `Unknown protocol "${protocol}". Valid: aave, fluid.` });
        return [];
      }

      let query = deps.db.selectFrom("liquidation_profitability").selectAll().orderBy("id", "asc");
      if (protocol) query = query.where("protocol", "=", protocol);

      const rows = await query.execute();
      return rows.map((r) => ({
        protocol: r.protocol as "aave" | "fluid",
        positionId: r.position_id,
        presetId: r.preset_id,
        magnitudePct: r.magnitude_pct,
        gasUsed: r.gas_used,
        gasCostUsd8: r.gas_cost_usd8,
        debtClearedUsd8: r.debt_cleared_usd8,
        bonusValueUsd8: r.bonus_value_usd8,
        netProfitUsd8: r.net_profit_usd8,
        status: r.status,
        detail: r.detail,
        createdAt: r.created_at.toISOString(),
      }));
    },
  );
}
