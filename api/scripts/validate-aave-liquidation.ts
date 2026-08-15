import { publicClient, assertAllowedChain } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { resolveAaveAddresses } from "../src/loaders/aaveAddresses.js";
import { loadReserveConfigs } from "../src/loaders/aaveReserveConfig.js";
import { enrichPositions } from "../src/loaders/aaveUserEnrichment.js";
import { classifySymbolForShock } from "../src/routes/aaveShockClassification.js";
import { applyShock, SHOCK_PRESETS } from "../src/engine/shockModel.js";
import { healthFactor } from "../src/engine/healthFactor.js";
import { validateAaveLiquidation } from "../src/validation/aaveValidator.js";
import { redactError } from "../src/rpc/redact.js";
import type { AssetShockConfig } from "../src/engine/shockModel.js";
import type { PriceVector } from "../src/engine/types.js";

// Env-configurable, matching the sample-size convention already established in
// validate-aave.ts (the Level 1 / health-factor validator).
const SAMPLE_SIZE = Number(process.env.VALIDATION_SAMPLE_SIZE ?? "50");
// Negative fraction, e.g. -0.3 = -30%. Deliberately larger than a typical sweep step,
// since the point here is finding real positions the shock actually pushes underwater to
// validate against, not sweeping a full curve.
const SHOCK_MAGNITUDE = Number(process.env.VALIDATION_SHOCK_MAGNITUDE ?? "-0.3");
const PRESET_ID = (process.env.VALIDATION_PRESET_ID ?? "correlated") as keyof typeof SHOCK_PRESETS;

// KNOWN, DISCLOSED SCOPE LIMIT: only the position's first collateral leg and first debt
// leg get validated (not every leg combination) - keeps cost bounded for a manual
// verification run. A full multi-leg sweep is a natural future extension, not required for
// this tier to be real and useful.
//
// KNOWN, DISCLOSED LIMIT: block number isn't pinned end-to-end (enrichment/prices use
// "latest", the validator's own eth_call also uses "latest", not a shared explicit block) -
// unlike validate-aave.ts's HF check. In practice the whole run completes in seconds, so
// real drift risk is low, but this is a deliberate simplification, not an oversight -
// pinning it end-to-end would mean threading a blockNumber through validateAaveLiquidation
// itself, not done in this pass.
async function main() {
  await assertAllowedChain();

  const candidates = await db.selectFrom("aave_borrow_candidates").select("address").limit(SAMPLE_SIZE).execute();
  if (candidates.length === 0) {
    console.error("No candidates in aave_borrow_candidates - run `npm run index:aave` first.");
    process.exitCode = 1;
    await db.destroy();
    return;
  }

  const { dataProvider, pool, oracle } = await resolveAaveAddresses(publicClient);
  const reserveConfigs = await loadReserveConfigs(publicClient);
  const { positions } = await enrichPositions(publicClient, dataProvider, candidates.map((c) => c.address), reserveConfigs);

  const realPrices: PriceVector = Object.fromEntries(reserveConfigs.map((r) => [r.asset, r.priceUsd8]));
  const assetConfig: Record<string, AssetShockConfig> = Object.fromEntries(
    reserveConfigs.map((r) => [r.asset, classifySymbolForShock(r.symbol)]),
  );
  const configByAsset = new Map(reserveConfigs.map((r) => [r.asset.toLowerCase(), r]));

  const preset = SHOCK_PRESETS[PRESET_ID];
  const shockedPrices = applyShock(realPrices, assetConfig, SHOCK_MAGNITUDE, preset);

  const testable = positions.filter((p) => {
    if (p.collateral.length === 0 || p.debt.length === 0) return false;
    const hf = healthFactor(p, shockedPrices);
    return hf !== null && hf < 1_000_000_000_000_000_000n;
  });

  console.log(
    `${positions.length} real positions loaded, ${testable.length} become liquidatable under a ${(SHOCK_MAGNITUDE * 100).toFixed(0)}% "${preset.label}" shock.`,
  );

  let matched = 0;
  let mismatched = 0;
  let unableToValidate = 0;
  let unexpectedRevert = 0;

  for (const position of testable) {
    const collateralAsset = position.collateral[0]!.asset as `0x${string}`;
    const debtAsset = position.debt[0]!.asset as `0x${string}`;
    const collateralConfig = configByAsset.get(collateralAsset.toLowerCase());
    if (!collateralConfig) continue;

    // Real, confirmed-live bug fix (see sync-validation-results.ts's matching comment):
    // overriding only the collateral asset's oracle left the debt asset's REAL, unshocked
    // price in effect for the actual call under a preset that shocks both - silently
    // invalidating both the expected-value math and the HF prefilter for any position whose
    // two legs are different assets.
    const oracleOverridePrices: Record<string, bigint> = { [collateralAsset]: shockedPrices[collateralAsset]! };
    if (debtAsset.toLowerCase() !== collateralAsset.toLowerCase() && shockedPrices[debtAsset] !== undefined) {
      oracleOverridePrices[debtAsset] = shockedPrices[debtAsset]!;
    }

    const result = await validateAaveLiquidation(publicClient, pool, {
      position,
      shockedPrices,
      oracleOverridePrices,
      collateralAsset,
      debtAsset,
      collateralLiquidationBonusRaw: collateralConfig.liquidationBonusRaw,
      dataProvider,
      oracle,
    });

    switch (result.status) {
      case "liquidated":
        if (result.matchesExpectation) {
          matched++;
        } else {
          mismatched++;
          console.log(
            `  MISMATCH ${position.user}: expected=${result.expectedDebtRepaid} actual=${result.actualDebtRepaid}`,
          );
        }
        break;
      case "unable-to-validate":
        unableToValidate++;
        console.log(`  UNABLE   ${position.user}: ${result.reason}`);
        break;
      case "unexpected-revert":
        unexpectedRevert++;
        console.log(`  REVERT   ${position.user}: ${result.rawError}`);
        break;
      case "not-liquidatable":
        // Shouldn't happen given the pre-filter above, but not fatal if it does (a real
        // race between the health-factor filter and the validator's own independent check).
        console.log(`  (unexpected) not-liquidatable per validator despite pre-filter: ${position.user}`);
        break;
    }
  }

  console.log(`\nResults: ${matched} matched, ${mismatched} mismatched, ${unableToValidate} unable-to-validate, ${unexpectedRevert} unexpected-revert.`);

  await db.destroy();
  process.exitCode = mismatched > 0 || unexpectedRevert > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(redactError(err));
  process.exitCode = 1;
});
