import type { PublicClient } from "viem";
import { parseAbi } from "viem";
import { resolveAaveAddresses } from "../loaders/aaveAddresses.js";
import { loadReserveConfigs } from "../loaders/aaveReserveConfig.js";
import { enrichPositions } from "../loaders/aaveUserEnrichment.js";
import { healthFactor } from "../engine/healthFactor.js";
import type { PriceVector } from "../engine/types.js";

const POOL_ABI = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

const UINT256_MAX = (1n << 256n) - 1n;

// Generous enough to absorb rounding-order differences between our per-leg summation and
// Aave's own weighted-average-threshold computation (algebraically equivalent, not
// bit-for-bit identical), tight enough that a real formula bug (wrong units, wrong
// threshold source, a missed leg) would blow well past it. Not tuned empirically against
// real data ahead of time - this commit's own verification run is what actually confirms
// whether 10 bps is the right number or too tight/loose. See docs/decisions.md.
const TOLERANCE_BPS = 10n;

export interface ValidationRow {
  user: string;
  /** Our engine's healthFactor(), computed from independently-enriched Position data. */
  ourHf: bigint | null;
  /** Aave's own on-chain getUserAccountData().healthFactor, same WAD convention. null
   *  when Aave returns type(uint256).max (its zero-debt sentinel), matching our engine's
   *  own null-for-zero-debt convention. */
  onChainHf: bigint | null;
  /** Absolute relative difference in basis points, null when not comparable (exactly one
   *  side is null - a real "we disagree about whether this position has debt" case). */
  diffBps: bigint | null;
  withinTolerance: boolean;
}

/**
 * The core validation check this whole RPC-tier build has been building toward: does the
 * engine's pure-function healthFactor() actually match what the real, deployed Aave V3
 * Pool contract computes for the same real users, at the same real block? Everything
 * upstream (loaders, enrichment, the engine itself) is validated indirectly by every test
 * that passed - this is the one direct, end-to-end check against ground truth.
 *
 * blockNumber is required, not optional with a "latest" default - see loadReserveConfigs'
 * and enrichPositions' docs for why an unpinned comparison would be comparing against
 * moving, interest-accruing targets and could show a "mismatch" that's just timing noise.
 */
export async function validateAaveHealthFactors(
  client: PublicClient,
  addresses: string[],
  blockNumber: bigint,
): Promise<ValidationRow[]> {
  const { dataProvider, pool } = await resolveAaveAddresses(client);
  const reserveConfigs = await loadReserveConfigs(client, blockNumber);
  const { positions } = await enrichPositions(client, dataProvider, addresses, reserveConfigs, blockNumber);

  const prices: PriceVector = Object.fromEntries(reserveConfigs.map((r) => [r.asset, r.priceUsd8]));
  const positionsByUser = new Map(positions.map((p) => [p.user.toLowerCase(), p]));

  const accountDataResults =
    addresses.length > 0
      ? await client.multicall({
          contracts: addresses.map(
            (user) =>
              ({
                address: pool,
                abi: POOL_ABI,
                functionName: "getUserAccountData",
                args: [user as `0x${string}`],
              }) as const,
          ),
          allowFailure: true,
          blockNumber,
        })
      : [];

  const rows: ValidationRow[] = [];

  for (let i = 0; i < addresses.length; i++) {
    const user = addresses[i];
    const result = accountDataResults[i];
    if (!user || !result || result.status !== "success") continue;

    const [, , , , , onChainHfRaw] = result.result;
    const onChainHf = onChainHfRaw >= UINT256_MAX ? null : onChainHfRaw;

    const position = positionsByUser.get(user.toLowerCase());
    const ourHf = position ? healthFactor(position, prices) : null;

    const diffBps = computeDiffBps(ourHf, onChainHf);

    rows.push({
      user,
      ourHf,
      onChainHf,
      diffBps,
      withinTolerance: diffBps !== null ? diffBps <= TOLERANCE_BPS : ourHf === null && onChainHf === null,
    });
  }

  return rows;
}

function computeDiffBps(a: bigint | null, b: bigint | null): bigint | null {
  if (a === null || b === null) return null;
  if (a === b) return 0n;
  const larger = a > b ? a : b;
  const smaller = a > b ? b : a;
  if (larger === 0n) return 0n;
  return ((larger - smaller) * 10_000n) / larger;
}
