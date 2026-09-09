import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";
import { resolveT2VaultOracle } from "../../../src/validation/fluidT2OracleValidator.js";
import { parseAbi } from "viem";

const RESOLVER_ABI = parseAbi([
  "function getAllVaultsAddresses() view returns (address[])",
  "function getVaultType(address) view returns (uint256)",
]);

const VAULT_ORACLE_ABI = parseAbi([
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

async function main() {
  await assertAllowedChain();

  const allVaults = await publicClient.readContract({
    address: FLUID_VAULT_RESOLVER,
    abi: RESOLVER_ABI,
    functionName: "getAllVaultsAddresses",
  });

  const t2Vaults: `0x${string}`[] = [];
  for (const vault of allVaults) {
    const type = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: RESOLVER_ABI, functionName: "getVaultType", args: [vault] });
    if (Number(type) === 20000) t2Vaults.push(vault);
  }

  const shapeCounts = new Map<string, number>();
  let zeroOracleSkipped = 0;
  let totalOverridable = 0;
  let zeroLeversResolved = 0;

  for (const vault of t2Vaults) {
    const data = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: VAULT_ORACLE_ABI, functionName: "getVaultEntireData", args: [vault] });
    const oracle = data.configs.oracle;
    if (oracle === "0x0000000000000000000000000000000000000000") {
      zeroOracleSkipped++;
      console.log(`${vault}: SKIPPED (zero oracle - uninitialized vault)`);
      continue;
    }
    const resolution = await resolveT2VaultOracle(publicClient, oracle);
    shapeCounts.set(resolution.shape, (shapeCounts.get(resolution.shape) ?? 0) + 1);
    totalOverridable += resolution.overridable.length;
    if (resolution.overridable.length === 0) zeroLeversResolved++;
    console.log(
      `${vault} [${resolution.shape}] pegBufferBps=${resolution.pegBufferBps ?? "N/A"} ` +
        `overridable=${resolution.overridable.map((o) => `${o.leg}@${o.overrideAddress}`).join(",") || "NONE"} ` +
        (resolution.unresolvedReasons.length > 0 ? `| ${resolution.unresolvedReasons.join(" | ")}` : ""),
    );
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Total T2 vaults: ${t2Vaults.length}, zero-oracle skipped: ${zeroOracleSkipped}`);
  for (const [shape, count] of shapeCounts) console.log(`  ${shape}: ${count}`);
  console.log(`Vaults with >=1 overridable lever: ${t2Vaults.length - zeroOracleSkipped - zeroLeversResolved}`);
  console.log(`Vaults with ZERO overridable levers (not simulable): ${zeroLeversResolved}`);
  console.log(`Total overridable levers found across all vaults: ${totalOverridable}`);
}
main().catch(console.error);
