import type { PublicClient } from "viem";

// Real, live-diagnosed fix (not a guess) - see docs/decisions.md's 2026-09-10 entry. A
// direct stress test against the real free-tier RPC found the true failure mode behind a
// 74% enrichment failure rate: a genuine HTTP 429 rate limit that, once triggered, stays
// active for ~50+ seconds - far longer than viem's own default retry (retryCount: 3,
// retryDelay: 500ms, ~1.5s total), and every one of THOSE retries is itself a real request
// counted against the same budget, actively prolonging the outage instead of backing off
// from it. Shared here (not duplicated per loader) since the fix is a generic retry
// algorithm, not protocol-specific - used by both Aave V3's and Aave V4's enrichment.
const RATE_LIMIT_ERROR_PATTERN = /429|too many requests|rate limit/i;
const MAX_BATCH_RETRIES = 4;
const RATE_LIMIT_BACKOFF_BASE_MS = 5000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitShapedFailure(result: { status: string; error?: Error }): boolean {
  if (result.status !== "failure") return false;
  const message = result.error instanceof Error ? result.error.message : String(result.error ?? "");
  return RATE_LIMIT_ERROR_PATTERN.test(message);
}

/**
 * Runs one multicall batch, retrying the WHOLE batch (not individual calls) with real,
 * multi-second exponential backoff if a majority of its failures look rate-limit-shaped. A
 * batch that fails for a DIFFERENT reason (a real revert, a malformed call) is returned as-is
 * on the first attempt - only genuine rate-limiting is worth waiting out. Confirmed
 * empirically to recover: the diagnosing stress test saw a clean run resume once ~50s had
 * passed with no further load on the same key.
 */
export async function multicallWithRateLimitRetry<T extends { status: string; error?: Error }>(
  client: PublicClient,
  contracts: Parameters<PublicClient["multicall"]>[0]["contracts"],
  blockNumber: bigint | undefined,
  logLabel: string,
): Promise<T[]> {
  let attempt = 0;
  while (true) {
    const results = (await client.multicall({ contracts, allowFailure: true, blockNumber })) as T[];
    const failures = results.filter((r) => r.status === "failure");
    if (failures.length === 0) return results;

    const rateLimited = failures.filter(isRateLimitShapedFailure).length;
    const isMajorityRateLimited = rateLimited > failures.length / 2;
    if (!isMajorityRateLimited || attempt >= MAX_BATCH_RETRIES) return results;

    attempt++;
    const backoffMs = RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (attempt - 1);
    console.warn(
      `[${logLabel}] batch looks rate-limited (${rateLimited}/${failures.length} failures are 429-shaped) - backing off ${backoffMs}ms before retry ${attempt}/${MAX_BATCH_RETRIES}`,
    );
    await sleep(backoffMs);
  }
}

/**
 * Same real backoff discipline as multicallWithRateLimitRetry, applied to a single
 * non-multicall call (e.g. eth_getLogs, which can't be wrapped in a Multicall3 aggregate).
 * Retries the SAME call (not a smaller/split version) - a 429 is a rate problem, not a
 * range/size problem, so splitting would only add more requests against an already-limited
 * endpoint.
 */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, logLabel: string): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!RATE_LIMIT_ERROR_PATTERN.test(message) || attempt >= MAX_BATCH_RETRIES) throw err;
      attempt++;
      const backoffMs = RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (attempt - 1);
      console.warn(`[${logLabel}] call looks rate-limited - backing off ${backoffMs}ms before retry ${attempt}/${MAX_BATCH_RETRIES}`);
      await sleep(backoffMs);
    }
  }
}
