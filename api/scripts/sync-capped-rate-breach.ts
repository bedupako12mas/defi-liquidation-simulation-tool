import { publicClient, assertAllowedChain } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { loadFluidVaultConfigs } from "../src/loaders/fluidVaultConfig.js";
import { resolveFluidOverrideTarget } from "../src/validation/fluidValidator.js";
import { startAnvilFork } from "../src/fork/anvilFork.js";
import { buildFixedReturnBytecode } from "../src/validation/stateOverride.js";
import { redactError } from "../src/rpc/redact.js";
import { parseAbi } from "viem";
import type { Insertable } from "kysely";
import type { CappedRateBreachResultsTable } from "../src/db/types.js";

/**
 * #38 (SCOPE.md item 3b) - the real mechanism behind the March 2026 Resolv exploit (~$21M bad
 * debt): does Fluid's CappedRate cap-enforcement logic correctly clamp an extreme raw-source
 * move once its heartbeat genuinely elapses, or does it slip through unclamped? "Designed
 * staleness" (getExchangeRateLiquidate() only re-reads the raw source once block.timestamp
 * passes lastUpdateTime + minHeartbeat, fluidCappedRate.sol - verified against real source:
 * github.com/Instadapp/fluid-contracts-public) means a plain eth_call against a currently-
 * fresh vault can never observe the AFTER state - genuinely fork-requiring, since only a
 * fork can move real block.timestamp forward.
 *
 * REAL, LIVE-CAUGHT DESIGN NOTE: getExchangeRateLiquidate()'s down-cap branch is gated by a
 * separate admin-set boolean, avoidForcedLiquidationsCol_ - down-capping only applies at all
 * when this is true, independent of the numeric bound. An earlier draft of this test
 * discarded that flag and reported a misleading "protection works" verdict from the numeric
 * bound alone (100% >= 100%, vacuously true whenever the bound itself is 100%). A live sweep
 * of every fresh vault found (18 of them) showed ALL have this flag false - a real,
 * protocol-wide pattern, not a per-vault quirk.
 *
 * Sweeps every real vault whose CappedRate hop is currently fresh (heartbeat not yet
 * elapsed) - that's the only state where a before/after contrast is even meaningful; a
 * vault whose heartbeat has already elapsed in real time would show the same result via a
 * plain eth_call, no fork needed.
 */
const RAW_OVERRIDE = 1n; // smallest nonzero - the real source explicitly reverts (CappedRate__NewRateZero) on exactly 0
const SIX_DECIMALS = 1_000_000n;
const MAX_VAULTS = 10;

const CONFIG_DATA_ABI = parseAbi([
  "function configData() view returns (address liquidity_, uint16 minUpdateDiffPercent_, uint24 minHeartbeat_, uint40 lastUpdateTime_, address rateSource_, bool invertCenterPrice_, bool avoidForcedLiquidationsCol_, bool avoidForcedLiquidationsDebt_, uint256 maxAPRPercent_, uint24 maxDownFromMaxReachedPercentCol_, uint24 maxDownFromMaxReachedPercentDebt_, uint256 maxDebtUpCapPercent_)",
]);
const GET_RATE_ABI = parseAbi(["function getExchangeRateLiquidate() view returns (uint256)"]);

async function testVault(
  vault: string,
  cappedRate: `0x${string}`,
  rateSource: `0x${string}`,
  minHeartbeat: number,
  avoidForcedLiquidationsCol: boolean,
  maxDownCol: number,
  realCachedBefore: bigint,
  forkPort: number,
): Promise<Insertable<CappedRateBreachResultsTable>> {
  const fork = await startAnvilFork(undefined, forkPort);
  try {
    await fork.setCode(rateSource, buildFixedReturnBytecode(RAW_OVERRIDE));
    const rateImmediatelyAfterOverride = await fork.publicClient.readContract({ address: cappedRate, abi: GET_RATE_ABI, functionName: "getExchangeRateLiquidate" });

    await fork.mine(1, minHeartbeat + 60);

    const rateAfterHeartbeat = await fork.publicClient.readContract({ address: cappedRate, abi: GET_RATE_ABI, functionName: "getExchangeRateLiquidate" });

    const realDropPct = realCachedBefore > 0n ? (Number(realCachedBefore - rateAfterHeartbeat) / Number(realCachedBefore)) * 100 : 0;
    const configuredMaxDownPct = maxDownCol / (Number(SIX_DECIMALS) / 100);

    let verdict: string;
    if (!avoidForcedLiquidationsCol) {
      verdict = "protection-disabled";
    } else if (realDropPct <= configuredMaxDownPct + 0.01) {
      verdict = "clamped-as-designed";
    } else {
      verdict = "unclamped-beyond-bound";
    }

    console.log(`[sync-capped-rate] ${vault}: drop=${realDropPct.toFixed(4)}% bound=${configuredMaxDownPct.toFixed(4)}% verdict=${verdict}`);

    return {
      vault,
      capped_rate_address: cappedRate,
      min_heartbeat_seconds: minHeartbeat,
      avoid_forced_liquidations_col: avoidForcedLiquidationsCol,
      max_down_from_max_reached_pct_col: maxDownCol.toString(),
      rate_before: realCachedBefore,
      rate_immediately_after_override: rateImmediatelyAfterOverride,
      rate_after_heartbeat: rateAfterHeartbeat,
      real_drop_pct: realDropPct.toFixed(6),
      verdict,
    };
  } finally {
    fork.stop();
  }
}

async function main() {
  await assertAllowedChain();

  const vaults = await loadFluidVaultConfigs(publicClient);
  console.log(`[sync-capped-rate] searching ${vaults.length} real vaults for a fresh CappedRate hop (up to ${MAX_VAULTS})...`);

  const rows: Insertable<CappedRateBreachResultsTable>[] = [];
  let portOffset = 0;

  for (const vault of vaults) {
    if (rows.length >= MAX_VAULTS) break;

    try {
      const resolution = await resolveFluidOverrideTarget(publicClient, vault.oracle, "internal-exchange-rate");
      if (resolution.status !== "resolved" || resolution.stubKind !== "capped-rate-storage") continue;

      const config = await publicClient.readContract({ address: resolution.overrideAddress, abi: CONFIG_DATA_ABI, functionName: "configData" }).catch(() => null);
      if (!config) continue;
      const [, , minHeartbeat, lastUpdateTime, rateSource, , avoidForcedLiquidationsCol, , , maxDownCol] = config;

      const nowBlock = await publicClient.getBlock();
      const isFresh = Number(nowBlock.timestamp) < Number(lastUpdateTime) + Number(minHeartbeat);
      if (!isFresh) continue;

      const realCachedBefore = await publicClient.readContract({ address: resolution.overrideAddress, abi: GET_RATE_ABI, functionName: "getExchangeRateLiquidate" }).catch(() => null);
      if (realCachedBefore === null || realCachedBefore <= 0n) continue;

      const row = await testVault(vault.vault, resolution.overrideAddress, rateSource, Number(minHeartbeat), avoidForcedLiquidationsCol, Number(maxDownCol), realCachedBefore, 8650 + portOffset);
      portOffset++;
      rows.push(row);
    } catch (err) {
      console.warn(`[sync-capped-rate] ${vault.vault} failed, skipping:`, redactError(err));
    }
  }

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("capped_rate_breach_results").execute();
    if (rows.length > 0) await trx.insertInto("capped_rate_breach_results").values(rows).execute();
  });
  console.log(`[sync-capped-rate] wrote ${rows.length} row(s).`);

  await db.destroy();
}

main().catch(async (err) => {
  console.error(redactError(err));
  await db.destroy();
  process.exitCode = 1;
});
