import type { PublicClient } from "viem";
import { parseAbi } from "viem";
import type { AaveReserveConfig } from "./aaveReserveConfig.js";
import type { CollateralLeg, DebtLeg, Position } from "../engine/types.js";

const DATA_PROVIDER_ABI = parseAbi([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
]);

export interface EnrichPositionsResult {
  positions: Position[];
  /** Count of (candidate, reserve) multicall entries that reverted/failed - a nonzero
   *  count means some real collateral/debt may be silently missing from the positions
   *  above. Surfaced explicitly rather than swallowed, per review - see docs/decisions.md. */
  failedCallCount: number;
}

/**
 * Builds one real Position per candidate address that still has an open borrow, from a
 * batched (address x reserve) multicall. Candidates with zero remaining debt (fully
 * repaid since being discovered by loader part 1) are dropped - a discovered address is
 * a *candidate*, not a guarantee of a current position.
 *
 * Queries EVERY reserve in reserveConfigs, not just isActive ones - a user's existing
 * debt/collateral in a since-deactivated reserve is still real debt/collateral and must
 * still count toward their health factor. isActive/isFrozen govern whether NEW
 * operations are allowed on a reserve, not whether EXISTING balances are real. An
 * earlier version of this file filtered to isActive reserves before building the
 * multicall, which silently dropped real debt for any paused/deprecated reserve - a
 * dangerous-direction bug (health factor reads healthier than reality) caught in review,
 * not by design.
 */
// Candidates per multicall batch, not all-at-once. A single (candidates x reserveConfigs)
// multicall silently failed 100% of ~110,000 calls in real usage - traced to the free-tier
// RPC rate limit (the same key had just been hammered by discovery's eth_getLogs volume),
// not a code/ABI bug (a lone readContract/multicall call with the same ABI against the
// same contract succeeded immediately). Sequential, not Promise.all - same reasoning as
// aaveBorrowDiscovery.ts's own retry logic: don't multiply load on an already-limited
// provider. Overridable so a paid tier isn't artificially throttled either.
const DEFAULT_ENRICH_BATCH_SIZE = 25;

// A real, confirmed run of 4,958 calls at batchSize=15 with zero pacing produced zero
// failures (task #51's isolated diagnostic) - ruling out a structural/interface problem.
// The original 69% failure only showed up at real widening-run scale (thousands of calls,
// several minutes of sustained load), which a quick small test can't reproduce - consistent
// with rate limiting that only bites under sustained load, not a per-batch defect. Dropping
// batch size (25->15) alone didn't help because batch size controls request SIZE, not
// request RATE - this pacing delay targets the actual lever. Overridable for the same
// reason batch size is: a paid tier shouldn't be artificially throttled either.
const DEFAULT_INTER_BATCH_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function enrichPositions(
  client: PublicClient,
  dataProviderAddress: `0x${string}`,
  candidates: string[],
  reserveConfigs: AaveReserveConfig[],
  blockNumber?: bigint,
  batchSize: number = DEFAULT_ENRICH_BATCH_SIZE,
  interBatchDelayMs: number = DEFAULT_INTER_BATCH_DELAY_MS,
): Promise<EnrichPositionsResult> {
  type ReserveDataResult =
    | { status: "success"; result: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean] }
    | { status: "failure"; error: Error; result?: undefined };

  const results: ReserveDataResult[] = [];
  let totalContracts = 0;

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batchCandidates = candidates.slice(i, i + batchSize);
    const contracts = batchCandidates.flatMap((user) =>
      reserveConfigs.map(
        (reserve) =>
          ({
            address: dataProviderAddress,
            abi: DATA_PROVIDER_ABI,
            functionName: "getUserReserveData",
            args: [reserve.asset, user as `0x${string}`],
          }) as const,
      ),
    );

    if (contracts.length === 0) continue;
    totalContracts += contracts.length;
    const batchResults = (await client.multicall({ contracts, allowFailure: true, blockNumber })) as ReserveDataResult[];
    results.push(...batchResults);

    if (interBatchDelayMs > 0 && i + batchSize < candidates.length) {
      await sleep(interBatchDelayMs);
    }
  }

  const positions: Position[] = [];
  let failedCallCount = 0;
  // Sampled, not exhaustive - enough to see the real failure shape (rate limit vs.
  // timeout vs. something else) without bloating logs when failures are widespread.
  const failureSample: string[] = [];
  const FAILURE_SAMPLE_SIZE = 8;

  for (let ci = 0; ci < candidates.length; ci++) {
    const user = candidates[ci];
    if (user === undefined) continue;

    const collateral: CollateralLeg[] = [];
    const debt: DebtLeg[] = [];

    for (let ri = 0; ri < reserveConfigs.length; ri++) {
      const reserve = reserveConfigs[ri];
      const result = results[ci * reserveConfigs.length + ri];
      if (!reserve || !result) continue;
      if (result.status !== "success") {
        failedCallCount++;
        if (failureSample.length < FAILURE_SAMPLE_SIZE) {
          const name = result.error?.name ?? "UnknownError";
          const message = (result.error?.message ?? "").split("\n")[0]?.slice(0, 160) ?? "";
          failureSample.push(`${name}: ${message}`);
        }
        continue;
      }

      const [aTokenBalance, stableDebt, variableDebt, , , , , , usageAsCollateralEnabled] = result.result;

      // usageAsCollateralEnabled: Aave lets a user hold an aToken balance while opting
      // it OUT of collateral usage (Pool.setUserUseReserveAsCollateral). Counting that
      // balance as collateral anyway would overstate this position's real health factor -
      // a real, non-obvious correctness bug, not a hypothetical one.
      if (aTokenBalance > 0n && usageAsCollateralEnabled) {
        collateral.push({
          asset: reserve.asset,
          amount: aTokenBalance,
          decimals: reserve.decimals,
          liquidationThresholdBps: reserve.liquidationThresholdBps,
        });
      }

      const totalDebt = stableDebt + variableDebt;
      if (totalDebt > 0n) {
        debt.push({ asset: reserve.asset, amount: totalDebt, decimals: reserve.decimals });
      }
    }

    if (debt.length === 0) continue; // fully repaid since discovery - not a current position

    positions.push({
      id: `aave-${user.toLowerCase()}`,
      protocol: "aave",
      user,
      collateral,
      debt,
      liquidationIncentiveBps: dominantCollateralIncentiveBps(collateral, reserveConfigs),
    });
  }

  if (failedCallCount > 0) {
    console.warn(
      `[aaveUserEnrichment] ${failedCallCount} of ${totalContracts} getUserReserveData calls failed - ` +
        `affected positions may be missing real collateral/debt legs. Sample of ${failureSample.length} ` +
        `failure reason(s):\n  ${failureSample.join("\n  ")}`,
    );
  }

  return { positions, failedCallCount };
}

/**
 * The engine's Position type carries one liquidationIncentiveBps per position, but Aave's
 * liquidation bonus is actually per-collateral-asset. Approximation: use the bonus of
 * whichever collateral leg has the largest USD value, since that's the asset a real
 * liquidator would most likely seize first. A position with zero *eligible* collateral
 * (nothing left, or every leg has an invalid/zero bonus - see below) falls back to 0n -
 * not a guess, a defensible degenerate value: undercollateralizationFrontier(0n) = 100%,
 * meaning "any nonzero LTV is already past the frontier," true by construction when
 * there's no real collateral to seize.
 *
 * Legs whose reserve has liquidationBonusRaw <= 10_000n are skipped entirely, not just
 * treated as a 0-bps bonus. Aave uses 0 as the sentinel for "not collateral-eligible"
 * (e.g. GHO on mainnet) - review caught that the previous version computed
 * `liquidationBonusRaw - 10_000n` unconditionally, which for such an asset produces
 * incentiveBps <= -10_000n. At exactly -10_000n, undercollateralizationFrontier's
 * `BPS + incentiveBps` divides by zero and crashes the engine; for anything between
 * -9999n and -1n it doesn't crash, it silently computes a frontier ABOVE 100%, making
 * isToxicLiquidation() *harder* to trigger than reality - the exact wrong-direction
 * masking this project exists to catch. Skipping these legs closes both failure modes at
 * the source instead of trusting every reserve to always report a sane bonus.
 */
function dominantCollateralIncentiveBps(
  collateral: CollateralLeg[],
  reserveConfigs: AaveReserveConfig[],
): bigint {
  let bestValueUsd8 = -1n;
  let bestBps = 0n;

  for (const leg of collateral) {
    const config = reserveConfigs.find((c) => c.asset === leg.asset);
    if (!config || config.liquidationBonusRaw <= 10_000n) continue;
    const valueUsd8 = (leg.amount * config.priceUsd8) / 10n ** BigInt(leg.decimals);
    if (valueUsd8 > bestValueUsd8) {
      bestValueUsd8 = valueUsd8;
      bestBps = config.liquidationBonusRaw - 10_000n; // raw is e.g. 10500 = 105% = 5% bonus
    }
  }

  return bestBps;
}
