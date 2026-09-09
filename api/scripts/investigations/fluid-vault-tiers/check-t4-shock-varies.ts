import { db } from "../../../src/db/client.js";

async function main() {
  const rows = await db
    .selectFrom("fluid_t4_shock_results")
    .selectAll()
    .where("vault", "=", "0x528CF7DBBff878e02e48E83De5097F8071af768D")
    .where("preset_id", "in", ["correlated", "stablecoin-depeg", "severe-depeg"])
    .orderBy("preset_id")
    .orderBy("magnitude_pct")
    .execute();
  for (const r of rows) {
    if (["0", "-30", "-80"].includes(r.magnitude_pct)) {
      console.log(r.preset_id, r.magnitude_pct, "col=", r.vault_collateral_value_usd8, "debt=", r.vault_debt_value_usd8);
    }
  }
  await db.destroy();
}
main().catch(console.error);
