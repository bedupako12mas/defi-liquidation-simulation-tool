import { type PublicClient, parseAbiItem, getAddress } from "viem";
import { AAVE_V4_SPOKE_ADDRESSES } from "./aaveV4Addresses.js";
import { withRateLimitRetry } from "../rpc/rateLimitRetry.js";

// Real event, confirmed from Aave's own ISpoke.sol (github.com/aave/aave-v4) - `user` is the
// position owner (real, NatSpec-documented: "The owner of the position on which debt is
// generated"), not the caller. Scanned across ALL 12 real Spokes in one call per chunk
// (viem's getLogs accepts an address array) rather than looping per-Spoke-per-chunk - a
// user discovered here isn't tied to one specific Spoke by this step; enrichment checks
// every real Spoke for that user's actual position.
const BORROW_EVENT = parseAbiItem(
  "event Borrow(uint256 indexed reserveId, address indexed caller, address indexed user, uint256 drawnShares, uint256 drawnAmount)",
);

export interface AaveV4BorrowCandidate {
  address: string;
  discoveredAtBlock: bigint;
}

export interface DiscoverAaveV4BorrowCandidatesParams {
  fromBlock: bigint;
  toBlock: bigint;
  /** Starting eth_getLogs range size, in blocks. Halved automatically on a range-limit error. */
  chunkSize?: bigint;
  onChunkScanned?: (chunkCandidates: AaveV4BorrowCandidate[], scannedThroughBlock: bigint) => Promise<void> | void;
}

// Real, live-confirmed (2026-09-10, probe-rate-limit-message.ts): this RPC's free tier
// caps eth_getLogs at EXACTLY 10 blocks. Starting at 5000 and letting the halving loop
// below find its way down still cost ~9 levels of splitting (5000->2500->...->10) - up
// to ~1000 sequential leaf calls PER logical chunk, all before the real candidate scan
// even begins, and the resulting call volume was enough to trigger genuine rate-limit
// errors that then looked like a stuck retry loop (indexer_progress never advanced,
// even after 30+ backoff cycles). Starting AT the real cap avoids the splitting cascade
// entirely rather than discovering it empirically every run - the index-aave-v4.ts
// AAVE_V4_INDEXER_CHUNK_SIZE override existed as a workaround for exactly this, but a
// safe default shouldn't require a caller to already know the provider's real limit.
const DEFAULT_CHUNK_SIZE = 10n;
const MIN_CHUNK_SIZE = 10n;

export async function discoverAaveV4BorrowCandidates(
  client: PublicClient,
  { fromBlock, toBlock, chunkSize = DEFAULT_CHUNK_SIZE, onChunkScanned }: DiscoverAaveV4BorrowCandidatesParams,
): Promise<AaveV4BorrowCandidate[]> {
  if (fromBlock > toBlock) {
    throw new Error(`fromBlock (${fromBlock}) is after toBlock (${toBlock})`);
  }

  const finalizedBlock = (await client.getBlock({ blockTag: "finalized" })).number;
  const safeToBlock = toBlock > finalizedBlock ? finalizedBlock : toBlock;
  if (safeToBlock < fromBlock) {
    return [];
  }

  const allCandidates: AaveV4BorrowCandidate[] = [];

  let cursor = fromBlock;
  while (cursor <= safeToBlock) {
    const rangeEnd = minBigInt(cursor + chunkSize - 1n, safeToBlock);
    const logs = await getLogsWithBackoff(client, cursor, rangeEnd);

    const chunkFirstSeen = new Map<string, bigint>();
    for (const log of logs) {
      if (log.args.user === undefined || log.blockNumber === null) continue;
      const address = getAddress(log.args.user);
      const existing = chunkFirstSeen.get(address);
      if (existing === undefined || log.blockNumber < existing) {
        chunkFirstSeen.set(address, log.blockNumber);
      }
    }

    const chunkCandidates = [...chunkFirstSeen.entries()].map(([address, discoveredAtBlock]) => ({
      address,
      discoveredAtBlock,
    }));
    allCandidates.push(...chunkCandidates);

    if (onChunkScanned) {
      await onChunkScanned(chunkCandidates, rangeEnd);
    }

    cursor = rangeEnd + 1n;
  }

  return allCandidates;
}

function fetchLogsOnce(client: PublicClient, fromBlock: bigint, toBlock: bigint) {
  return client.getLogs({
    address: AAVE_V4_SPOKE_ADDRESSES,
    event: BORROW_EVENT,
    fromBlock,
    toBlock,
  });
}

type BorrowLog = Awaited<ReturnType<typeof fetchLogsOnce>>[number];

// Real, live-caught bug (2026-09-10): this pattern used to include "too many", which ALSO
// matches a genuine 429 "Too Many Requests" rate-limit error - misclassifying it as a range
// error and triggering a range SPLIT (two requests instead of one) in response to a RATE
// problem, doubling load against an already-throttled endpoint instead of backing off from
// it. Narrowed to range-shaped phrasing only; rate-limit errors are checked first, below,
// and handled by withRateLimitRetry's real multi-second backoff instead.
const RANGE_LIMIT_ERROR_PATTERN = /range|too large|block span|limit exceeded/i;

function isRangeLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return RANGE_LIMIT_ERROR_PATTERN.test(message);
}

async function getLogsWithBackoff(client: PublicClient, fromBlock: bigint, toBlock: bigint): Promise<BorrowLog[]> {
  try {
    return await withRateLimitRetry(() => fetchLogsOnce(client, fromBlock, toBlock), "aaveV4BorrowDiscovery");
  } catch (err) {
    const rangeSize = toBlock - fromBlock + 1n;
    if (rangeSize <= MIN_CHUNK_SIZE || !isRangeLimitError(err)) {
      throw err;
    }
    const mid = fromBlock + rangeSize / 2n - 1n;
    const left = await getLogsWithBackoff(client, fromBlock, mid);
    const right = await getLogsWithBackoff(client, mid + 1n, toBlock);
    return [...left, ...right];
  }
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
