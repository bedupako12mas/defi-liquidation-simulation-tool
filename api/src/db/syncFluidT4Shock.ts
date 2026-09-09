import { parseAbi } from "viem";
import { publicClient, assertAllowedChain } from "../rpc/client.js";
import { db } from "./client.js";
import { redactError } from "../rpc/redact.js";
import { FLUID_VAULT_RESOLVER } from "../loaders/fluidAddresses.js";
import { detectSmartLegs } from "../loaders/fluidSmartLeg.js";
import {
  loadDexCollateralReserves,
  loadDexDebtReserves,
  loadVaultSupplyShareFraction,
  loadVaultBorrowShareFraction,
} from "../loaders/fluidDexPoolState.js";
import { computeSmartLegValueUsd8 } from "../loaders/fluidSmartLegValuation.js";
import { SHOCK_PRESETS, sweepMagnitudes } from "../engine/shockModel.js";
import { loadReserveConfigs } from "../loaders/aaveReserveConfig.js";
import { FLUID_NATIVE_ETH_SENTINEL, AAVE_WETH_ADDRESS, resolveFluidPrices } from "../loaders/fluidPriceResolution.js";
import { loadFluidVaultConfigs } from "../loaders/fluidVaultConfig.js";
import { classifySymbolForShock } from "../routes/aaveShockClassification.js";
import type { PriceVector } from "../engine/types.js";

// Lives under src/, not scripts/ - same deployability reasoning as syncFluidT2Shock.ts's top
// comment.
//
// Deploy 5/6 (Fluid T4 - RPC tier). T4 -> smart collateral AND smart debt. Confirmed live
// this session (docs/decisions.md's 2026-09-03 T4 entries) that this needs NO new valuation
// architecture: every real T4 vault is either one pool serving both legs (13/26) or two
// separate pools (13/26), but in both cases collateralDex and debtDex are looked up and
// valued completely independently - T2's collateral-leg math (loadDexCollateralReserves +
// loadVaultSupplyShareFraction) and T3's debt-leg math (loadDexDebtReserves +
// loadVaultBorrowShareFraction) reused unchanged, run side by side. A same-pool vault simply
// has collateralDex === debtDex and two independent share fractions (supply vs borrow) into
// that one pool - not a special case requiring different code.
const TOKEN_ABI = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

const RESOLVER_ABI = parseAbi([
  "function getAllVaultsAddresses() view returns (address[])",
  "function getVaultType(address) view returns (uint256)",
]);

// getVaultEntireData - the real, public, type-aware entry point (works across T1-T4, same as
// T2/T3's sync). Full struct chain required for correct ABI decoding - a partial struct
// silently decodes wrong, not an error (see syncFluidT2Shock.ts's comment on this same ABI).
const VAULT_ENTIRE_DATA_ABI = parseAbi([
  "struct Tokens { address token0; address token1; }",
  "struct ConstantViews2 { address liquidity; address factory; address operateImplementation; address adminImplementation; address secondaryImplementation; address deployer; address supply; address borrow; Tokens supplyToken; Tokens borrowToken; uint256 vaultId; uint256 vaultType; bytes32 supplyExchangePriceSlot; bytes32 borrowExchangePriceSlot; bytes32 userSupplySlot; bytes32 userBorrowSlot; }",
  "struct Configs { uint16 supplyRateMagnifier; uint16 borrowRateMagnifier; uint16 collateralFactor; uint16 liquidationThreshold; uint16 liquidationMaxLimit; uint16 withdrawalGap; uint16 liquidationPenalty; uint16 borrowFee; address oracle; uint256 oraclePriceOperate; uint256 oraclePriceLiquidate; address rebalancer; uint256 lastUpdateTimestamp; }",
  "struct ExchangePricesAndRates { uint256 lastStoredLiquiditySupplyExchangePrice; uint256 lastStoredLiquidityBorrowExchangePrice; uint256 lastStoredVaultSupplyExchangePrice; uint256 lastStoredVaultBorrowExchangePrice; uint256 liquiditySupplyExchangePrice; uint256 liquidityBorrowExchangePrice; uint256 vaultSupplyExchangePrice; uint256 vaultBorrowExchangePrice; uint256 supplyRateLiquidity; uint256 borrowRateLiquidity; int256 supplyRateVault; int256 borrowRateVault; int256 rewardsOrFeeRateSupply; int256 rewardsOrFeeRateBorrow; }",
  "struct TotalSupplyAndBorrow { uint256 totalSupplyVault; uint256 totalBorrowVault; uint256 totalSupplyLiquidityOrDex; uint256 totalBorrowLiquidityOrDex; uint256 absorbedSupply; uint256 absorbedBorrow; }",
  "struct LimitsAndAvailability { uint256 withdrawLimit; uint256 withdrawableUntilLimit; uint256 withdrawable; uint256 borrowLimit; uint256 borrowableUntilLimit; uint256 borrowable; uint256 borrowLimitUtilization; uint256 minimumBorrowing; }",
  "struct CurrentBranchState { uint256 status; int256 minimaTick; uint256 debtFactor; uint256 partials; uint256 debtLiquidity; uint256 baseBranchId; int256 baseBranchMinima; }",
  "struct VaultState2 { uint256 totalPositions; int256 topTick; uint256 currentBranch; uint256 totalBranch; uint256 totalBorrow; uint256 totalSupply; CurrentBranchState currentBranchState; }",
  "struct UserSupplyData { bool modeWithInterest; uint256 supply; uint256 withdrawalLimit; uint256 lastUpdateTimestamp; uint256 expandPercent; uint256 expandDuration; uint256 baseWithdrawalLimit; uint256 withdrawableUntilLimit; uint256 withdrawable; uint256 decayEndTimestamp; uint256 decayAmount; }",
  "struct UserBorrowData { bool modeWithInterest; uint256 borrow; uint256 borrowLimit; uint256 lastUpdateTimestamp; uint256 expandPercent; uint256 expandDuration; uint256 baseBorrowLimit; uint256 maxBorrowLimit; uint256 borrowableUntilLimit; uint256 borrowable; uint256 borrowLimitUtilization; }",
  "struct VaultEntireData { address vault; bool isSmartCol; bool isSmartDebt; ConstantViews2 constantVariables; Configs configs; ExchangePricesAndRates exchangePricesAndRates; TotalSupplyAndBorrow totalSupplyAndBorrow; LimitsAndAvailability limitsAndAvailability; VaultState2 vaultState; UserSupplyData liquidityUserSupplyData; UserBorrowData liquidityUserBorrowData; }",
  "function getVaultEntireData(address vault) view returns (VaultEntireData)",
]);

// Cached per vault (visited once per sync run anyway) - both share amounts come from the same
// getVaultEntireData call, unlike T2/T3 which each only needed one side.
const vaultEntireDataCache = new Map<string, { liquidationThresholdBps: number; ownSupplyShares: bigint; ownBorrowShares: bigint }>();
async function getVaultEntireDataCached(
  vault: `0x${string}`,
): Promise<{ liquidationThresholdBps: number; ownSupplyShares: bigint; ownBorrowShares: bigint }> {
  const key = vault.toLowerCase();
  const cached = vaultEntireDataCache.get(key);
  if (cached !== undefined) return cached;
  const data = await publicClient.readContract({
    address: FLUID_VAULT_RESOLVER,
    abi: VAULT_ENTIRE_DATA_ABI,
    functionName: "getVaultEntireData",
    args: [vault],
  });
  const result = {
    liquidationThresholdBps: data.configs.liquidationThreshold,
    ownSupplyShares: data.totalSupplyAndBorrow.totalSupplyVault,
    ownBorrowShares: data.totalSupplyAndBorrow.totalBorrowVault,
  };
  vaultEntireDataCache.set(key, result);
  return result;
}

const decimalsCache = new Map<string, number>();
async function getDecimals(address: `0x${string}`): Promise<number> {
  const key = address.toLowerCase();
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;
  if (key === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
    decimalsCache.set(key, 18);
    return 18;
  }
  const decimals = await publicClient.readContract({ address, abi: TOKEN_ABI, functionName: "decimals" });
  decimalsCache.set(key, decimals);
  return decimals;
}

const symbolCache = new Map<string, string>();
async function getSymbol(address: `0x${string}`): Promise<string> {
  const key = address.toLowerCase();
  const cached = symbolCache.get(key);
  if (cached !== undefined) return cached;
  if (key === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
    symbolCache.set(key, "WETH");
    return "WETH";
  }
  const symbol = await publicClient.readContract({ address, abi: TOKEN_ABI, functionName: "symbol" });
  symbolCache.set(key, symbol);
  return symbol;
}

// Same imaginary-reserve cross-derivation T2/T3 already use (see syncFluidT2Shock.ts's
// comment for the real decimals-normalization bug this fixes) - needed independently for
// each pool's own token pair, since a same-pool T4 vault still only has ONE pool's reserves
// to derive from, and a two-pool vault genuinely has two independent pairs.
function deriveMissingPairPrice(
  token0Price: bigint | undefined,
  token1Price: bigint | undefined,
  token0ImaginaryReserves: bigint,
  token1ImaginaryReserves: bigint,
  token0Decimals: number,
  token1Decimals: number,
): { token0Price: bigint | undefined; token1Price: bigint | undefined } {
  if (token0Price === undefined && token1Price !== undefined && token0ImaginaryReserves > 0n) {
    token0Price =
      (token1Price * token1ImaginaryReserves * 10n ** BigInt(token0Decimals)) /
      (token0ImaginaryReserves * 10n ** BigInt(token1Decimals));
  } else if (token1Price === undefined && token0Price !== undefined && token1ImaginaryReserves > 0n) {
    token1Price =
      (token0Price * token0ImaginaryReserves * 10n ** BigInt(token1Decimals)) /
      (token1ImaginaryReserves * 10n ** BigInt(token0Decimals));
  }
  return { token0Price, token1Price };
}

interface FluidT4ShockRow {
  vault: string;
  collateral_dex: string;
  col_token0: string;
  col_token1: string;
  col_token0_decimals: number;
  col_token1_decimals: number;
  debt_dex: string;
  debt_token0: string;
  debt_token1: string;
  debt_token0_decimals: number;
  debt_token1_decimals: number;
  preset_id: string;
  magnitude_pct: string;
  col_pool_value_usd8: string;
  col_pool_value_usd8_baseline: string;
  debt_pool_value_usd8: string;
  debt_pool_value_usd8_baseline: string;
  vault_collateral_value_usd8: string;
  vault_debt_value_usd8: string;
  liquidatable: boolean;
}

export async function runFluidT4ShockSync(): Promise<{ rowCount: number; vaultCount: number; skipped: number }> {
  const allVaults = await publicClient.readContract({
    address: FLUID_VAULT_RESOLVER,
    abi: RESOLVER_ABI,
    functionName: "getAllVaultsAddresses",
  });

  const t4Vaults: `0x${string}`[] = [];
  for (const vault of allVaults) {
    const type = await publicClient.readContract({
      address: FLUID_VAULT_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: "getVaultType",
      args: [vault],
    });
    if (Number(type) === 40000) t4Vaults.push(vault);
  }
  console.log(`[sync-fluid-t4-shock] found ${t4Vaults.length} real T4 vaults`);

  const aaveReserves = await loadReserveConfigs(publicClient, await publicClient.getBlockNumber());
  const aavePricesByAddress = new Map(aaveReserves.map((r) => [r.asset.toLowerCase(), r.priceUsd8]));

  // Same T1-graph fallback T3 needed for its exotic Fluid-native tokens (wstUSR, reUSD, PST,
  // sUSDai) - T4's pool tokens draw from the same real token universe, so the same gap
  // plausibly applies here too, not re-derived from scratch.
  const t1Vaults = await loadFluidVaultConfigs(publicClient);
  const fluidGraphPrices = resolveFluidPrices(t1Vaults, aaveReserves).pricesUsd8;

  function lookupPrice(token: `0x${string}`): bigint | undefined {
    const key = token.toLowerCase();
    const aaveKey = key === FLUID_NATIVE_ETH_SENTINEL ? AAVE_WETH_ADDRESS : key;
    return aavePricesByAddress.get(aaveKey) ?? fluidGraphPrices.get(aaveKey);
  }

  const rows: FluidT4ShockRow[] = [];
  let skipped = 0;

  for (const vault of t4Vaults) {
    try {
      const legs = await detectSmartLegs(publicClient, vault);
      if (!legs.collateralDex || !legs.debtDex) {
        skipped++;
        continue;
      }

      const [colReserves, debtReserves] = await Promise.all([
        loadDexCollateralReserves(publicClient, legs.collateralDex),
        loadDexDebtReserves(publicClient, legs.debtDex),
      ]);
      if (
        (colReserves.token0RealReserves === 0n && colReserves.token1RealReserves === 0n) ||
        (debtReserves.token0RealReserves === 0n && debtReserves.token1RealReserves === 0n)
      ) {
        skipped++;
        continue;
      }

      const [colToken0Decimals, colToken1Decimals, debtToken0Decimals, debtToken1Decimals] = await Promise.all([
        getDecimals(colReserves.token0),
        getDecimals(colReserves.token1),
        getDecimals(debtReserves.token0),
        getDecimals(debtReserves.token1),
      ]);

      let colToken0Price = lookupPrice(colReserves.token0);
      let colToken1Price = lookupPrice(colReserves.token1);
      let debtToken0Price = lookupPrice(debtReserves.token0);
      let debtToken1Price = lookupPrice(debtReserves.token1);

      ({ token0Price: colToken0Price, token1Price: colToken1Price } = deriveMissingPairPrice(
        colToken0Price,
        colToken1Price,
        colReserves.token0ImaginaryReserves,
        colReserves.token1ImaginaryReserves,
        colToken0Decimals,
        colToken1Decimals,
      ));
      ({ token0Price: debtToken0Price, token1Price: debtToken1Price } = deriveMissingPairPrice(
        debtToken0Price,
        debtToken1Price,
        debtReserves.token0ImaginaryReserves,
        debtReserves.token1ImaginaryReserves,
        debtToken0Decimals,
        debtToken1Decimals,
      ));

      if (
        colToken0Price === undefined ||
        colToken1Price === undefined ||
        debtToken0Price === undefined ||
        debtToken1Price === undefined
      ) {
        console.warn(
          `[sync-fluid-t4-shock] skipping ${vault} - unresolved price (colToken0=${colToken0Price !== undefined}, colToken1=${colToken1Price !== undefined}, debtToken0=${debtToken0Price !== undefined}, debtToken1=${debtToken1Price !== undefined})`,
        );
        skipped++;
        continue;
      }

      const basePrices: PriceVector = {
        [colReserves.token0]: colToken0Price,
        [colReserves.token1]: colToken1Price,
        [debtReserves.token0]: debtToken0Price,
        [debtReserves.token1]: debtToken1Price,
      };
      const [colToken0Symbol, colToken1Symbol, debtToken0Symbol, debtToken1Symbol] = await Promise.all([
        getSymbol(colReserves.token0),
        getSymbol(colReserves.token1),
        getSymbol(debtReserves.token0),
        getSymbol(debtReserves.token1),
      ]);
      const assetConfig = {
        [colReserves.token0]: classifySymbolForShock(colToken0Symbol),
        [colReserves.token1]: classifySymbolForShock(colToken1Symbol),
        [debtReserves.token0]: classifySymbolForShock(debtToken0Symbol),
        [debtReserves.token1]: classifySymbolForShock(debtToken1Symbol),
      };

      const { liquidationThresholdBps: rawThresholdBps, ownSupplyShares, ownBorrowShares } = await getVaultEntireDataCached(vault);
      const liquidationThresholdBps = BigInt(rawThresholdBps);
      // Real per-vault-share fix, built in from the start for T4 (see this file's top
      // comment) - independent fractions into each pool, computed even when
      // collateralDex === debtDex (a same-pool vault has two genuinely different share
      // types - supply shares vs borrow shares - into that one pool, not one shared fraction).
      const [supplyShareFraction, borrowShareFraction] = await Promise.all([
        loadVaultSupplyShareFraction(publicClient, legs.collateralDex, ownSupplyShares),
        loadVaultBorrowShareFraction(publicClient, legs.debtDex, ownBorrowShares),
      ]);

      const colBaselineValue = computeSmartLegValueUsd8(
        colReserves,
        colToken0Decimals,
        colToken1Decimals,
        basePrices,
        assetConfig,
        0,
        SHOCK_PRESETS.correlated,
      );
      const debtBaselineValue = computeSmartLegValueUsd8(
        debtReserves,
        debtToken0Decimals,
        debtToken1Decimals,
        basePrices,
        assetConfig,
        0,
        SHOCK_PRESETS.correlated,
      );

      for (const presetId of Object.keys(SHOCK_PRESETS) as (keyof typeof SHOCK_PRESETS)[]) {
        const preset = SHOCK_PRESETS[presetId];
        for (const magnitude of sweepMagnitudes()) {
          const colPoolValue = computeSmartLegValueUsd8(
            colReserves,
            colToken0Decimals,
            colToken1Decimals,
            basePrices,
            assetConfig,
            magnitude,
            preset,
          );
          const debtPoolValue = computeSmartLegValueUsd8(
            debtReserves,
            debtToken0Decimals,
            debtToken1Decimals,
            basePrices,
            assetConfig,
            magnitude,
            preset,
          );

          // Real per-vault share of each pool's value, not the whole pool - same fixed-point
          // bigint scaling as T2/T3 (one float boundary confined to the small ratio, not the
          // potentially large USD8 pool value).
          const vaultCollateralValueUsd8 = (colPoolValue * BigInt(Math.round(supplyShareFraction * 1_000_000_000))) / 1_000_000_000n;
          const vaultDebtValueUsd8 = (debtPoolValue * BigInt(Math.round(borrowShareFraction * 1_000_000_000))) / 1_000_000_000n;

          const adjustedCollateralUsd8 = (vaultCollateralValueUsd8 * liquidationThresholdBps) / 10_000n;
          const liquidatable = adjustedCollateralUsd8 < vaultDebtValueUsd8;

          rows.push({
            vault,
            collateral_dex: legs.collateralDex,
            col_token0: colReserves.token0,
            col_token1: colReserves.token1,
            col_token0_decimals: colToken0Decimals,
            col_token1_decimals: colToken1Decimals,
            debt_dex: legs.debtDex,
            debt_token0: debtReserves.token0,
            debt_token1: debtReserves.token1,
            debt_token0_decimals: debtToken0Decimals,
            debt_token1_decimals: debtToken1Decimals,
            preset_id: presetId,
            magnitude_pct: String(Math.round(magnitude * 100)),
            col_pool_value_usd8: colPoolValue.toString(),
            col_pool_value_usd8_baseline: colBaselineValue.toString(),
            debt_pool_value_usd8: debtPoolValue.toString(),
            debt_pool_value_usd8_baseline: debtBaselineValue.toString(),
            vault_collateral_value_usd8: vaultCollateralValueUsd8.toString(),
            vault_debt_value_usd8: vaultDebtValueUsd8.toString(),
            liquidatable,
          });
        }
      }
    } catch (err) {
      console.warn(`[sync-fluid-t4-shock] ${vault} failed:`, redactError(err));
      skipped++;
    }
  }

  console.log(`[sync-fluid-t4-shock] computed ${rows.length} rows across ${t4Vaults.length - skipped} vaults (${skipped} skipped)`);

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("fluid_t4_shock_results").execute();
    if (rows.length > 0) {
      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) {
        await trx.insertInto("fluid_t4_shock_results").values(rows.slice(i, i + chunkSize)).execute();
      }
    }
  });

  return { rowCount: rows.length, vaultCount: t4Vaults.length - skipped, skipped };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await assertAllowedChain();
  try {
    const result = await runFluidT4ShockSync();
    console.log("[sync-fluid-t4-shock] done:", result);
    await db.destroy();
    process.exit(0);
  } catch (err) {
    console.error("[sync-fluid-t4-shock] failed:", redactError(err));
    await db.destroy();
    process.exit(1);
  }
}
