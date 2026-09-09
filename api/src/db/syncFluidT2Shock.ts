import { parseAbi } from "viem";
import { publicClient, assertAllowedChain } from "../rpc/client.js";
import { db } from "./client.js";
import { redactError } from "../rpc/redact.js";
import { FLUID_VAULT_RESOLVER } from "../loaders/fluidAddresses.js";
import { detectSmartLegs } from "../loaders/fluidSmartLeg.js";
import { loadDexCollateralReserves, loadVaultSupplyShareFraction } from "../loaders/fluidDexPoolState.js";
import { computeSmartLegValueUsd8 } from "../loaders/fluidSmartLegValuation.js";
import { SHOCK_PRESETS, sweepMagnitudes, applyShock } from "../engine/shockModel.js";
import { assetValueUsd8 } from "../engine/healthFactor.js";
import { loadReserveConfigs } from "../loaders/aaveReserveConfig.js";
import { FLUID_NATIVE_ETH_SENTINEL, AAVE_WETH_ADDRESS } from "../loaders/fluidPriceResolution.js";
import { classifySymbolForShock } from "../routes/aaveShockClassification.js";
import type { PriceVector } from "../engine/types.js";

// Lives under src/, not scripts/, for the same reason migrate.ts does (see that file's own
// comment): scripts/ is dev-only and never copied into the Docker image, and the runtime
// image strips tsx/npm/npx entirely - only compiled dist/*.js run via plain `node` inside a
// deployed pod. Real, confirmed-live gap this closes: the DB this needs to write to
// (private-*.db.ondigitalocean.com) is only reachable from inside the DOKS VPC, not from a
// local dev machine - kubectl exec into a running api pod is the real way this (and any
// future one-off Fluid sync) gets run against staging/prod.
//
// Deploy 1/6 (Fluid T2 - RPC tier). Finds every real, active T2 vault, values its
// smart-collateral leg under the full shock sweep via oracle-override repricing
// (docs/decisions.md's 2026-08-25 entry - swap-simulation was tried and abandoned), and
// writes one row per (vault, preset, magnitude).
const TOKEN_ABI = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const VAULT_CONSTANTS_ABI = parseAbi([
  "struct AddressPair { address token0; address token1; }",
  "struct ConstantViews { address liquidity; address factory; address operateImplementation; address adminImplementation; address secondaryImplementation; address deployer; address supply; address borrow; AddressPair supplyToken; AddressPair borrowToken; uint256 vaultId; uint256 vaultType; bytes32 supplyExchangePriceSlot; bytes32 borrowExchangePriceSlot; bytes32 userSupplySlot; bytes32 userBorrowSlot; }",
  "function constantsView() view returns (ConstantViews)",
]);
// getVaultState is a RESOLVER function taking the vault as a parameter, NOT a zero-arg
// method on the vault contract itself - confirmed working pattern from
// investigations/fluid-vault-tiers/t2-t4-activity-check.ts. Calling it directly on the vault
// with no args reverts every time - real bug, caught live during this feature's build.
const RESOLVER_ABI = parseAbi([
  "function getAllVaultsAddresses() view returns (address[])",
  "function getVaultType(address) view returns (uint256)",
  "function getVaultState(address) view returns (uint256 totalPositions, int256 topTick, uint256 currentBranch, uint256 totalBranch, uint256 totalBorrow, uint256 totalSupply, (uint256 status, int256 minimaTick, uint256 debtFactor, uint256 partials, uint256 debtLiquidity, uint256 baseBranchId, int256 baseBranchMinima) currentBranchState)",
]);

// getVaultEntireData - the real, public, type-aware entry point (works across T1-T4, unlike
// the internal-only _getVaultConfig). Full struct chain required for correct ABI decoding -
// a partial struct silently decodes wrong, not an error - verified live 2026-08-25 against a
// real T2 vault (liquidationThreshold=7000 bps=70%, a real, plausible value). Only
// configs.liquidationThreshold is actually used below; the rest of the struct just has to be
// present and correctly shaped for the decode to succeed.
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

// Real per-vault-share fix (docs/decisions.md's 2026-09-03 entries) - same fix applied to
// T3's debt leg, retrofitted here for T2's collateral leg. Cached per vault (visited once
// per sync run anyway) so this and the threshold lookup share one getVaultEntireData call.
const vaultEntireDataCache = new Map<string, { liquidationThresholdBps: number; ownSupplyShares: bigint }>();
async function getVaultEntireDataCached(vault: `0x${string}`): Promise<{ liquidationThresholdBps: number; ownSupplyShares: bigint }> {
  const key = vault.toLowerCase();
  const cached = vaultEntireDataCache.get(key);
  if (cached !== undefined) return cached;
  const data = await publicClient.readContract({
    address: FLUID_VAULT_RESOLVER,
    abi: VAULT_ENTIRE_DATA_ABI,
    functionName: "getVaultEntireData",
    args: [vault],
  });
  // ownSupplyShares: this vault's own collateral-share position in the smart-collateral DEX
  // pool - NOT an underlying-token amount (see fluidDexPoolState.ts's
  // loadVaultSupplyShareFraction top comment).
  const result = { liquidationThresholdBps: data.configs.liquidationThreshold, ownSupplyShares: data.totalSupplyAndBorrow.totalSupplyVault };
  vaultEntireDataCache.set(key, result);
  return result;
}

const decimalsCache = new Map<string, number>();
async function getDecimals(address: `0x${string}`): Promise<number> {
  const key = address.toLowerCase();
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;
  if (key === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
    decimalsCache.set(key, 18); // native ETH sentinel
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
    symbolCache.set(key, "WETH"); // native ETH sentinel - same reference-asset role as WETH for shock classification
    return "WETH";
  }
  const symbol = await publicClient.readContract({ address, abi: TOKEN_ABI, functionName: "symbol" });
  symbolCache.set(key, symbol);
  return symbol;
}

interface FluidT2ShockRow {
  vault: string;
  collateral_dex: string;
  token0: string;
  token1: string;
  token0_decimals: number;
  token1_decimals: number;
  debt_token: string;
  debt_decimals: number;
  preset_id: string;
  magnitude_pct: string;
  pool_value_usd8: string;
  pool_value_usd8_baseline: string;
  vault_collateral_value_usd8: string;
  vault_debt_value_usd8: string;
  liquidatable: boolean;
}

export async function runFluidT2ShockSync(): Promise<{ rowCount: number; vaultCount: number; skipped: number }> {
  const allVaults = await publicClient.readContract({
    address: FLUID_VAULT_RESOLVER,
    abi: RESOLVER_ABI,
    functionName: "getAllVaultsAddresses",
  });

  const t2Vaults: `0x${string}`[] = [];
  for (const vault of allVaults) {
    const type = await publicClient.readContract({
      address: FLUID_VAULT_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: "getVaultType",
      args: [vault],
    });
    if (Number(type) === 20000) t2Vaults.push(vault);
  }
  console.log(`[sync-fluid-t2-shock] found ${t2Vaults.length} real T2 vaults`);

  const aaveReserves = await loadReserveConfigs(publicClient, await publicClient.getBlockNumber());
  const aavePricesByAddress = new Map(aaveReserves.map((r) => [r.asset.toLowerCase(), r.priceUsd8]));
  // Real gap, caught alongside the ETH/LST vault-coverage fix: Aave lists WETH, not Fluid's
  // native-ETH sentinel address - a bare lookup on the sentinel always misses, which was
  // also blocking derivation for any pair where native ETH was the ONE side that should
  // have been trivially resolvable. Same real mapping fluidPriceResolution.ts already uses.
  function lookupAavePrice(token: `0x${string}`): bigint | undefined {
    const key = token.toLowerCase();
    return aavePricesByAddress.get(key === FLUID_NATIVE_ETH_SENTINEL ? AAVE_WETH_ADDRESS : key);
  }

  const rows: FluidT2ShockRow[] = [];
  let skipped = 0;

  for (const vault of t2Vaults) {
    try {
      const legs = await detectSmartLegs(publicClient, vault);
      if (!legs.collateralDex) {
        skipped++;
        continue;
      }
      const reserves = await loadDexCollateralReserves(publicClient, legs.collateralDex);
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

      const debtToken = constants.borrowToken.token0;
      const debtDecimals = await getDecimals(debtToken);

      // Real gap, caught by the user asking why no ETH/LST vaults ever showed up: this used
      // to be a flat Aave-only lookup, unlike T1's sync (resolveFluidPrices.ts), which
      // propagates prices through Fluid's own graph before falling back to Aave. At least 6
      // real T2 vaults (weETH/ETH, rsETH/ETH, weETHs/ETH, ezETH/ETH, ETH/osETH, FLUID/ETH)
      // were silently skipped because Aave doesn't list several of these newer LRT tokens
      // or FLUID itself - exactly the ETH/LST-correlated vaults classifySymbolForShock()
      // already handles, so they're precisely the ones needed to exercise the
      // correlated/depeg presets meaningfully.
      //
      // Fix: if Aave prices ONE side of the real DEX pool but not the other, derive the
      // missing token's price from the real pool's own current IMAGINARY reserves ratio -
      // imaginary reserves are what actually determines a concentrated-liquidity pool's real
      // marginal exchange rate (confirmed during the earlier shock-search investigation,
      // ~20,000x larger than real reserves and the correct reference for price, not real
      // reserves). This is a real, on-chain, protocol-native data point, not a guess - the
      // same "derive an unknown price from a known one via a real exchange rate" principle
      // resolveFluidPrices.ts already uses for T1, just via the pool's reserves instead of a
      // vault's own oraclePriceLiquidate.
      let token0Price = lookupAavePrice(reserves.token0);
      let token1Price = lookupAavePrice(reserves.token1);
      const debtPrice = lookupAavePrice(debtToken);

      // Imaginary reserves are raw token amounts (token0Decimals/token1Decimals respectively),
      // NOT already-comparable USD units - a naive cross-multiply here silently produces a
      // price wrong by exactly 10^(decimals difference) whenever the pair's two tokens don't
      // share the same decimals (confirmed live: reUSD 18-dec / USDT 6-dec derived a price
      // ~1e-12 instead of ~1.10, a real bug caught by cross-checking against Fluid's own
      // getVaultLiquidation() - see investigations/fluid-vault-tiers/check-decimals-bug.ts).
      // Scaling by 10^decimals on each side (mirroring fluidPriceResolution.ts's
      // scaleForward/scaleInverse) puts both reserves into the same per-whole-token basis
      // before taking the ratio.
      if (token0Price === undefined && token1Price !== undefined && reserves.token0ImaginaryReserves > 0n) {
        token0Price =
          (token1Price * reserves.token1ImaginaryReserves * 10n ** BigInt(token0Decimals)) /
          (reserves.token0ImaginaryReserves * 10n ** BigInt(token1Decimals));
      } else if (token1Price === undefined && token0Price !== undefined && reserves.token1ImaginaryReserves > 0n) {
        token1Price =
          (token0Price * reserves.token0ImaginaryReserves * 10n ** BigInt(token1Decimals)) /
          (reserves.token1ImaginaryReserves * 10n ** BigInt(token0Decimals));
      }

      if (token0Price === undefined || token1Price === undefined || debtPrice === undefined) {
        console.warn(
          `[sync-fluid-t2-shock] skipping ${vault} - unresolved price (token0=${token0Price !== undefined}, token1=${token1Price !== undefined}, debt=${debtPrice !== undefined})`
        );
        skipped++;
        continue;
      }

      // Real classification by real symbol() - reusing the exact same shock-model rules
      // Aave's flow already uses (classifySymbolForShock), not a re-hardcoded flat config.
      // A prior version of this file hardcoded beta:1.0/subjectToDepeg:false for BOTH
      // collateral tokens unconditionally - real bug, caught by noticing every preset
      // produced identical values for a real synced vault (a WBTC/cbBTC pair, which this
      // shock model's own documented scope deliberately holds flat, beta=0 - it was never
      // scoped to model BTC-correlated dynamics, only ETH/LST/stablecoin depeg).
      //
      // Debt token gets the SAME treatment (classified + shocked), not held at today's raw
      // price - a second real gap, caught by the user asking whether the numbers made sense
      // per preset and noticing debt never moved regardless of which preset was selected.
      // T1's own health factor already shocks both legs with the same price vector; this
      // sync had silently broken that symmetry. Concretely: several of these vaults' debt
      // tokens are themselves plain stablecoins (USDC/USDT) - under "stablecoin depeg", a
      // real depeg would devalue what's owed too, not leave it pinned at $1.
      const basePrices: PriceVector = {
        [reserves.token0]: token0Price,
        [reserves.token1]: token1Price,
        [debtToken]: debtPrice,
      };
      const [token0Symbol, token1Symbol, debtSymbol] = await Promise.all([
        getSymbol(reserves.token0),
        getSymbol(reserves.token1),
        getSymbol(debtToken),
      ]);
      const assetConfig = {
        [reserves.token0]: classifySymbolForShock(token0Symbol),
        [reserves.token1]: classifySymbolForShock(token1Symbol),
        [debtToken]: classifySymbolForShock(debtSymbol),
      };

      const { liquidationThresholdBps: rawThresholdBps, ownSupplyShares } = await getVaultEntireDataCached(vault);
      const liquidationThresholdBps = BigInt(rawThresholdBps);
      // Real per-vault-share fix (see fluidDexPoolState.ts's loadVaultSupplyShareFraction
      // top comment and docs/decisions.md's 2026-09-03 entries) - this vault's real fraction
      // of the collateral pool's total shares, not the whole shared pool's value.
      const vaultShareFraction = await loadVaultSupplyShareFraction(publicClient, legs.collateralDex, ownSupplyShares);
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
          // vaultShareFraction computation above. Same fixed-point-bigint scaling as T3's
          // debt-side fix (one float boundary confined to the small ratio, not the
          // potentially large USD8 pool value).
          const vaultCollateralValueUsd8 = (poolValue * BigInt(Math.round(vaultShareFraction * 1_000_000_000))) / 1_000_000_000n;

          // Debt shocked the same way as collateral, using the same preset+magnitude and
          // the SAME applyShock() call every other tier already uses - see this block's
          // top-of-function comment for why this was previously (wrongly) held flat.
          const shockedPrices = applyShock(basePrices, assetConfig, magnitude, preset);
          const shockedDebtPrice = shockedPrices[debtToken];
          if (shockedDebtPrice === undefined) throw new Error(`no shocked price for debt token ${debtToken}`);
          const vaultDebtValueUsd8 = assetValueUsd8(vaultState[4], debtDecimals, shockedDebtPrice);

          // Real liquidation formula (matches healthFactor.ts's isLiquidatable() exactly:
          // adjustedCollateral = collateral * liquidationThreshold, compared to debt) - a
          // prior version compared raw collateral < debt directly (effectively a 100%
          // threshold), which is far too permissive: a real position with liquidationThreshold
          // 70% is genuinely liquidatable once collateral drops to ~1.43x debt, not 1.0x. That
          // bug meant no real vault ever showed liquidatable across the entire sweep - caught
          // by the user noticing every vault stayed "Healthy" at every magnitude.
          const adjustedCollateralUsd8 = (vaultCollateralValueUsd8 * liquidationThresholdBps) / 10_000n;
          const liquidatable = adjustedCollateralUsd8 < vaultDebtValueUsd8;

          rows.push({
            vault,
            collateral_dex: legs.collateralDex,
            token0: reserves.token0,
            token1: reserves.token1,
            token0_decimals: token0Decimals,
            token1_decimals: token1Decimals,
            debt_token: debtToken,
            debt_decimals: debtDecimals,
            preset_id: presetId,
            // Math.round, not a bare multiply - sweepMagnitudes() divides by 100 to get a
            // fraction (shockModel.ts's magnitude convention), and re-multiplying doesn't
            // always round-trip exactly in floating point (real, confirmed: 8 of the 81
            // magnitudes, e.g. -0.56 * 100 = -56.00000000000001). Storing the raw
            // unrounded value meant the frontend's exact-match filter silently found zero
            // rows at those specific slider positions - caught live by the user dragging to
            // -56% and seeing every vault vanish.
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
      console.warn(`[sync-fluid-t2-shock] ${vault} failed:`, redactError(err));
      skipped++;
    }
  }

  console.log(`[sync-fluid-t2-shock] computed ${rows.length} rows across ${t2Vaults.length - skipped} vaults (${skipped} skipped)`);

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("fluid_t2_shock_results").execute();
    if (rows.length > 0) {
      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) {
        await trx.insertInto("fluid_t2_shock_results").values(rows.slice(i, i + chunkSize)).execute();
      }
    }
  });

  return { rowCount: rows.length, vaultCount: t2Vaults.length - skipped, skipped };
}

// Self-executing when run directly (`node dist/db/syncFluidT2Shock.js` in the real
// container via kubectl exec) - same isMain pattern as migrate.ts, side-effect-free function
// body so it stays importable elsewhere later without a rewrite.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await assertAllowedChain();
  try {
    const result = await runFluidT2ShockSync();
    console.log("[sync-fluid-t2-shock] done:", result);
    await db.destroy();
    process.exit(0);
  } catch (err) {
    console.error("[sync-fluid-t2-shock] failed:", redactError(err));
    await db.destroy();
    process.exit(1);
  }
}
