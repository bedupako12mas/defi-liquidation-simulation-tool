import { parseAbi } from "viem";
import { publicClient, assertAllowedChain } from "../rpc/client.js";
import { db } from "./client.js";
import { redactError } from "../rpc/redact.js";
import { FLUID_VAULT_RESOLVER } from "../loaders/fluidAddresses.js";
import { detectSmartLegs } from "../loaders/fluidSmartLeg.js";
import { loadDexDebtReserves, loadVaultBorrowShareFraction } from "../loaders/fluidDexPoolState.js";
import { computeSmartLegValueUsd8 } from "../loaders/fluidSmartLegValuation.js";
import { SHOCK_PRESETS, sweepMagnitudes, applyShock } from "../engine/shockModel.js";
import { assetValueUsd8 } from "../engine/healthFactor.js";
import { loadReserveConfigs } from "../loaders/aaveReserveConfig.js";
import { FLUID_NATIVE_ETH_SENTINEL, AAVE_WETH_ADDRESS, resolveFluidPrices } from "../loaders/fluidPriceResolution.js";
import { loadFluidVaultConfigs } from "../loaders/fluidVaultConfig.js";
import { classifySymbolForShock } from "../routes/aaveShockClassification.js";
import type { PriceVector } from "../engine/types.js";

// Lives under src/, not scripts/ - same deployability reasoning as syncFluidT2Shock.ts's
// top comment.
//
// Deploy 3/6 (Fluid T3 - RPC tier). T3 -> normal collateral, smart debt: the mirror image of
// T2 (Deploy 1/6). Finds every real, active T3 vault, values its smart-DEBT leg under the
// full shock sweep via the SAME oracle-override repricing mechanism T2 uses
// (computeSmartLegValueUsd8 is generic over the reserves shape - reused unchanged, not
// reimplemented, confirmed by checking DexDebtReserves structurally satisfies
// DexCollateralReserves's required fields before reusing it here). See
// docs/decisions.md's 2026-09-03 T3 investigation entry: the oracle mechanism is confirmed
// structurally mirrored to T2's, but the actual liquidate() execution path differs in kind
// (a real token0/token1 debt-repayment split, not a slippage-rounds-to-zero trap) - not
// relevant to this RPC tier, which never calls liquidate() at all, only relevant to the
// fork tier (Deploy 4/6).
const TOKEN_ABI = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const VAULT_CONSTANTS_ABI = parseAbi([
  "struct AddressPair { address token0; address token1; }",
  "struct ConstantViews { address liquidity; address factory; address operateImplementation; address adminImplementation; address secondaryImplementation; address deployer; address supply; address borrow; AddressPair supplyToken; AddressPair borrowToken; uint256 vaultId; uint256 vaultType; bytes32 supplyExchangePriceSlot; bytes32 borrowExchangePriceSlot; bytes32 userSupplySlot; bytes32 userBorrowSlot; }",
  "function constantsView() view returns (ConstantViews)",
]);
const RESOLVER_ABI = parseAbi([
  "function getAllVaultsAddresses() view returns (address[])",
  "function getVaultType(address) view returns (uint256)",
  "function getVaultState(address) view returns (uint256 totalPositions, int256 topTick, uint256 currentBranch, uint256 totalBranch, uint256 totalBorrow, uint256 totalSupply, (uint256 status, int256 minimaTick, uint256 debtFactor, uint256 partials, uint256 debtLiquidity, uint256 baseBranchId, int256 baseBranchMinima) currentBranchState)",
]);

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

// Cached per vault (visited once per sync run anyway, but keeps this and the debt-share-
// fraction fix from issuing two separate getVaultEntireData calls for the same vault).
const vaultEntireDataCache = new Map<string, { liquidationThresholdBps: number; ownBorrowShares: bigint }>();
async function getVaultEntireDataCached(vault: `0x${string}`): Promise<{ liquidationThresholdBps: number; ownBorrowShares: bigint }> {
  const key = vault.toLowerCase();
  const cached = vaultEntireDataCache.get(key);
  if (cached !== undefined) return cached;
  const data = await publicClient.readContract({
    address: FLUID_VAULT_RESOLVER,
    abi: VAULT_ENTIRE_DATA_ABI,
    functionName: "getVaultEntireData",
    args: [vault],
  });
  // ownBorrowShares: this vault's own debt-share position in the smart-debt DEX pool -
  // NOT an underlying-token amount (see fluidDexPoolState.ts's loadVaultBorrowShareFraction
  // top comment for why this needs dividing by the pool's total shares, not used raw).
  const result = { liquidationThresholdBps: data.configs.liquidationThreshold, ownBorrowShares: data.totalSupplyAndBorrow.totalBorrowVault };
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

interface FluidT3ShockRow {
  vault: string;
  collateral_token: string;
  collateral_decimals: number;
  debt_dex: string;
  token0: string;
  token1: string;
  token0_decimals: number;
  token1_decimals: number;
  preset_id: string;
  magnitude_pct: string;
  pool_value_usd8: string;
  pool_value_usd8_baseline: string;
  vault_collateral_value_usd8: string;
  vault_debt_value_usd8: string;
  liquidatable: boolean;
}

export async function runFluidT3ShockSync(): Promise<{ rowCount: number; vaultCount: number; skipped: number }> {
  const allVaults = await publicClient.readContract({
    address: FLUID_VAULT_RESOLVER,
    abi: RESOLVER_ABI,
    functionName: "getAllVaultsAddresses",
  });

  const t3Vaults: `0x${string}`[] = [];
  for (const vault of allVaults) {
    const type = await publicClient.readContract({
      address: FLUID_VAULT_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: "getVaultType",
      args: [vault],
    });
    if (Number(type) === 30000) t3Vaults.push(vault);
  }
  console.log(`[sync-fluid-t3-shock] found ${t3Vaults.length} real T3 vaults`);

  const aaveReserves = await loadReserveConfigs(publicClient, await publicClient.getBlockNumber());
  const aavePricesByAddress = new Map(aaveReserves.map((r) => [r.asset.toLowerCase(), r.priceUsd8]));

  // Real gap, same class as T2's earlier ETH/LST vault-coverage fix: several real T3
  // collateral tokens (wstUSR, reUSD, PST, sUSDai - all real, yield-bearing, Fluid-native
  // stables) aren't listed on Aave at all, and unlike a DEX pool's two sides, a scalar
  // NORMAL collateral token has no pool-ratio to derive a missing price from. Fixed by
  // reusing T1's own price-graph propagation (resolveFluidPrices - already built, already
  // proven correct for T1's sync) as a second price source: it propagates real prices
  // through T1's 102 real vault pairs from recognized-stablecoin anchors, which reaches
  // these same tokens via their T1-side vault pairs even though they never appear in any T3
  // DEX pool. Verified live before wiring in:
  // investigations/fluid-vault-tiers/check-t1-graph-covers-t3-tokens.ts resolved all 4 real
  // tokens at plausible prices (~$1.09-1.13, consistent with reUSD's already-confirmed
  // ~$1.098 from the T2 investigation).
  const t1Vaults = await loadFluidVaultConfigs(publicClient);
  const fluidGraphPrices = resolveFluidPrices(t1Vaults, aaveReserves).pricesUsd8;

  function lookupAavePrice(token: `0x${string}`): bigint | undefined {
    const key = token.toLowerCase();
    const aaveKey = key === FLUID_NATIVE_ETH_SENTINEL ? AAVE_WETH_ADDRESS : key;
    return aavePricesByAddress.get(aaveKey) ?? fluidGraphPrices.get(aaveKey);
  }

  const rows: FluidT3ShockRow[] = [];
  let skipped = 0;

  for (const vault of t3Vaults) {
    try {
      const legs = await detectSmartLegs(publicClient, vault);
      if (!legs.debtDex) {
        skipped++;
        continue;
      }
      const reserves = await loadDexDebtReserves(publicClient, legs.debtDex);
      if (reserves.token0RealReserves === 0n && reserves.token1RealReserves === 0n) {
        skipped++;
        continue;
      }

      const [token0Decimals, token1Decimals, constants, vaultState] = await Promise.all([
        getDecimals(reserves.token0),
        getDecimals(reserves.token1),
        publicClient.readContract({ address: vault, abi: VAULT_CONSTANTS_ABI, functionName: "constantsView" }),
        publicClient.readContract({
          address: FLUID_VAULT_RESOLVER,
          abi: RESOLVER_ABI,
          functionName: "getVaultState",
          args: [vault],
        }),
      ]);

      // T3's collateral is normal (a single plain token) - constants.supplyToken.token0,
      // mirroring T2's constants.borrowToken.token0 for its normal debt leg.
      const collateralToken = constants.supplyToken.token0;
      const collateralDecimals = await getDecimals(collateralToken);

      let token0Price = lookupAavePrice(reserves.token0);
      let token1Price = lookupAavePrice(reserves.token1);
      const collateralPrice = lookupAavePrice(collateralToken);

      // Same decimals-normalized derivation as T2's sync - see that file's comment and
      // investigations/fluid-vault-tiers/check-decimals-bug.ts for the real bug this fixes.
      if (token0Price === undefined && token1Price !== undefined && reserves.token0ImaginaryReserves > 0n) {
        token0Price =
          (token1Price * reserves.token1ImaginaryReserves * 10n ** BigInt(token0Decimals)) /
          (reserves.token0ImaginaryReserves * 10n ** BigInt(token1Decimals));
      } else if (token1Price === undefined && token0Price !== undefined && reserves.token1ImaginaryReserves > 0n) {
        token1Price =
          (token0Price * reserves.token0ImaginaryReserves * 10n ** BigInt(token1Decimals)) /
          (reserves.token1ImaginaryReserves * 10n ** BigInt(token0Decimals));
      }

      if (token0Price === undefined || token1Price === undefined || collateralPrice === undefined) {
        console.warn(
          `[sync-fluid-t3-shock] skipping ${vault} - unresolved price (token0=${token0Price !== undefined}, token1=${token1Price !== undefined}, collateral=${collateralPrice !== undefined})`
        );
        skipped++;
        continue;
      }

      const basePrices: PriceVector = {
        [reserves.token0]: token0Price,
        [reserves.token1]: token1Price,
        [collateralToken]: collateralPrice,
      };
      const [token0Symbol, token1Symbol, collateralSymbol] = await Promise.all([
        getSymbol(reserves.token0),
        getSymbol(reserves.token1),
        getSymbol(collateralToken),
      ]);
      const assetConfig = {
        [reserves.token0]: classifySymbolForShock(token0Symbol),
        [reserves.token1]: classifySymbolForShock(token1Symbol),
        [collateralToken]: classifySymbolForShock(collateralSymbol),
      };

      const { liquidationThresholdBps: rawThresholdBps, ownBorrowShares } = await getVaultEntireDataCached(vault);
      const liquidationThresholdBps = BigInt(rawThresholdBps);
      // Real per-vault-share fix (see fluidDexPoolState.ts's loadVaultBorrowShareFraction
      // top comment and docs/decisions.md's 2026-09-03 entry) - this vault's real fraction
      // of the debt pool's total shares, NOT the whole shared pool's value. Confirmed live:
      // a real, active vault owned ~0.92% of its debt pool's shares - using the pool's full
      // value unscaled had made a healthy vault look ~38x over-indebted.
      const vaultShareFraction = await loadVaultBorrowShareFraction(publicClient, legs.debtDex, ownBorrowShares);
      const baselineValue = computeSmartLegValueUsd8(
        reserves,
        token0Decimals,
        token1Decimals,
        basePrices,
        assetConfig,
        0,
        SHOCK_PRESETS.correlated
      );

      for (const presetId of Object.keys(SHOCK_PRESETS) as (keyof typeof SHOCK_PRESETS)[]) {
        const preset = SHOCK_PRESETS[presetId];
        for (const magnitude of sweepMagnitudes()) {
          const poolValue = computeSmartLegValueUsd8(
            reserves,
            token0Decimals,
            token1Decimals,
            basePrices,
            assetConfig,
            magnitude,
            preset
          );
          // Real per-vault share of the pool's value, not the whole pool - see the
          // vaultShareFraction computation above. Fraction scaled to a fixed-point bigint
          // (1e9) before multiplying poolValue, so the one float boundary is confined to the
          // small ratio, not the (potentially large) USD8 pool value itself.
          const vaultDebtValueUsd8 = (poolValue * BigInt(Math.round(vaultShareFraction * 1_000_000_000))) / 1_000_000_000n;

          // Collateral (normal leg) shocked the same way, using the vault's own real
          // totalSupply (vaultState[5]) - mirrors T2's debt-leg handling (vaultState[4]).
          const shockedPrices = applyShock(basePrices, assetConfig, magnitude, preset);
          const shockedCollateralPrice = shockedPrices[collateralToken];
          if (shockedCollateralPrice === undefined) throw new Error(`no shocked price for collateral token ${collateralToken}`);
          const vaultCollateralValueUsd8 = assetValueUsd8(vaultState[5], collateralDecimals, shockedCollateralPrice);

          // Real liquidation formula - identical to T2's (and healthFactor.ts's
          // isLiquidatable()): adjustedCollateral = collateral * liquidationThreshold,
          // compared against debt.
          const adjustedCollateralUsd8 = (vaultCollateralValueUsd8 * liquidationThresholdBps) / 10_000n;
          const liquidatable = adjustedCollateralUsd8 < vaultDebtValueUsd8;

          rows.push({
            vault,
            collateral_token: collateralToken,
            collateral_decimals: collateralDecimals,
            debt_dex: legs.debtDex,
            token0: reserves.token0,
            token1: reserves.token1,
            token0_decimals: token0Decimals,
            token1_decimals: token1Decimals,
            preset_id: presetId,
            magnitude_pct: String(Math.round(magnitude * 100)),
            pool_value_usd8: poolValue.toString(),
            pool_value_usd8_baseline: baselineValue.toString(),
            vault_collateral_value_usd8: vaultCollateralValueUsd8.toString(),
            vault_debt_value_usd8: vaultDebtValueUsd8.toString(),
            liquidatable,
          });
        }
      }
    } catch (err) {
      console.warn(`[sync-fluid-t3-shock] ${vault} failed:`, redactError(err));
      skipped++;
    }
  }

  console.log(`[sync-fluid-t3-shock] computed ${rows.length} rows across ${t3Vaults.length - skipped} vaults (${skipped} skipped)`);

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("fluid_t3_shock_results").execute();
    if (rows.length > 0) {
      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) {
        await trx.insertInto("fluid_t3_shock_results").values(rows.slice(i, i + chunkSize)).execute();
      }
    }
  });

  return { rowCount: rows.length, vaultCount: t3Vaults.length - skipped, skipped };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await assertAllowedChain();
  try {
    const result = await runFluidT3ShockSync();
    console.log("[sync-fluid-t3-shock] done:", result);
    await db.destroy();
    process.exit(0);
  } catch (err) {
    console.error("[sync-fluid-t3-shock] failed:", redactError(err));
    await db.destroy();
    process.exit(1);
  }
}
