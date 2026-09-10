import { db } from "../../../src/db/client.js";

async function main() {
  const row = await db.selectFrom("chained_liquidation_results").selectAll().where("protocol", "=", "aave-v4").orderBy("id", "desc").limit(1).executeTakeFirst();
  console.log(JSON.stringify(row, null, 2));
  await db.destroy();
}
main().catch(console.error);
