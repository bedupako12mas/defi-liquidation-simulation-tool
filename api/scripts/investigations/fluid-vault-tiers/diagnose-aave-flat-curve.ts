import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { db } from "../../../src/db/client.js";
import { resolveAaveAddresses } from "../../../src/loaders/aaveAddresses.js";
import { loadReserveConfigs } from "../../../src/loaders/aaveReserveConfig.js";
import { enrichPositions } from "../../../src/loaders/aaveUserEnrichment.js";
import { classifySymbolForShock } from "../../../src/routes/aaveShockClassification.js";

const PINNED_BLOCK = 25737723n; // same block /api/meta reports the stored Aave snapshot uses

async function main() {
  await assertAllowedChain();
  const candidates = await db.selectFrom("aave_borrow_candidates").select("address").execute();
  const { dataProvider } = await resolveAaveAddresses(publicClient);
  const reserveConfigs = await loadReserveConfigs(publicClient, PINNED_BLOCK);
  const symbolByAsset = new Map(reserveConfigs.map((r) => [r.asset.toLowerCase(), r.symbol]));
  const { positions } = await enrichPositions(publicClient, dataProvider, candidates.map((c) => c.address), reserveConfigs, PINNED_BLOCK, 8);

  for (const p of positions) {
    const colSymbols = p.collateral.map((c) => {
      const sym = symbolByAsset.get(c.asset.toLowerCase()) ?? "?";
      return `${sym}=raw:${c.amount}`;
    });
    const debtSymbols = p.debt.map((d) => {
      const sym = symbolByAsset.get(d.asset.toLowerCase()) ?? "?";
      return `${sym}=raw:${d.amount}`;
    });
    console.log(`${p.id}: collateral=[${colSymbols.join(", ")}] debt=[${debtSymbols.join(", ")}]`);
  }
  await db.destroy();
}
main().catch(console.error);
