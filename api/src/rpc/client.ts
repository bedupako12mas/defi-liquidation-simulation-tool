import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

// A set, not a single ID, on purpose - see docs/decisions.md. Today this has one member.
const ALLOWED_CHAIN_IDS = new Set<number>([mainnet.id]); // 1

export function createRpcClient(rpcUrl: string, options?: { multicallBatchSize?: number }) {
  // Defense in depth, not just index-fluid.ts's own eager validation: a NaN or negative
  // multicallBatchSize (e.g. a caller passing a malformed env value straight through)
  // is falsy/never===0, so the ternary below would silently fall to `true` - full
  // unbounded multicall - the exact behavior this option exists to let a caller disable.
  // Failing loud here means a future call site that skips its own validation still can't
  // silently reintroduce the 550M-gas failure this was built to prevent.
  if (
    options?.multicallBatchSize !== undefined &&
    (!Number.isFinite(options.multicallBatchSize) || options.multicallBatchSize < 0)
  ) {
    throw new Error(`multicallBatchSize must be a non-negative finite number, got ${options.multicallBatchSize}.`);
  }

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 10_000,
    }),
    // Real, live-caught (2026-09-15): viem's default multicall batching has no gas cap of
    // its own - it groups every readContract() call issued in the same tick into one
    // eth_call. loadFluidPositions()'s getAllVaultPositions() return value is large per
    // vault, so even a shrunk batchSize (tried 512) still grouped 14 vaults and blew a real
    // RPC gas limit ("gas required exceeds: 550000000") - batchSize alone wasn't enough.
    // multicallBatchSize === 0 disables multicall entirely for a specific caller (e.g.
    // index-fluid.ts): one eth_call per vault, individually well under any gas cap, at the
    // cost of more RPC round-trips (a recoverable rate-limit problem, not a hard wall).
    // Omitted, this is byte-for-byte the same `{ multicall: true }` every existing call site
    // (including the live server) already runs with.
    batch: {
      multicall:
        options?.multicallBatchSize === 0
          ? false
          : options?.multicallBatchSize
            ? { batchSize: options.multicallBatchSize }
            : true,
    },
  });

  /**
   * Must be awaited once, before publicClient is trusted anywhere - fails loud at
   * startup rather than silently computing numbers against the wrong network.
   */
  async function assertAllowedChain(): Promise<void> {
    const chainId = await publicClient.getChainId();
    if (!ALLOWED_CHAIN_IDS.has(chainId)) {
      throw new Error(
        `RPC endpoint reports chainId=${chainId}, which is not in the allowlist ` +
          `[${[...ALLOWED_CHAIN_IDS].join(", ")}]. Refusing to proceed.`,
      );
    }
  }

  return { publicClient, assertAllowedChain };
}

const rpcUrl = process.env.RPC_URL_MAINNET;
if (!rpcUrl) {
  throw new Error("RPC_URL_MAINNET is not set");
}

// Production default - same URL, same allowlist, same retry/batch config as before this
// file was refactored into a factory. Every existing/future call site that just wants
// "the real one" keeps importing these two names unchanged.
export const { publicClient, assertAllowedChain } = createRpcClient(rpcUrl);
