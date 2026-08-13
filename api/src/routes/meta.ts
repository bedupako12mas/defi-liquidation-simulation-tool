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
  "Fluid T1 vault data is now live: all 101 real T1 vaults, real positions with real debt " +
    "(supply-only positions excluded - not liquidation-relevant). Prices are resolved via " +
    "Fluid's own oracle graph first (chained through Fluid's own vault pairs to a " +
    "stablecoin anchor), falling back to Aave's already-loaded price for the same real " +
    "asset only when Fluid's own graph can't reach one - in practice, zero tokens needed " +
    "that fallback. A position whose price can't be resolved by either source is excluded " +
    "entirely, not partially included.",
  "Fluid's per-position state uses \"eligible\", not \"liquidatable\" - deliberately " +
    "different words for a real mechanistic difference. Aave's liquidatable state (HF<1) " +
    "is individually actionable: a liquidator can target that exact position directly, " +
    "right now. Fluid's liquidate() has no per-position targeting at all - it sweeps " +
    "aggregate ticks from worst to a threshold, consuming whatever positions sit in that " +
    "range. \"Eligible\" means a position's ratio has entered the zone a sweep could " +
    "reach - not a guarantee it will be, which depends on aggregate sweep depth and what " +
    "else is queued ahead of it in the same vault.",
  "protocol_params does not carry per-asset liquidation incentive/bonus - the methodology " +
    "table's incentive figures are derived live from Aave's PoolDataProvider, not the DB.",
  "The Aave indexer's initial backfill is bounded (~50,000 blocks), not a full historical " +
    "scan from Aave V3's mainnet launch - demo-scale by design, not an oversight. As a direct " +
    "consequence, this deployment currently holds a small real sample of positions (not " +
    "thousands) - every count and curve shown (toxic-position count, liquidatable collateral, " +
    "bad debt, the per-position drilldown) demonstrates the mechanism correctly on real " +
    "on-chain data, but is not yet a statistically representative measure of Aave's actual " +
    "risk book. Both scale up automatically with a wider backfill window - same code, same " +
    "data path, just a longer indexer run, no redeploy logic changes required.",
  "Two different confidence levels are blended in this tool, and they shouldn't be read as " +
    "equally certain. Health factor / LTV are exact, real liquidation-formula math, " +
    "empirically checked against Aave's own on-chain getUserAccountData() (matched to " +
    "within 10 bps on real positions). Bad debt is a simplified aggregate approximation " +
    "(max(0, debt - collateral)) - it does not replicate the real contract's close-factor " +
    "limits or per-asset seizure mechanics, and has not yet been checked against a real " +
    "liquidation call's actual output the way health factor was. Closing that gap is a " +
    "planned Validation-tier extension (eth_call against the real liquidation function with " +
    "a price override), not yet built.",
  "The undercollateralization-frontier figure (LTV past which any liquidation under this " +
    "protocol's own fixed-bonus mechanism is guaranteed to worsen a position, not improve " +
    "it) is a direct algebraic consequence of each protocol's own published liquidation " +
    "threshold and bonus - independently verifiable from those two numbers alone, not " +
    "borrowed authority from any external paper.",
];

export function registerMetaRoute(app: FastifyInstance, deps: { db: Kysely<DB>; client: PublicClient }) {
  app.get("/api/meta", async () => {
    const [latestSnapshot, latestFluidSnapshot] = await Promise.all([
      deps.db
        .selectFrom("snapshots")
        .select(["pinned_block"])
        .where("protocol", "=", "aave")
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst(),
      deps.db
        .selectFrom("snapshots")
        .select(["pinned_block"])
        .where("protocol", "=", "fluid")
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst(),
    ]);

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
      fluidPinnedBlock: latestFluidSnapshot?.pinned_block ?? null,
      presets: Object.values(SHOCK_PRESETS),
      ucFrontier,
      limitations: LIMITATIONS,
      capabilities: { rpc: true, fork: false },
    };
  });
}
