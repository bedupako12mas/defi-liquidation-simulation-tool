import { publicClient, assertAllowedChain } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { runFluidIndexSync } from "../src/indexer/fluidIndexer.js";
import { redactError } from "../src/rpc/redact.js";

async function main() {
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
