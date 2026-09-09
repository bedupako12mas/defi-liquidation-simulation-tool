import { db } from "../../../src/db/client.js";

function usd(raw: string): string {
  return (Number(raw) / 1e8).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

async function main() {
  const rows = await db
    .selectFrom("fluid_t4_shock_results")
    .selectAll()
    .where("magnitude_pct", "=", "-80")
    .where("vault", "in", [
      "0x528CF7DBBff878e02e48E83De5097F8071af768D", // same-pool, shown $8,859,065.63/$7,917,457.62 at correlated -80
      "0x04F461756D3799Bfa05f1a367c41FaBa09743791", // two-pool, shown $4,748,218.49/$3,567,203.51 at stablecoin-depeg -80
      "0x304c57c9e27Fc79856762C712dd075FA6aECAbf2", // shown $0.0000/$0.0000 every preset
    ])
    .orderBy("vault")
    .orderBy("preset_id")
    .execute();
  for (const r of rows) {
    console.log(r.vault, r.preset_id, "col=$" + usd(r.vault_collateral_value_usd8), "debt=$" + usd(r.vault_debt_value_usd8));
  }
  await db.destroy();
}
main().catch(console.error);
