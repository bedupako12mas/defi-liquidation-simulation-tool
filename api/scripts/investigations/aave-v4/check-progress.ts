import { db } from "../../../src/db/client.js";

async function main() {
  const count = await db.selectFrom("aave_v4_borrow_candidates").select(({ fn }) => fn.count<number>("address").as("c")).executeTakeFirst();
  const progress = await db.selectFrom("indexer_progress").selectAll().where("protocol", "=", "aave-v4").executeTakeFirst();
  console.log("aave_v4_borrow_candidates:", count?.c);
  console.log("indexer_progress:", progress);
  await db.destroy();
}
main().catch(console.error);
