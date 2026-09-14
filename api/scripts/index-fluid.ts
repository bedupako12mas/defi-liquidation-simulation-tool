import { createRpcClient } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { runFluidIndexSync } from "../src/indexer/fluidIndexer.js";
import { redactError } from "../src/rpc/redact.js";

async function main() {
  const rpcUrl = process.env.RPC_URL_MAINNET;
  if (!rpcUrl) throw new Error("RPC_URL_MAINNET is not set");

  // See rpc/client.ts's own comment: getAllVaultPositions() returns enough data per vault
  // that the default multicall grouping (byte-size only, no gas awareness) blew a real
  // 550M-gas RPC limit bundling ~30 vaults into one eth_call. 4 vaults/batch keeps each
  // call comfortably under typical provider caps; overridable since the right value
  // depends on the real provider's own limit, not a fixed assumption (same reasoning as
  // AAVE_INDEXER_CHUNK_SIZE in index-aave.ts).
  const multicallBatchSize = process.env.FLUID_INDEXER_MULTICALL_BATCH_SIZE
    ? Number(process.env.FLUID_INDEXER_MULTICALL_BATCH_SIZE)
    : 0;
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
