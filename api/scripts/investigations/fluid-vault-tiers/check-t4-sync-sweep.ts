import { db } from "../../../src/db/client.js";

async function main() {
  const total = await db.selectFrom("fluid_t4_shock_results").select(({ fn }) => fn.count<number>("id").as("c")).executeTakeFirst();
  const liquidatable = await db
    .selectFrom("fluid_t4_shock_results")
    .select(({ fn }) => fn.count<number>("id").as("c"))
    .where("liquidatable", "=", true)
    .executeTakeFirst();
  console.log("total rows:", total?.c, "liquidatable rows:", liquidatable?.c);

  const severe = await db
    .selectFrom("fluid_t4_shock_results")
    .selectAll()
    .where("preset_id", "=", "severe-depeg")
    .where("magnitude_pct", "=", "-80")
    .execute();
  console.log("\nseverse-depeg @ -80%:");
  for (const r of severe) {
    console.log(r.vault, "col=", r.vault_collateral_value_usd8, "debt=", r.vault_debt_value_usd8, "liquidatable=", r.liquidatable);
  }
  await db.destroy();
}
main().catch(console.error);
