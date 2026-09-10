import { db } from "../../../src/db/client.js";
import { publicClient } from "../../../src/rpc/client.js";

async function main() {
  const earliest = await db
    .selectFrom("aave_v4_borrow_candidates")
    .select("discovered_at_block")
    .orderBy("discovered_at_block", "asc")
    .limit(1)
    .executeTakeFirstOrThrow();
  const finalized = (await publicClient.getBlock({ blockTag: "finalized" })).number;
  const earliestBlockInfo = await publicClient.getBlock({ blockNumber: BigInt(earliest.discovered_at_block) });
  const finalizedBlockInfo = await publicClient.getBlock({ blockNumber: finalized });

  console.log("earliest discovered_at_block:", earliest.discovered_at_block, "->", new Date(Number(earliestBlockInfo.timestamp) * 1000).toISOString());
  console.log("finalized block now:", finalized.toString(), "->", new Date(Number(finalizedBlockInfo.timestamp) * 1000).toISOString());
  console.log("real coverage window (days):", ((Number(finalizedBlockInfo.timestamp) - Number(earliestBlockInfo.timestamp)) / 86400).toFixed(1));

  const candidateCount = await db.selectFrom("aave_v4_borrow_candidates").select(db.fn.countAll().as("c")).executeTakeFirst();
  console.log("total real candidates discovered so far:", candidateCount?.c);

  await db.destroy();
}
main().catch(console.error);
