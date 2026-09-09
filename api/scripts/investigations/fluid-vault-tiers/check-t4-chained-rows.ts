import { db } from "../../../src/db/client.js";

async function main() {
  const rows = await db.selectFrom("chained_liquidation_results").selectAll().where("protocol", "=", "fluid-t4").orderBy("id").execute();
  console.log(JSON.stringify(rows, null, 2));
  await db.destroy();
}
main().catch(console.error);
