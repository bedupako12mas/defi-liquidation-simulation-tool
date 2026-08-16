import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

// Same reasoning as analytics.ts's DRILLDOWN_RATE_LIMIT - cheap, single-shot, DB-only read.
const VALIDATION_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };

interface ProtocolQuery {
  protocol?: string;
}

export interface ValidationResultDTO {
  protocol: "aave" | "fluid";
  positionId: string;
  presetId: string;
  magnitudePct: string;
  status: string;
  /** expectedAmount/actualAmount are raw on-chain integers in debtAssetSymbol's own
   *  decimals - decimal-adjust with debtAssetDecimals before display, never show bare. */
  expectedAmount: string | null;
  actualAmount: string | null;
  debtAssetSymbol: string | null;
  debtAssetDecimals: number | null;
  /** Raw, in collateralAssetSymbol's own decimals - same rule as above. Fluid only
   *  (Aave's equivalent isn't captured by this validator's return shape). */
  actualCollateralAmount: string | null;
  collateralAssetSymbol: string | null;
  collateralAssetDecimals: number | null;
  detail: string | null;
  createdAt: string;
}

/**
 * Serves the latest results written by scripts/sync-validation-results.ts (#30/#36) - real,
 * state-override eth_call outcomes against real positions on real deployed Aave/Fluid
 * contracts. Read-only, DB-backed, same "sync writes / route reads" split as every other
 * analytics route - the validators themselves are RPC-heavy and too slow for a request path.
 */
export function registerValidationResultsRoutes(app: FastifyInstance, deps: { db: Kysely<DB> }) {
  app.get(
    "/api/validation-results",
    { config: { rateLimit: VALIDATION_RATE_LIMIT } },
    async (request: FastifyRequest<{ Querystring: ProtocolQuery }>, reply): Promise<ValidationResultDTO[]> => {
      const { protocol } = request.query;
      if (protocol !== undefined && protocol !== "aave" && protocol !== "fluid") {
        reply.code(400).send({ error: `Unknown protocol "${protocol}". Valid: aave, fluid.` });
        return [];
      }

      let query = deps.db.selectFrom("validation_results").selectAll().orderBy("id", "asc");
      if (protocol) query = query.where("protocol", "=", protocol);

      const rows = await query.execute();
      return rows.map((r) => ({
        protocol: r.protocol as "aave" | "fluid",
        positionId: r.position_id,
        presetId: r.preset_id,
        magnitudePct: r.magnitude_pct,
        status: r.status,
        expectedAmount: r.expected_amount,
        actualAmount: r.actual_amount,
        debtAssetSymbol: r.debt_asset_symbol,
        debtAssetDecimals: r.debt_asset_decimals,
        actualCollateralAmount: r.actual_collateral_amount,
        collateralAssetSymbol: r.collateral_asset_symbol,
        collateralAssetDecimals: r.collateral_asset_decimals,
        detail: r.detail,
        createdAt: r.created_at.toISOString(),
      }));
    },
  );
}
