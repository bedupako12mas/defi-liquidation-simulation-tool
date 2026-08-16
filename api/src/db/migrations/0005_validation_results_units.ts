import type { Kysely } from "kysely";

// Real gap found by the user looking at the deployed Validation tab: expected/actual
// amounts were raw on-chain integers with no way to tell what they even were (a debt
// token's raw units? wei? dollars?). Adds the real asset symbol + decimals needed to
// decimal-adjust and label them properly, plus a real column for Fluid's seized-collateral
// amount (previously jammed into the free-text `detail` string as `actualColAmt=...`,
// itself unitless).
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("validation_results")
    .addColumn("debt_asset_symbol", "text")
    .addColumn("debt_asset_decimals", "integer")
    .addColumn("collateral_asset_symbol", "text")
    .addColumn("collateral_asset_decimals", "integer")
    .addColumn("actual_collateral_amount", "numeric")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("validation_results")
    .dropColumn("debt_asset_symbol")
    .dropColumn("debt_asset_decimals")
    .dropColumn("collateral_asset_symbol")
    .dropColumn("collateral_asset_decimals")
    .dropColumn("actual_collateral_amount")
    .execute();
}
