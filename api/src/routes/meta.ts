import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { PublicClient } from "viem";
import type { DB } from "../db/types.js";
import { SHOCK_PRESETS } from "../engine/shockModel.js";
import { undercollateralizationFrontier } from "../engine/toxicLiquidation.js";
import { getCachedReserveConfigs } from "./reserveConfigCache.js";

// Real, current, specific limitations - not generic hedging. Each one names a real gap
// found and documented during this build (docs/decisions.md), not a boilerplate
// disclaimer list.
const LIMITATIONS = [
  "Aave V3 eMode is not modeled: a position enrolled in an eMode category shows a lower " +
    "(more conservative) health factor here than its real on-chain value, because the " +
    "eMode-boosted liquidation threshold isn't applied. Confirmed against 2 real positions " +
    "during validation - see docs/decisions.md's validation-milestone entry.",
  "Fluid T1 vault data is not yet live - only Aave V3 positions are real. Fluid points are " +
    "simply absent from the simulation stream, not fabricated.",
  "protocol_params does not carry per-asset liquidation incentive/bonus - the methodology " +
    "table's incentive figures are derived live from Aave's PoolDataProvider, not the DB.",
  "The Aave indexer's initial backfill is bounded (~50,000 blocks), not a full historical " +
    "scan from Aave V3's mainnet launch - demo-scale by design, not an oversight.",
];

export function registerMetaRoute(app: FastifyInstance, deps: { db: Kysely<DB>; client: PublicClient }) {
  app.get("/api/meta", async () => {
    const latestSnapshot = await deps.db
      .selectFrom("snapshots")
      .select(["pinned_block"])
      .where("protocol", "=", "aave")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();

    const reserveConfigs = await getCachedReserveConfigs(deps.client);

    const ucFrontier = reserveConfigs
      .filter((r) => r.liquidationBonusRaw > 10_000n) // same "not collateral-eligible" guard as aaveUserEnrichment.ts
      .map((r) => {
        const incentiveBps = r.liquidationBonusRaw - 10_000n;
        const frontierWad = undercollateralizationFrontier(incentiveBps);
        return {
          protocol: "aave",
          asset: r.symbol,
          incentivePct: Number(incentiveBps) / 100,
          ucFrontierPct: (Number(frontierWad) / 1e18) * 100,
          liquidationThresholdPct: Number(r.liquidationThresholdBps) / 100,
          provenance: `cited: live Aave V3 PoolDataProvider.getReserveConfigurationData(${r.asset})`,
        };
      });

    return {
      mode: "demo",
      pinnedBlock: latestSnapshot?.pinned_block ?? null,
      presets: Object.values(SHOCK_PRESETS),
      ucFrontier,
      limitations: LIMITATIONS,
      capabilities: { rpc: true, fork: false },
    };
  });
}
