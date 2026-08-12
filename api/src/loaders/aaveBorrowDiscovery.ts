import { type PublicClient, parseAbiItem, getAddress } from "viem";
import { AAVE_V3_POOL_ADDRESS } from "./aaveAddresses.js";

// onBehalfOf, not user, is the account whose debt actually increases - user is only the
// caller (relevant for credit-delegated borrows). See docs/decisions.md - getting this
// backwards would silently populate candidates with the wrong addresses.
const BORROW_EVENT = parseAbiItem(
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
);

export interface BorrowCandidate {
  address: string;
  discoveredAtBlock: bigint;
}

export interface DiscoverBorrowCandidatesParams {
  fromBlock: bigint;
  toBlock: bigint;
  /** Starting eth_getLogs range size, in blocks. Halved automatically on a range-limit error. */
  chunkSize?: bigint;
  /**
   * Called after each chunk is successfully scanned, with just that chunk's candidates and
   * the block it scanned through. Lets a caller persist progress incrementally (e.g. write
   * to aave_borrow_candidates and advance indexer_progress) so a later chunk's failure
   * doesn't discard everything already found - see docs/decisions.md, this was a real
   * finding from review, not a hypothetical.
   */
  onChunkScanned?: (chunkCandidates: BorrowCandidate[], scannedThroughBlock: bigint) => Promise<void> | void;
}

const DEFAULT_CHUNK_SIZE = 5000n;
const MIN_CHUNK_SIZE = 50n;

export async function discoverBorrowCandidates(
  client: PublicClient,
  { fromBlock, toBlock, chunkSize = DEFAULT_CHUNK_SIZE, onChunkScanned }: DiscoverBorrowCandidatesParams,
): Promise<BorrowCandidate[]> {
  if (fromBlock > toBlock) {
    throw new Error(`fromBlock (${fromBlock}) is after toBlock (${toBlock})`);
  }

  // Never scan into reorg-able territory, even if the caller asked for a later toBlock -
  // a candidate discovered from a block that later gets reorged out would be written to
  // aave_borrow_candidates permanently (ON CONFLICT DO NOTHING has no delete path). Clamp
  // at the boundary rather than trusting every future caller to pass a safe toBlock.
  const finalizedBlock = (await client.getBlock({ blockTag: "finalized" })).number;
  const safeToBlock = toBlock > finalizedBlock ? finalizedBlock : toBlock;
  if (safeToBlock < fromBlock) {
    return [];
  }

  const allCandidates: BorrowCandidate[] = [];

  let cursor = fromBlock;
  while (cursor <= safeToBlock) {
    const rangeEnd = minBigInt(cursor + chunkSize - 1n, safeToBlock);
    const logs = await getLogsWithBackoff(client, cursor, rangeEnd);

    const chunkFirstSeen = new Map<string, bigint>();
    for (const log of logs) {
      if (log.args.onBehalfOf === undefined || log.blockNumber === null) continue;
      const address = getAddress(log.args.onBehalfOf);
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
    address: AAVE_V3_POOL_ADDRESS,
    event: BORROW_EVENT,
    fromBlock,
    toBlock,
  });
}

type BorrowLog = Awaited<ReturnType<typeof fetchLogsOnce>>[number];

// Only a range/limit-shaped error justifies splitting and retrying - a 429, an auth
// failure, or a network blip won't be fixed by asking for a smaller range, and treating
// them as if they would (the original version of this function did) turns one persistent
// failure into a fan-out of retries against an endpoint that's already struggling. This
// is a heuristic (providers don't return a machine-readable "this was a range error"
// signal), not a guarantee - but it's a real filter, not none at all.
const RANGE_LIMIT_ERROR_PATTERN = /range|too large|too many|block span|limit exceeded/i;

function isRangeLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return RANGE_LIMIT_ERROR_PATTERN.test(message);
}

/**
 * Fetches one [fromBlock, toBlock] range, halving and retrying as two sub-ranges if the
 * provider rejects it for looking like a range-too-large error. Providers don't announce
 * their max range up front and the limit varies by provider/plan, so this discovers a
 * working size empirically rather than hardcoding one and hoping.
 */
async function getLogsWithBackoff(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<BorrowLog[]> {
  try {
    return await fetchLogsOnce(client, fromBlock, toBlock);
  } catch (err) {
    const rangeSize = toBlock - fromBlock + 1n;
    if (rangeSize <= MIN_CHUNK_SIZE || !isRangeLimitError(err)) {
      throw err;
    }
    const mid = fromBlock + rangeSize / 2n - 1n;
    // Sequential, not concurrent (Promise.all) - a range/rate-limit-shaped error means
    // back off, not hit the same struggling endpoint with two requests instead of one.
    const left = await getLogsWithBackoff(client, fromBlock, mid);
    const right = await getLogsWithBackoff(client, mid + 1n, toBlock);
    return [...left, ...right];
  }
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
