import { db } from "../../../src/db/client.js";
import { publicClient } from "../../../src/rpc/client.js";

async function main() {
  const progress = await db.selectFrom("indexer_progress").selectAll().where("protocol", "=", "aave-v4").executeTakeFirst();
  const candidateCount = await db.selectFrom("aave_v4_borrow_candidates").select(db.fn.countAll().as("c")).executeTakeFirst();
  const snapshotCount = await db.selectFrom("snapshots").select(db.fn.countAll().as("c")).where("protocol", "=", "aave-v4").executeTakeFirst();
  const posCount = await db
    .selectFrom("positions")
    .innerJoin("snapshots", "snapshots.id", "positions.snapshot_id")
    .select(db.fn.countAll().as("c"))
    .where("snapshots.protocol", "=", "aave-v4")
    .executeTakeFirst();
  const finalized = (await publicClient.getBlock({ blockTag: "finalized" })).number;
  console.log("progress:", progress);
  console.log("candidateCount:", candidateCount);
  console.log("snapshotCount:", snapshotCount);
  console.log("posCount:", posCount);
  console.log("finalizedBlock:", finalized);
  await db.destroy();
}
main().catch(console.error);
