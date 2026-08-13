import { publicClient, assertAllowedChain } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { runFluidIndexSync } from "../src/indexer/fluidIndexer.js";

async function main() {
  await assertAllowedChain();

  const result = await runFluidIndexSync(publicClient, db);
  console.log(JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));

  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
