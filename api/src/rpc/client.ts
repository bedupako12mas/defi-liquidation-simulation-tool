import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

// A set, not a single ID, on purpose - see docs/decisions.md. Today this has one member.
const ALLOWED_CHAIN_IDS = new Set<number>([mainnet.id]); // 1

const rpcUrl = process.env.RPC_URL_MAINNET;
if (!rpcUrl) {
  throw new Error("RPC_URL_MAINNET is not set");
}

export const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(rpcUrl, {
    retryCount: 3,
    retryDelay: 500,
    timeout: 10_000,
  }),
  batch: { multicall: true },
});

/**
 * Must be awaited once, before publicClient is trusted anywhere - fails loud at
 * startup rather than silently computing numbers against the wrong network.
 */
export async function assertAllowedChain(): Promise<void> {
  const chainId = await publicClient.getChainId();
  if (!ALLOWED_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `RPC endpoint reports chainId=${chainId}, which is not in the allowlist ` +
        `[${[...ALLOWED_CHAIN_IDS].join(", ")}]. Refusing to proceed.`,
    );
  }
}
