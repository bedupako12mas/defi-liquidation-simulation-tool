import { db } from "../../../src/db/client.js";

async function main() {
  const rows = await db
    .selectFrom("fluid_t4_shock_results")
    .selectAll()
    .where("preset_id", "=", "correlated")
    .where("magnitude_pct", "=", "0")
    .execute();
  console.log("vaults at baseline:", rows.length);
  for (const r of rows) {
    const samePool = r.collateral_dex.toLowerCase() === r.debt_dex.toLowerCase();
    console.log(
      r.vault,
      samePool ? "SAME" : "DIFF",
      "col=", r.vault_collateral_value_usd8,
      "debt=", r.vault_debt_value_usd8,
      "liquidatable=", r.liquidatable,
    );
  }

  const mockRows = await db
    .selectFrom("fluid_t4_shock_results")
    .selectAll()
    .where("vault", "=", "0x528CF7DBBff878e02e48E83De5097F8071af768D")
    .where("preset_id", "=", "correlated")
    .where("magnitude_pct", "in", ["0", "-50"])
    .execute();
  console.log("\nMOCK ROWS:", JSON.stringify(mockRows, null, 2));

  await db.destroy();
}
main().catch(console.error);
