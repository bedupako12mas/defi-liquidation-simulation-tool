import { db } from "../../../src/db/client.js";

async function main() {
  const rows = await db
    .selectFrom("fluid_t4_shock_results")
    .selectAll()
    .where("magnitude_pct", "=", "-80")
    .execute();
  const byVault = new Map<string, Record<string, string>>();
  for (const r of rows) {
    if (!byVault.has(r.vault)) byVault.set(r.vault, {});
    byVault.get(r.vault)![r.preset_id] = `${r.vault_collateral_value_usd8}/${r.vault_debt_value_usd8}`;
  }
  let anyDiverge = 0;
  for (const [vault, presets] of byVault) {
    const correlated = presets["correlated"];
    const stable = presets["stablecoin-depeg"];
    if (correlated !== stable) {
      anyDiverge++;
      console.log(vault, "correlated=", correlated, "stablecoin-depeg=", stable);
    }
  }
  console.log(`\n${anyDiverge} of ${byVault.size} vaults diverge between correlated and stablecoin-depeg at -80%`);
  await db.destroy();
}
main().catch(console.error);
