import { db } from "../../../src/db/client.js";

async function main() {
  const snapshot = await db.selectFrom("snapshots").selectAll().where("protocol", "=", "aave-v4").orderBy("id", "desc").limit(1).executeTakeFirst();
  console.log("latest aave-v4 snapshot:", snapshot);
  await db.destroy();
}
main().catch(console.error);
