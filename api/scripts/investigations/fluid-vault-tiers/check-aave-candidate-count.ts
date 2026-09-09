import { db } from "../../../src/db/client.js";

async function main() {
  const count = await db.selectFrom("aave_borrow_candidates").select(({ fn }) => fn.count<number>("address").as("c")).executeTakeFirst();
  console.log("total aave_borrow_candidates:", count?.c);
  const indexerProgress = await db.selectFrom("indexer_progress").selectAll().execute();
  console.log("indexer_progress:", JSON.stringify(indexerProgress, null, 2));
  await db.destroy();
}
main().catch(console.error);
