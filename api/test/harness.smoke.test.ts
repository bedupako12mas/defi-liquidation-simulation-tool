import { describe, it, expect } from "vitest";
import { createRpcClient } from "../src/rpc/client.js";

/**
 * Verifies the pinned anvil-fork harness itself (globalSetup.ts) works, independent of
 * any loader logic - the loader doesn't exist yet, so there's nothing else to exercise
 * this fork with yet.
 */
describe("pinned anvil-fork harness", () => {
  it("forks mainnet at the pinned block and is reachable", async () => {
    const anvilRpcUrl = process.env.ANVIL_RPC_URL;
    expect(anvilRpcUrl).toBeDefined();

    const { publicClient, assertAllowedChain } = createRpcClient(anvilRpcUrl!);

    await assertAllowedChain();

    const expectedBlock = BigInt(process.env.ANVIL_FORK_BLOCK_NUMBER ?? "21000000");
    const blockNumber = await publicClient.getBlockNumber();
    expect(blockNumber).toBe(expectedBlock);
  });
});
