import { parseAbi } from "viem";
import { publicClient, assertAllowedChain } from "../rpc/client.js";
import { db } from "./client.js";
import { redactError } from "../rpc/redact.js";
import { FLUID_VAULT_RESOLVER } from "../loaders/fluidAddresses.js";
import { detectSmartLegs } from "../loaders/fluidSmartLeg.js";
import { loadDexCollateralReserves } from "../loaders/fluidDexPoolState.js";
import { computeSmartLegValueUsd8 } from "../loaders/fluidSmartLegValuation.js";
import { SHOCK_PRESETS, sweepMagnitudes } from "../engine/shockModel.js";
import { loadReserveConfigs } from "../loaders/aaveReserveConfig.js";
import type { AssetShockConfig } from "../engine/shockModel.js";
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
const TOKEN_ABI = parseAbi(["function decimals() view returns (uint8)"]);
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

      const token0Price = aavePricesByAddress.get(reserves.token0.toLowerCase());
      const token1Price = aavePricesByAddress.get(reserves.token1.toLowerCase());
      const debtPrice = aavePricesByAddress.get(debtToken.toLowerCase());
      if (token0Price === undefined || token1Price === undefined || debtPrice === undefined) {
        console.warn(`[sync-fluid-t2-shock] skipping ${vault} - unresolved price (token0/1/debt via Aave fallback)`);
        skipped++;
        continue;
      }

      const basePrices: PriceVector = { [reserves.token0]: token0Price, [reserves.token1]: token1Price };
      const assetConfig: Record<string, AssetShockConfig> = {
        [reserves.token0]: { beta: 1.0, subjectToDepeg: false, subjectToStablecoinDepeg: false },
        [reserves.token1]: { beta: 1.0, subjectToDepeg: false, subjectToStablecoinDepeg: false },
      };

      const vaultDebtValueUsd8 = (vaultState[4] * debtPrice) / 10n ** BigInt(debtDecimals);
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
          // Pool-level value used directly as the vault's collateral-value approximation -
          // the real per-vault share (Fluid's userSupplySlot mechanism) isn't wired in yet,
          // see migration 0008's top comment. Honestly imprecise for a pool shared across
          // multiple vaults (confirmed real: one pool shared by 18 vaults in the base-layer
          // investigation) rather than fabricating a scaled figure with no real grounding.
          const vaultCollateralValueUsd8 = poolValue;
          const liquidatable = vaultCollateralValueUsd8 < vaultDebtValueUsd8;

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
            magnitude_pct: String(magnitude * 100),
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
