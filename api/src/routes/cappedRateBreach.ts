import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

// Same reasoning as validationResults.ts's rate limit - cheap, single-shot, DB-only read.
const CAPPED_RATE_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };

export interface CappedRateBreachDTO {
  vault: string;
  cappedRateAddress: string;
  minHeartbeatSeconds: number;
  avoidForcedLiquidationsCol: boolean;
  maxDownFromMaxReachedPctCol: string;
  rateBefore: string;
  rateImmediatelyAfterOverride: string;
  rateAfterHeartbeat: string;
  realDropPct: string;
  verdict: string;
  createdAt: string;
}

/**
 * Serves the latest results written by scripts/sync-capped-rate-breach.ts (#38, SCOPE.md
 * item 3b) - for each real, currently-fresh Fluid CappedRate vault, whether an extreme
 * raw-source move survives correctly clamped once its heartbeat genuinely elapses (real time
 * progression, only observable on a fork). verdict is the interpretable summary:
 * "protection-disabled" (avoidForcedLiquidationsCol_ is false - the down-cap branch never
 * runs at all for this vault, independent of the numeric bound), "clamped-as-designed" (the
 * real cap correctly bounded the move), or "unclamped-beyond-bound" (a genuine, concerning
 * finding - protection is enabled but didn't hold).
 */
export function registerCappedRateBreachRoutes(app: FastifyInstance, deps: { db: Kysely<DB> }) {
  app.get(
    "/api/capped-rate-breach",
    { config: { rateLimit: CAPPED_RATE_RATE_LIMIT } },
    async (): Promise<CappedRateBreachDTO[]> => {
      const rows = await deps.db.selectFrom("capped_rate_breach_results").selectAll().orderBy("id", "asc").execute();
      return rows.map((r) => ({
        vault: r.vault,
        cappedRateAddress: r.capped_rate_address,
        minHeartbeatSeconds: r.min_heartbeat_seconds,
        avoidForcedLiquidationsCol: r.avoid_forced_liquidations_col,
        maxDownFromMaxReachedPctCol: r.max_down_from_max_reached_pct_col,
        rateBefore: r.rate_before,
        rateImmediatelyAfterOverride: r.rate_immediately_after_override,
        rateAfterHeartbeat: r.rate_after_heartbeat,
        realDropPct: r.real_drop_pct,
        verdict: r.verdict,
        createdAt: r.created_at.toISOString(),
      }));
    },
  );
}
