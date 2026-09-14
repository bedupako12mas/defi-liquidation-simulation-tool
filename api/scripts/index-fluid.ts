import { createRpcClient } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { runFluidIndexSync } from "../src/indexer/fluidIndexer.js";
import { redactError } from "../src/rpc/redact.js";

async function main() {
  // Type-narrowing only, not the real guard - importing createRpcClient already runs
  // client.ts's own top-level RPC_URL_MAINNET check as an ES-module import side effect,
  // before this line ever executes. Kept because createRpcClient(rpcUrl: string, ...)
  // needs rpcUrl narrowed from string | undefined; if client.ts's own check is ever made
  // lazy, this stops being redundant and starts being load-bearing.
  const rpcUrl = process.env.RPC_URL_MAINNET;
  if (!rpcUrl) throw new Error("RPC_URL_MAINNET is not set");

  // See rpc/client.ts's own comment: getAllVaultPositions() returns enough data per vault
  // that the default multicall grouping (byte-size only, no gas awareness) blew a real
  // 550M-gas RPC limit bundling ~30 vaults into one eth_call. Default (env var unset) is
  // 0 - multicall fully disabled, one eth_call per vault, no batching at all - not a
  // partial batch size; overridable since the right non-zero value (if any) depends on
  // the real provider's own gas cap, not a fixed assumption (same reasoning as
  // AAVE_INDEXER_CHUNK_SIZE in index-aave.ts). Validated eagerly rather than passed
  // through: an invalid value here must fail loud, not silently coerce to NaN and fall
  // through createRpcClient's own checks back to the unbounded default this exists to
  // prevent.
  const rawBatchSize = process.env.FLUID_INDEXER_MULTICALL_BATCH_SIZE;
  let multicallBatchSize = 0;
  if (rawBatchSize !== undefined) {
    multicallBatchSize = Number(rawBatchSize);
    if (!Number.isFinite(multicallBatchSize) || multicallBatchSize < 0) {
      throw new Error(
        `FLUID_INDEXER_MULTICALL_BATCH_SIZE must be a non-negative number, got "${rawBatchSize}".`,
      );
    }
  }
  const { publicClient, assertAllowedChain } = createRpcClient(rpcUrl, { multicallBatchSize });

  await assertAllowedChain();

  const result = await runFluidIndexSync(publicClient, db);
  console.log(JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));

  await db.destroy();
}

main().catch((err) => {
  // See redact.ts - a raw console.error(err) here can print the RPC_URL_MAINNET/
  // DATABASE_URL credential embedded in a viem/pg error's own message.
  console.error(redactError(err));
  process.exitCode = 1;
});
