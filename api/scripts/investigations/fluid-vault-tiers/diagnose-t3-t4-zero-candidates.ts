import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";
import { resolveSmartLegOracle } from "../../../src/validation/fluidT2OracleValidator.js";
import { buildFixedReturnBytecode } from "../../../src/validation/stateOverride.js";
import { parseAbi, encodeFunctionData, decodeErrorResult } from "viem";

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
  "function getAllVaultsAddresses() view returns (address[])",
  "function getVaultType(address) view returns (uint256)",
  "function getVaultEntireData(address vault) view returns (VaultEntireData)",
]);

const SIMULATE_LIQUIDATE_ABI = parseAbi([
  "function simulateLiquidate(uint256 debtAmt_, bool absorb_) external",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
]);

function shockedRateFor(rate: bigint, magnitudePct: number): bigint {
  const factor = BigInt(Math.round((1 - magnitudePct / 100) * 1_000_000));
  return (rate * factor) / 1_000_000n;
}

async function dryRun(vault: `0x${string}`, legs: { overrideAddress: `0x${string}`; currentRate: bigint }[], pct: number) {
  const stateOverride = legs.map((leg) => ({ address: leg.overrideAddress, code: buildFixedReturnBytecode(shockedRateFor(leg.currentRate, pct)) }));
  const calldata = encodeFunctionData({ abi: SIMULATE_LIQUIDATE_ABI, functionName: "simulateLiquidate", args: [0n, false] });
  try {
    await publicClient.call({ to: vault, data: calldata, stateOverride });
    return { swept: false, reason: "no revert" };
  } catch (err) {
    const data = (err as any)?.cause?.data ?? (err as any)?.data;
    if (!data) return { swept: false, reason: "no data" };
    try {
      const decoded = decodeErrorResult({ abi: SIMULATE_LIQUIDATE_ABI, data });
      if (decoded.errorName === "FluidLiquidateResult") {
        const [actualColAmt, actualDebtAmt] = decoded.args as [bigint, bigint];
        return { swept: actualColAmt > 0n || actualDebtAmt > 0n, reason: "FluidLiquidateResult" };
      }
      return { swept: false, reason: `${decoded.errorName}(${decoded.args.join(",")})` };
    } catch {
      return { swept: false, reason: `undecodable: ${data}` };
    }
  }
}

async function main(vaultType: number, label: string) {
  await assertAllowedChain();
  const allVaults = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: VAULT_ENTIRE_DATA_ABI, functionName: "getAllVaultsAddresses" });
  let checked = 0;
  let withLegs = 0;
  for (const vault of allVaults) {
    const type = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: VAULT_ENTIRE_DATA_ABI, functionName: "getVaultType", args: [vault] });
    if (Number(type) !== vaultType) continue;
    checked++;
    const data = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: VAULT_ENTIRE_DATA_ABI, functionName: "getVaultEntireData", args: [vault] });
    if (data.configs.oracle === "0x0000000000000000000000000000000000000000") {
      console.log(`${label} ${vault}: zero oracle, skip`);
      continue;
    }
    if (data.totalSupplyAndBorrow.totalBorrowVault === 0n) {
      console.log(`${label} ${vault}: zero borrow, skip`);
      continue;
    }
    const resolution = await resolveSmartLegOracle(publicClient, data.configs.oracle);
    if (resolution.overridable.length === 0) {
      console.log(`${label} ${vault}: no overridable legs (${resolution.shape}), skip`);
      continue;
    }
    withLegs++;
    const legs = resolution.overridable.map((o) => ({ overrideAddress: o.overrideAddress, currentRate: o.currentRate }));
    // Try the OLD fixed ladder directly, to compare against the new binary search.
    for (const pct of [1, 3, 5, 10, 20, 30, 50, 65, 80]) {
      const probe = await dryRun(vault, legs, pct);
      if (probe.swept) {
        console.log(`${label} ${vault}: OLD LADDER FOUND candidate at pct=${pct}`);
        break;
      }
      if (pct === 80) console.log(`${label} ${vault}: old ladder found nothing up to 80% (last reason: ${probe.reason})`);
    }
  }
  console.log(`${label}: ${checked} real vaults, ${withLegs} with resolvable oracle legs`);
}

const [, , typeArg, labelArg] = process.argv;
main(Number(typeArg), labelArg ?? "vault").catch(console.error);
