import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";

async function main() {
  await assertAllowedChain();
  const finalized = await publicClient.getBlock({ blockTag: "finalized" });
  const lastIndexed = 25737723n;
  console.log("finalized block:", finalized.number);
  console.log("last indexed:   ", lastIndexed);
  console.log("gap (blocks):   ", finalized.number - lastIndexed);
  console.log("gap (~days, 7200 blocks/day):", Number(finalized.number - lastIndexed) / 7200);
}
main().catch(console.error);
