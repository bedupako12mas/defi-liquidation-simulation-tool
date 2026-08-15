import { publicClient, assertAllowedChain } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { resolveAaveAddresses } from "../src/loaders/aaveAddresses.js";
import { loadReserveConfigs } from "../src/loaders/aaveReserveConfig.js";
import { enrichPositions } from "../src/loaders/aaveUserEnrichment.js";
import { classifySymbolForShock } from "../src/routes/aaveShockClassification.js";
import { applyShock, SHOCK_PRESETS } from "../src/engine/shockModel.js";
import { healthFactor } from "../src/engine/healthFactor.js";
import { validateAaveLiquidation } from "../src/validation/aaveValidator.js";
import { loadFluidVaultConfigs } from "../src/loaders/fluidVaultConfig.js";
import { loadFluidPositions } from "../src/loaders/fluidPositions.js";
import { resolveFluidPrices } from "../src/loaders/fluidPriceResolution.js";
import { validateFluidLiquidation, resolveFluidOverrideTarget } from "../src/validation/fluidValidator.js";
import { redactError } from "../src/rpc/redact.js";
import type { ValidationResultsTable } from "../src/db/types.js";
import type { Insertable } from "kysely";
import type { AssetShockConfig } from "../src/engine/shockModel.js";
import type { PriceVector } from "../src/engine/types.js";

// Same real-eth_call validators #30 built (aaveValidator.ts / fluidValidator.ts),
// this time run against a bounded real sample and PERSISTED, not just logged - so the
// Validation tab (#36) can serve the latest results instantly instead of running slow,
// RPC-heavy live validation on every page load. Same "sync writes, route reads" pattern
// as syncAaveSnapshot.ts/syncFluidSnapshot.ts. Meant to run periodically (cron/manual),
// not on a request path.
const AAVE_SAMPLE_SIZE = Number(process.env.VALIDATION_SAMPLE_SIZE ?? "50");
const AAVE_SHOCK_MAGNITUDE = Number(process.env.VALIDATION_SHOCK_MAGNITUDE ?? "-0.3");
const AAVE_PRESET_ID = (process.env.VALIDATION_PRESET_ID ?? "correlated") as keyof typeof SHOCK_PRESETS;

const FLUID_SAMPLE_SIZE = Number(process.env.VALIDATION_FLUID_SAMPLE_SIZE ?? "20");
const FLUID_VAULT_CHUNK_SIZE = 10;
// Per position, tried in order, stopping at the first real sweep - matches
// validate-fluid-liquidation.ts's own finding that real positions need anywhere from a
// mild ~3% move to a much larger one before crossing their real threshold.
const FLUID_SHOCK_MAGNITUDES_PCT = [1, 3, 5, 10, 20, 30];

type Row = Insertable<ValidationResultsTable>;

async function syncAave(): Promise<Row[]> {
  const candidates = await db.selectFrom("aave_borrow_candidates").select("address").limit(AAVE_SAMPLE_SIZE).execute();
  if (candidates.length === 0) {
    console.warn("[sync-validation] no aave_borrow_candidates - run `npm run index:aave` first, skipping Aave.");
    return [];
  }

  const { dataProvider, pool, oracle } = await resolveAaveAddresses(publicClient);
  const reserveConfigs = await loadReserveConfigs(publicClient);
  const { positions } = await enrichPositions(publicClient, dataProvider, candidates.map((c) => c.address), reserveConfigs);

  const realPrices: PriceVector = Object.fromEntries(reserveConfigs.map((r) => [r.asset, r.priceUsd8]));
  const assetConfig: Record<string, AssetShockConfig> = Object.fromEntries(
    reserveConfigs.map((r) => [r.asset, classifySymbolForShock(r.symbol)]),
  );
  const configByAsset = new Map(reserveConfigs.map((r) => [r.asset.toLowerCase(), r]));

  const preset = SHOCK_PRESETS[AAVE_PRESET_ID];
  const shockedPrices = applyShock(realPrices, assetConfig, AAVE_SHOCK_MAGNITUDE, preset);
  const magnitudePct = (AAVE_SHOCK_MAGNITUDE * 100).toFixed(2);

  const testable = positions.filter((p) => {
    if (p.collateral.length === 0 || p.debt.length === 0) return false;
    const hf = healthFactor(p, shockedPrices);
    return hf !== null && hf < 1_000_000_000_000_000_000n;
  });

  console.log(`[sync-validation] aave: ${positions.length} loaded, ${testable.length} liquidatable under "${preset.label}" @ ${magnitudePct}%.`);

  const rows: Row[] = [];
  for (const position of testable) {
    const collateralAsset = position.collateral[0]!.asset as `0x${string}`;
    const debtAsset = position.debt[0]!.asset as `0x${string}`;
    const collateralConfig = configByAsset.get(collateralAsset.toLowerCase());
    if (!collateralConfig) continue;

    const result = await validateAaveLiquidation(publicClient, pool, {
      position,
      shockedPrices,
      oracleOverridePrices: { [collateralAsset]: shockedPrices[collateralAsset]! },
      collateralAsset,
      debtAsset,
      collateralLiquidationBonusRaw: collateralConfig.liquidationBonusRaw,
      dataProvider,
      oracle,
    });

    const base = { protocol: "aave" as const, position_id: position.id, preset_id: AAVE_PRESET_ID, magnitude_pct: magnitudePct };
    switch (result.status) {
      case "liquidated":
        rows.push({
          ...base,
          status: result.matchesExpectation ? "matched" : "mismatched",
          expected_amount: result.expectedDebtRepaid,
          actual_amount: result.actualDebtRepaid,
          detail: null,
        });
        break;
      case "unable-to-validate":
        rows.push({ ...base, status: "unable-to-validate", expected_amount: null, actual_amount: null, detail: result.reason });
        break;
      case "unexpected-revert":
        rows.push({ ...base, status: "unexpected-revert", expected_amount: null, actual_amount: null, detail: result.rawError });
        break;
      case "not-liquidatable":
        break; // shouldn't happen given the pre-filter; not an interesting row either way
    }
  }
  return rows;
}

async function syncFluid(): Promise<Row[]> {
  const vaults = await loadFluidVaultConfigs(publicClient);
  const aaveReserves = await loadReserveConfigs(publicClient);
  const priceResolution = resolveFluidPrices(vaults, aaveReserves);

  const allPositions: Awaited<ReturnType<typeof loadFluidPositions>>["positions"] = [];
  for (let i = 0; i < vaults.length; i += FLUID_VAULT_CHUNK_SIZE) {
    const chunk = vaults.slice(i, i + FLUID_VAULT_CHUNK_SIZE);
    const { positions } = await loadFluidPositions(publicClient, chunk, priceResolution);
    allPositions.push(...positions);
  }

  const prices: PriceVector = Object.fromEntries(priceResolution.pricesUsd8);
  const vaultByAddress = new Map(vaults.map((v) => [v.vault.toLowerCase(), v]));

  const withHf = allPositions
    .map((p) => ({ ...p, hf: healthFactor(p.position, prices) }))
    .filter((x) => x.hf !== null)
    .sort((a, b) => Number(a.hf! - b.hf!))
    .slice(0, FLUID_SAMPLE_SIZE);

  console.log(`[sync-validation] fluid: testing ${withHf.length} real positions closest to their real threshold (of ${allPositions.length} total).`);

  const rows: Row[] = [];
  for (const { position, vaultAddress, hf } of withHf) {
    const vault = vaultByAddress.get(vaultAddress.toLowerCase());
    if (!vault) continue;

    const resolution = await resolveFluidOverrideTarget(publicClient, vault.oracle, "internal-exchange-rate");
    const base = { protocol: "fluid" as const, position_id: position.id, preset_id: "lst-depeg" };
    if (resolution.status === "not-applicable") {
      rows.push({ ...base, magnitude_pct: "0", status: "not-applicable", expected_amount: null, actual_amount: null, detail: resolution.reason });
      continue;
    }
    if (resolution.status === "unable-to-validate") {
      rows.push({ ...base, magnitude_pct: "0", status: "unable-to-validate", expected_amount: null, actual_amount: null, detail: resolution.reason });
      continue;
    }

    let recorded = false;
    for (const pct of FLUID_SHOCK_MAGNITUDES_PCT) {
      const realRate = await publicClient.readContract({
        address: resolution.overrideAddress,
        abi: [{ type: "function", name: "getExchangeRateLiquidate", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "getExchangeRateLiquidate",
      });
      const shockedRate = (realRate * BigInt(100 - pct)) / 100n;

      const result = await validateFluidLiquidation(publicClient, {
        vault: vault.vault,
        oracle: vault.oracle,
        overrideValue: shockedRate,
        priceComponent: "internal-exchange-rate",
        debtAmt: vault.totalBorrowVault,
      });

      if (result.status === "swept") {
        rows.push({
          ...base,
          magnitude_pct: String(-pct),
          status: "swept",
          expected_amount: null,
          actual_amount: result.actualDebtAmt,
          detail: `actualColAmt=${result.actualColAmt}`,
        });
        recorded = true;
        break;
      }
      if (result.status === "unexpected-revert" && pct === FLUID_SHOCK_MAGNITUDES_PCT[FLUID_SHOCK_MAGNITUDES_PCT.length - 1]) {
        rows.push({ ...base, magnitude_pct: String(-pct), status: "unexpected-revert", expected_amount: null, actual_amount: null, detail: result.rawError });
        recorded = true;
      }
    }
    if (!recorded) {
      rows.push({
        ...base,
        magnitude_pct: String(-FLUID_SHOCK_MAGNITUDES_PCT[FLUID_SHOCK_MAGNITUDES_PCT.length - 1]!),
        status: "unable-to-validate",
        expected_amount: null,
        actual_amount: null,
        detail: `No sweep within -${FLUID_SHOCK_MAGNITUDES_PCT[FLUID_SHOCK_MAGNITUDES_PCT.length - 1]}% (HF=${(Number(hf) / 1e18).toFixed(4)})`,
      });
    }
  }
  return rows;
}

async function main() {
  await assertAllowedChain();

  const [aaveRows, fluidRows] = [await syncAave(), await syncFluid()];

  // Full replace per protocol, not an append-only log - this table represents "latest
  // known validation status", same intent as a snapshot, without needing a separate
  // run-id column to distinguish old rows from new ones.
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("validation_results").where("protocol", "=", "aave").execute();
    if (aaveRows.length > 0) await trx.insertInto("validation_results").values(aaveRows).execute();

    await trx.deleteFrom("validation_results").where("protocol", "=", "fluid").execute();
    if (fluidRows.length > 0) await trx.insertInto("validation_results").values(fluidRows).execute();
  });

  console.log(`[sync-validation] wrote ${aaveRows.length} aave rows, ${fluidRows.length} fluid rows.`);
  await db.destroy();
}

main().catch(async (err) => {
  console.error(redactError(err));
  await db.destroy();
  process.exitCode = 1;
});
