import { spawn, type ChildProcess } from "node:child_process";
import { createRpcClient } from "../src/rpc/client.js";

const ANVIL_PORT = 8545;
const FORK_BLOCK_NUMBER = process.env.ANVIL_FORK_BLOCK_NUMBER ?? "21000000";

let anvil: ChildProcess | undefined;

export async function setup(): Promise<void> {
  const forkUrl = process.env.RPC_URL_MAINNET;
  if (!forkUrl) {
    throw new Error("RPC_URL_MAINNET is not set (needed as anvil's --fork-url)");
  }

  anvil = spawn("anvil", [
    "--fork-url",
    forkUrl,
    "--fork-block-number",
    FORK_BLOCK_NUMBER,
    "--port",
    String(ANVIL_PORT),
    "--silent",
  ]);

  const anvilRpcUrl = `http://127.0.0.1:${ANVIL_PORT}`;
  process.env.ANVIL_RPC_URL = anvilRpcUrl;
  await waitForReady(anvilRpcUrl);
}

async function waitForReady(url: string, timeoutMs = 15_000): Promise<void> {
  // Poll assertAllowedChain(), not just getBlockNumber() - observed empirically during
  // verification that anvil's port can start answering eth_blockNumber slightly before
  // its fork handshake (which resolves eth_chainId from the upstream) has settled. Since
  // "ready" here means "safe to trust for the allowlist check too," the readiness
  // condition has to be the same check callers actually depend on, not a cheaper proxy
  // for it - a proxy that resolves early is exactly how this bug slipped in as a false
  // "ready" signal in the first place.
  const { assertAllowedChain } = createRpcClient(url);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await assertAllowedChain();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`anvil did not become ready within ${timeoutMs}ms`);
}

export async function teardown(): Promise<void> {
  // SIGKILL, not SIGTERM - a wedged/large forked-state anvil process shutting down
  // slowly shouldn't be able to hang CI. Vitest guarantees this runs even when tests fail.
  anvil?.kill("SIGKILL");
}
