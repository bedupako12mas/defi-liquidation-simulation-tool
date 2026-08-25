// Live smoke test of the new oracle-override valuation approach against a real T2 vault's
// real reserves. Prices are illustrative/fixed (not re-fetched live) since the logic under
// test is the repricing + valuation math (applyShock + assetValueUsd8), not price discovery,
// which is already proven elsewhere in this codebase.
import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { detectSmartLegs } from "../../../src/loaders/fluidSmartLeg.js";
import { loadDexCollateralReserves } from "../../../src/loaders/fluidDexPoolState.js";
import { computeSmartLegValueUsd8 } from "../../../src/loaders/fluidSmartLegValuation.js";
import { SHOCK_PRESETS } from "../../../src/engine/shockModel.js";

const T2_VAULT = "0x5eb4ba0c320b59f825cc8d2291f672247aa5d06f" as const; // WBTC-cbBTC

async function main() {
  await assertAllowedChain();
  const legs = await detectSmartLegs(publicClient, T2_VAULT);
  if (!legs.collateralDex) throw new Error("expected smart collateral");
  const reserves = await loadDexCollateralReserves(publicClient, legs.collateralDex);
  console.log("Real reserves:", reserves);

  // Illustrative prices (~$100k/BTC-equivalent for both legs, both 8-decimal tokens).
  const basePrices = {
    [reserves.token0]: 100_000_00000000n, // $100,000 at 8-decimal USD convention
    [reserves.token1]: 100_000_00000000n,
  };
  const assetConfig = {
    [reserves.token0]: { beta: 1.0, subjectToDepeg: true, subjectToStablecoinDepeg: false }, // pretend token0 is the LST-like leg
    [reserves.token1]: { beta: 1.0, subjectToDepeg: false, subjectToStablecoinDepeg: false },
  };

  for (const presetId of ["correlated", "mild-depeg", "severe-depeg"] as const) {
    const preset = SHOCK_PRESETS[presetId];
    const value = computeSmartLegValueUsd8(reserves, 8, 8, basePrices, assetConfig, -0.1, preset);
    console.log(`${presetId} @ -10% magnitude: valueUsd8=${value} ($${Number(value) / 1e8})`);
  }

  const baseValue = computeSmartLegValueUsd8(reserves, 8, 8, basePrices, assetConfig, 0, SHOCK_PRESETS.correlated);
  console.log(`\nUnshocked baseline: valueUsd8=${baseValue} ($${Number(baseValue) / 1e8})`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
