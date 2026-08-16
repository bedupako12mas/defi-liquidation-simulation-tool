import { publicClient, assertAllowedChain } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { resolveAaveAddresses } from "../src/loaders/aaveAddresses.js";
import { loadReserveConfigs } from "../src/loaders/aaveReserveConfig.js";
import { enrichPositions } from "../src/loaders/aaveUserEnrichment.js";
import { classifySymbolForShock } from "../src/routes/aaveShockClassification.js";
import { classifyFluidAssets } from "../src/routes/fluidShockClassification.js";
import { applyShock, SHOCK_PRESETS } from "../src/engine/shockModel.js";
import { healthFactor } from "../src/engine/healthFactor.js";
import { computeExpectedMaxLiquidatableDebt, estimateAaveLiquidationGas } from "../src/validation/aaveValidator.js";
import { loadFluidVaultConfigs } from "../src/loaders/fluidVaultConfig.js";
import { loadFluidPositions } from "../src/loaders/fluidPositions.js";
import { resolveFluidPrices } from "../src/loaders/fluidPriceResolution.js";
import { resolveFluidOverrideTarget, estimateFluidLiquidationGas, validateFluidLiquidation } from "../src/validation/fluidValidator.js";
import { redactError } from "../src/rpc/redact.js";
import type { LiquidationProfitabilityTable } from "../src/db/types.js";
import type { Insertable } from "kysely";
import type { AssetShockConfig } from "../src/engine/shockModel.js";
import type { PriceVector } from "../src/engine/types.js";

/**
 * #43: gas-vs-bonus liquidation profitability, real eth_estimateGas + real gas price,
 * compared against the real bonus a liquidator would actually receive. Reuses #30's
 * validator/state-override infrastructure (aaveValidator.ts/fluidValidator.ts), extended
 * with real gas-estimation calls this task added.
 *
 * REAL, CONFIRMED-LIVE DESIGN DECISION (not the original plan - caught mid-build, see
 * docs/decisions.md's #43 scoping entries): both protocols are tested under the SAME
 * "correlated" market-crash scenario, not Fluid's usual LST-depeg scenario. Pricing Aave's
 * profitability with shocked market prices while pricing Fluid's with real/unshocked prices
 * (the original plan, reasoning that Fluid's LST-depeg shock is an internal-accounting
 * phenomenon, not a literal price move) would have made the same magnitude label mean two
 * different real-world events per protocol - not a fair comparison. A correlated market
 * crash is confirmed (Thrilok's own guidance, docs/decisions.md) to be a literal, identical
 * real-world event for both protocols ("chainlink eth/usd hops pass through uncapped, so a
 * market crash hits fluid vaults exactly like aave") - so both sides price off the same
 * shockedPrices vector, computed by the same applyShock/classification mechanism, same
 * preset, same magnitude, genuinely same-conditions. This does NOT change what the
 * Validation tab tests (#30/#36 still checks Fluid's LST-depeg path specifically - a
 * correctness question, not a comparison one, a real, disclosed, different job).
 */
const PRESET_ID = "correlated" as const;
// Real, confirmed-live finding (this sync run): under a correlated shock, a position whose
// collateral and debt are both volatile/correlated assets (common for Fluid's ETH-family
// vaults) barely moves in HF terms no matter how deep the shock goes, since both legs move
// together - only an asymmetric pairing (e.g. stablecoin debt against volatile collateral)
// responds strongly. Widened past the validators' own 30-50% ladders so genuinely resistant
// but real positions still get a fair chance to show up as swept, not just "never liquidatable."
const MAGNITUDE_LADDER_PCT = [10, 15, 20, 25, 30, 40, 50, 65, 80];

const AAVE_SAMPLE_SIZE = Number(process.env.PROFITABILITY_AAVE_SAMPLE_SIZE ?? "40");
const AAVE_ENRICH_BATCH_SIZE = 8; // see sync-validation-results.ts's identical constant/comment
const FLUID_SAMPLE_SIZE = Number(process.env.PROFITABILITY_FLUID_SAMPLE_SIZE ?? "15");
const FLUID_VAULT_CHUNK_SIZE = Number(process.env.PROFITABILITY_FLUID_VAULT_CHUNK_SIZE ?? "3");

const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
const USD8 = 100_000_000n;

type Row = Insertable<LiquidationProfitabilityTable>;

/** gasUsed * gasPriceWei -> wei, then * ethUsd8 / 1e18 -> 8-decimal USD. All bigint. */
function gasCostUsd8(gasUsed: bigint, gasPriceWei: bigint, ethUsd8: bigint): bigint {
  return (gasUsed * gasPriceWei * ethUsd8) / 10n ** 18n;
}

async function syncAave(gasPriceWei: bigint): Promise<Row[]> {
  const candidates = await db.selectFrom("aave_borrow_candidates").select("address").limit(AAVE_SAMPLE_SIZE).execute();
  if (candidates.length === 0) {
    console.warn("[sync-profitability] no aave_borrow_candidates - skipping Aave.");
    return [];
  }

  const { dataProvider, pool, oracle } = await resolveAaveAddresses(publicClient);
  const reserveConfigs = await loadReserveConfigs(publicClient);
  let positions: Awaited<ReturnType<typeof enrichPositions>>["positions"] = [];
  try {
    ({ positions } = await enrichPositions(
      publicClient,
      dataProvider,
      candidates.map((c) => c.address),
      reserveConfigs,
      undefined,
      AAVE_ENRICH_BATCH_SIZE,
    ));
  } catch (err) {
    console.warn("[sync-profitability] aave: enrichPositions failed entirely:", redactError(err));
    return [];
  }

  const realPrices: PriceVector = Object.fromEntries(reserveConfigs.map((r) => [r.asset, r.priceUsd8]));
  const assetConfig: Record<string, AssetShockConfig> = Object.fromEntries(
    reserveConfigs.map((r) => [r.asset, classifySymbolForShock(r.symbol)]),
  );
  const configByAsset = new Map(reserveConfigs.map((r) => [r.asset.toLowerCase(), r]));
  const preset = SHOCK_PRESETS[PRESET_ID];

  const testable = positions.filter((p) => p.collateral.length > 0 && p.debt.length > 0);
  console.log(`[sync-profitability] aave: ${positions.length} positions loaded, sweeping ${testable.length} across the magnitude ladder.`);

  const rows: Row[] = [];
  for (const position of testable) {
    const collateralAsset = position.collateral[0]!.asset as `0x${string}`;
    const debtAsset = position.debt[0]!.asset as `0x${string}`;
    const collateralConfig = configByAsset.get(collateralAsset.toLowerCase());
    const debtConfig = configByAsset.get(debtAsset.toLowerCase());
    if (!collateralConfig || !debtConfig) continue;

    const base = { protocol: "aave" as const, position_id: position.id, preset_id: PRESET_ID };
    let recorded = false;

    for (const pct of MAGNITUDE_LADDER_PCT) {
      const shockedPrices = applyShock(realPrices, assetConfig, -pct / 100, preset);
      const hf = healthFactor(position, shockedPrices);
      if (hf === null || hf >= 1_000_000_000_000_000_000n) continue; // not liquidatable yet at this magnitude

      const expectedDebtRepaid = computeExpectedMaxLiquidatableDebt(
        position,
        shockedPrices,
        collateralAsset,
        debtAsset,
        collateralConfig.liquidationBonusRaw,
      );
      if (expectedDebtRepaid === null || expectedDebtRepaid === 0n) continue;

      let gasResult;
      try {
        gasResult = await estimateAaveLiquidationGas(publicClient, pool, {
          position,
          oracleOverridePrices: { [collateralAsset]: shockedPrices[collateralAsset]!, [debtAsset]: shockedPrices[debtAsset]! },
          collateralAsset,
          debtAsset,
          debtToCover: expectedDebtRepaid,
          oracle,
        });
      } catch (err) {
        rows.push({ ...base, magnitude_pct: String(-pct), gas_used: null, gas_cost_usd8: null, debt_cleared_usd8: null, bonus_value_usd8: null, net_profit_usd8: null, status: "unable-to-estimate-gas", detail: redactError(err) });
        recorded = true;
        break;
      }
      if (gasResult.status !== "estimated") {
        rows.push({ ...base, magnitude_pct: String(-pct), gas_used: null, gas_cost_usd8: null, debt_cleared_usd8: null, bonus_value_usd8: null, net_profit_usd8: null, status: "unable-to-estimate-gas", detail: gasResult.reason });
        recorded = true;
        break;
      }

      const debtDecimals = position.debt[0]!.decimals;
      const debtClearedUsd8 = (expectedDebtRepaid * shockedPrices[debtAsset]!) / 10n ** BigInt(debtDecimals);
      // Total collateral value the liquidator receives - liquidationBonusRaw is Aave's raw
      // multiplier (e.g. 10500n = 105%), so this is debt value scaled by the bonus directly,
      // not a separate premium-only figure. Analytical, not a second real call - the close-
      // factor/bonus formula it's built from is the same one verified exactly against real
      // liquidationCall() output this session (docs/decisions.md's #30 entry).
      const bonusValueUsd8 = (debtClearedUsd8 * collateralConfig.liquidationBonusRaw) / 10_000n;
      const gasCostUsd8Value = gasCostUsd8(gasResult.gasUsed, gasPriceWei, shockedPrices[WETH_ADDRESS] ?? realPrices[WETH_ADDRESS]!);
      const netProfitUsd8 = bonusValueUsd8 - debtClearedUsd8 - gasCostUsd8Value;

      rows.push({
        ...base,
        magnitude_pct: String(-pct),
        gas_used: gasResult.gasUsed,
        gas_cost_usd8: gasCostUsd8Value,
        debt_cleared_usd8: debtClearedUsd8,
        bonus_value_usd8: bonusValueUsd8,
        net_profit_usd8: netProfitUsd8,
        status: netProfitUsd8 > 0n ? "profitable" : "unprofitable",
        detail: null,
      });
      recorded = true;
      if (netProfitUsd8 > 0n) break; // found the real breakeven - stop deepening
    }

    if (!recorded) {
      rows.push({ ...base, magnitude_pct: String(-MAGNITUDE_LADDER_PCT[MAGNITUDE_LADDER_PCT.length - 1]!), gas_used: null, gas_cost_usd8: null, debt_cleared_usd8: null, bonus_value_usd8: null, net_profit_usd8: null, status: "unable-to-validate", detail: "never became liquidatable within the tested magnitude range" });
    }
  }
  return rows;
}

async function syncFluid(gasPriceWei: bigint, ethUsd8Real: bigint): Promise<Row[]> {
  const vaults = await loadFluidVaultConfigs(publicClient);
  const aaveReserves = await loadReserveConfigs(publicClient);
  const priceResolution = resolveFluidPrices(vaults, aaveReserves);
  const realPrices: PriceVector = Object.fromEntries([...priceResolution.pricesUsd8.entries()]);

  const allPositions: Awaited<ReturnType<typeof loadFluidPositions>>["positions"] = [];
  for (let i = 0; i < vaults.length; i += FLUID_VAULT_CHUNK_SIZE) {
    const chunk = vaults.slice(i, i + FLUID_VAULT_CHUNK_SIZE);
    try {
      const { positions } = await loadFluidPositions(publicClient, chunk, priceResolution);
      allPositions.push(...positions);
    } catch (err) {
      console.warn(`[sync-profitability] fluid: chunk ${i}-${i + chunk.length} failed to load, skipping:`, redactError(err));
    }
  }

  const assetConfig = classifyFluidAssets(
    allPositions.map((p) => p.position),
    aaveReserves,
  );
  const preset = SHOCK_PRESETS[PRESET_ID];
  const vaultByAddress = new Map(vaults.map((v) => [v.vault.toLowerCase(), v]));

  // "market" - see this file's top comment for why: the SAME real-world event as Aave's
  // "correlated" preset, not Fluid's usual LST-depeg scenario, so the comparison is fair.
  const supportedVaults = new Set<string>();
  for (const vault of vaults) {
    try {
      const resolution = await resolveFluidOverrideTarget(publicClient, vault.oracle, "market");
      if (resolution.status === "resolved") supportedVaults.add(vault.vault.toLowerCase());
    } catch {
      // treated the same as "not resolved"
    }
  }
  console.log(`[sync-profitability] fluid: ${supportedVaults.size} of ${vaults.length} real vaults have a supported market-price hop.`);

  const withHf = allPositions
    .map((p) => ({ ...p, hf: healthFactor(p.position, realPrices) }))
    .filter((x) => x.hf !== null)
    .sort((a, b) => {
      const aSupported = supportedVaults.has(a.vaultAddress.toLowerCase());
      const bSupported = supportedVaults.has(b.vaultAddress.toLowerCase());
      if (aSupported !== bSupported) return aSupported ? -1 : 1;
      return Number(a.hf! - b.hf!);
    })
    .slice(0, FLUID_SAMPLE_SIZE);

  console.log(`[sync-profitability] fluid: sweeping ${withHf.length} real positions closest to their real threshold (of ${allPositions.length} total).`);

  const rows: Row[] = [];
  for (const { position, vaultAddress, hf } of withHf) {
    const vault = vaultByAddress.get(vaultAddress.toLowerCase());
    if (!vault) continue;

    const resolution = await resolveFluidOverrideTarget(publicClient, vault.oracle, "market");
    const base = { protocol: "fluid" as const, position_id: position.id, preset_id: PRESET_ID };
    if (resolution.status !== "resolved") {
      rows.push({ ...base, magnitude_pct: "0", gas_used: null, gas_cost_usd8: null, debt_cleared_usd8: null, bonus_value_usd8: null, net_profit_usd8: null, status: "unable-to-validate", detail: resolution.reason });
      continue;
    }

    // The market hop's real current raw feed answer - overridden below to reflect the
    // SAME relative move applyShock computes for this vault's collateral asset (its real
    // classification, from classifyFluidAssets - so a stablecoin collateral moves like a
    // stablecoin, a volatile asset moves like one, matching Aave's own per-asset treatment
    // for the equivalent real symbol, not a flat percentage applied uniformly).
    const realRawAnswer = await publicClient.readContract({
      address: resolution.overrideAddress,
      abi: [{ type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] }],
      functionName: "latestRoundData",
    }).then((r) => r[1] as bigint).catch(() => null);
    if (realRawAnswer === null || realRawAnswer <= 0n) {
      rows.push({ ...base, magnitude_pct: "0", gas_used: null, gas_cost_usd8: null, debt_cleared_usd8: null, bonus_value_usd8: null, net_profit_usd8: null, status: "unable-to-validate", detail: "Could not read the real current market-hop feed answer" });
      continue;
    }

    const collateralAssetKey = position.collateral[0]!.asset.toLowerCase();
    const debtAssetKey = position.debt[0]!.asset.toLowerCase();

    let recorded = false;
    for (const pct of MAGNITUDE_LADDER_PCT) {
      const shockedPrices = applyShock(realPrices, assetConfig, -pct / 100, preset);
      const collateralRatio = realPrices[collateralAssetKey] ? (shockedPrices[collateralAssetKey]! * USD8) / realPrices[collateralAssetKey]! : USD8;
      const overrideValue = (realRawAnswer * collateralRatio) / USD8;

      let gasResult;
      try {
        gasResult = await estimateFluidLiquidationGas(publicClient, {
          vault: vault.vault,
          oracle: vault.oracle,
          borrowToken: vault.borrowToken,
          overrideValue,
          priceComponent: "market",
          debtAmt: vault.totalBorrowVault,
        });
      } catch (err) {
        rows.push({ ...base, magnitude_pct: String(-pct), gas_used: null, gas_cost_usd8: null, debt_cleared_usd8: null, bonus_value_usd8: null, net_profit_usd8: null, status: "unable-to-estimate-gas", detail: redactError(err) });
        recorded = true;
        break;
      }
      if (gasResult.status === "not-applicable") {
        rows.push({ ...base, magnitude_pct: "0", gas_used: null, gas_cost_usd8: null, debt_cleared_usd8: null, bonus_value_usd8: null, net_profit_usd8: null, status: "unable-to-validate", detail: gasResult.reason });
        recorded = true;
        break;
      }
      if (gasResult.status !== "estimated") {
        // Not yet liquidatable at this magnitude (or a real, transient RPC issue) - try deeper.
        continue;
      }

      // Real gas estimate succeeded, meaning the real (non-dry-run) call itself succeeded -
      // so vault.totalBorrowVault really was clearable at this magnitude. Get the REAL
      // actualColAmt via the existing dry-run validator (cheap: to_=dead reverts before any
      // token movement) rather than an analytical formula, since it's already available at
      // zero additional funding cost.
      const dryRun = await validateFluidLiquidation(publicClient, {
        vault: vault.vault,
        oracle: vault.oracle,
        overrideValue,
        priceComponent: "market",
        debtAmt: vault.totalBorrowVault,
      });
      if (dryRun.status !== "swept") {
        rows.push({ ...base, magnitude_pct: String(-pct), gas_used: gasResult.gasUsed, gas_cost_usd8: null, debt_cleared_usd8: null, bonus_value_usd8: null, net_profit_usd8: null, status: "unable-to-validate", detail: `gas estimate succeeded but the dry-run check disagreed: ${dryRun.status === "unexpected-revert" ? dryRun.rawError : dryRun.reason}` });
        recorded = true;
        break;
      }

      const debtClearedUsd8 = (dryRun.actualDebtAmt * (shockedPrices[debtAssetKey] ?? realPrices[debtAssetKey] ?? 0n)) / 10n ** BigInt(position.debt[0]!.decimals);
      const bonusValueUsd8 = (dryRun.actualColAmt * (shockedPrices[collateralAssetKey] ?? realPrices[collateralAssetKey] ?? 0n)) / 10n ** BigInt(position.collateral[0]!.decimals);
      const gasCostUsd8Value = gasCostUsd8(gasResult.gasUsed, gasPriceWei, shockedPrices[WETH_ADDRESS] ?? ethUsd8Real);
      const netProfitUsd8 = bonusValueUsd8 - debtClearedUsd8 - gasCostUsd8Value;

      rows.push({
        ...base,
        magnitude_pct: String(-pct),
        gas_used: gasResult.gasUsed,
        gas_cost_usd8: gasCostUsd8Value,
        debt_cleared_usd8: debtClearedUsd8,
        bonus_value_usd8: bonusValueUsd8,
        net_profit_usd8: netProfitUsd8,
        status: netProfitUsd8 > 0n ? "profitable" : "unprofitable",
        detail: null,
      });
      recorded = true;
      if (netProfitUsd8 > 0n) break;
    }

    if (!recorded) {
      rows.push({ ...base, magnitude_pct: String(-MAGNITUDE_LADDER_PCT[MAGNITUDE_LADDER_PCT.length - 1]!), gas_used: null, gas_cost_usd8: null, debt_cleared_usd8: null, bonus_value_usd8: null, net_profit_usd8: null, status: "unable-to-validate", detail: `no sweep within the tested range (HF=${(Number(hf) / 1e18).toFixed(4)})` });
    }
  }
  return rows;
}

async function main() {
  await assertAllowedChain();

  const gasPriceWei = await publicClient.getGasPrice();
  const reserveConfigsForEth = await loadReserveConfigs(publicClient);
  const ethUsd8Real = reserveConfigsForEth.find((r) => r.asset.toLowerCase() === WETH_ADDRESS.toLowerCase())?.priceUsd8 ?? 0n;
  console.log(`[sync-profitability] real gas price: ${gasPriceWei} wei, real ETH/USD: ${Number(ethUsd8Real) / 1e8}`);

  const aaveRows = await syncAave(gasPriceWei);
  const fluidRows = await syncFluid(gasPriceWei, ethUsd8Real);

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("liquidation_profitability").where("protocol", "=", "aave").execute();
    if (aaveRows.length > 0) await trx.insertInto("liquidation_profitability").values(aaveRows).execute();
    await trx.deleteFrom("liquidation_profitability").where("protocol", "=", "fluid").execute();
    if (fluidRows.length > 0) await trx.insertInto("liquidation_profitability").values(fluidRows).execute();
  });

  console.log(`[sync-profitability] wrote ${aaveRows.length} aave rows, ${fluidRows.length} fluid rows.`);
  await db.destroy();
}

main().catch(async (err) => {
  console.error(redactError(err));
  await db.destroy();
  process.exitCode = 1;
});
