import { spawn, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, http, type Address, type PublicClient, type WalletClient } from "viem";
import { mainnet } from "viem/chains";
import { createRpcClient } from "../rpc/client.js";

/**
 * #37/#38: the one tier where state genuinely persists across multiple real, mined
 * transactions - the capability neither #30's state-override eth_call nor #43's
 * eth_estimateGas can provide, since both are isolated, stateless single calls by design.
 * Ephemeral by architecture decision (docs/decisions.md's #37/#38 scoping): this cluster's
 * single node has no spare capacity for a persistent forked node (confirmed live this
 * session), and a fork's value here is diagnostic, not a live user-facing feature - so it
 * spins up only for the duration of a sync run, same pattern test/globalSetup.ts already
 * uses for the test suite, and tears down immediately after. Never deployed to the cluster.
 */

const DEFAULT_PORT = 8546; // deliberately different from test/globalSetup.ts's 8545, so a sync run and the test suite can never collide on the same port

export interface AnvilFork {
  rpcUrl: string;
  publicClient: PublicClient;
  stop: () => void;
  /** anvil's real impersonation cheat code - lets us send transactions AS a real,
   *  already-funded mainnet address (e.g. a real large USDC/WETH holder) without needing to
   *  fund a fresh synthetic account at all. Real ETH for gas is set via anvil_setBalance,
   *  since impersonation alone doesn't grant ETH. */
  impersonate: (address: Address) => Promise<WalletClient>;
  /** Real block mining + real time progression - what a real CappedRate heartbeat check
   *  needs to actually re-evaluate against a genuinely later block.timestamp, not a single
   *  frozen instant. */
  mine: (blocks: number, intervalSeconds?: number) => Promise<void>;
  /** Permanently replaces a contract's real bytecode on the fork - the persistent-state
   *  equivalent of stateOverride.ts's per-call `code` override (aaveValidator.ts's price
   *  feed stubs, fluidValidator.ts's Chainlink-tuple stub). Unlike a per-call override, this
   *  sticks across every subsequent real transaction until the fork is torn down - what
   *  chaining multiple real liquidations against the SAME shocked price actually needs. */
  setCode: (address: Address, code: `0x${string}`) => Promise<void>;
  /** Permanently sets one storage slot - the persistent-state equivalent of a stateDiff
   *  override (fluidValidator.ts's CappedRate slot0 override). */
  setStorageAt: (address: Address, slot: `0x${string}`, value: `0x${string}`) => Promise<void>;
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result;
}

/**
 * Spawns a real, ephemeral anvil fork at the given block (defaults to latest), waits for it
 * to genuinely be ready (same discipline as test/globalSetup.ts - poll assertAllowedChain(),
 * not a cheaper proxy), and returns real control functions. Caller MUST call stop() when
 * done - there is no automatic cleanup beyond process exit.
 */
export async function startAnvilFork(forkBlockNumber?: bigint, port: number = DEFAULT_PORT): Promise<AnvilFork> {
  const forkUrl = process.env.RPC_URL_MAINNET;
  if (!forkUrl) throw new Error("RPC_URL_MAINNET is not set (needed as anvil's --fork-url)");

  const args = ["--fork-url", forkUrl, "--port", String(port), "--silent"];
  if (forkBlockNumber !== undefined) args.push("--fork-block-number", forkBlockNumber.toString());

  const proc: ChildProcess = spawn("anvil", args);
  const rpcUrl = `http://127.0.0.1:${port}`;

  const { assertAllowedChain } = createRpcClient(rpcUrl);
  const start = Date.now();
  const timeoutMs = 20_000;
  while (Date.now() - start < timeoutMs) {
    try {
      await assertAllowedChain();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
      if (Date.now() - start >= timeoutMs) {
        proc.kill("SIGKILL");
        throw new Error(`anvil did not become ready within ${timeoutMs}ms`);
      }
    }
  }

  const publicClient = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });

  return {
    rpcUrl,
    publicClient,
    stop: () => proc.kill("SIGKILL"),
    impersonate: async (address: Address) => {
      await rpcCall(rpcUrl, "anvil_impersonateAccount", [address]);
      // Generous, obviously-synthetic real ETH for gas - anvil's own cheat code, not a real
      // transfer from anywhere, so this doesn't need to come from the impersonated
      // account's own real balance.
      await rpcCall(rpcUrl, "anvil_setBalance", [address, "0x56BC75E2D63100000"]); // 100 ETH
      return createWalletClient({ account: address, chain: mainnet, transport: http(rpcUrl) });
    },
    mine: async (blocks: number, intervalSeconds = 12) => {
      await rpcCall(rpcUrl, "anvil_mine", [`0x${blocks.toString(16)}`, `0x${intervalSeconds.toString(16)}`]);
    },
    setCode: async (address: Address, code: `0x${string}`) => {
      await rpcCall(rpcUrl, "anvil_setCode", [address, code]);
    },
    setStorageAt: async (address: Address, slot: `0x${string}`, value: `0x${string}`) => {
      await rpcCall(rpcUrl, "anvil_setStorageAt", [address, slot, value]);
    },
  };
}
