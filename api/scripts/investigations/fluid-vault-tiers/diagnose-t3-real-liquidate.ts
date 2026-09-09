import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { extractRevertData } from "../../../src/validation/fluidValidator.js";
import { detectSmartLegs } from "../../../src/loaders/fluidSmartLeg.js";
import { loadDexDebtReserves, loadVaultBorrowShareFraction } from "../../../src/loaders/fluidDexPoolState.js";
import { FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";
import { parseAbi, encodeFunctionData, decodeErrorResult } from "viem";

const VAULT = "0x3E11B9aEb9C7dBbda4DD41477223Cc2f3f24b9d7" as const; // real, active, 93 positions

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

const T3_LIQUIDATE_ABI = parseAbi([
  "function liquidate(uint256 token0DebtAmt_, uint256 token1DebtAmt_, uint256 debtSharesMin_, uint256 colPerUnitDebt_, address to_, bool absorb_) payable returns (uint256 actualDebtShares_, uint256 actualCol_)",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
]);

async function main() {
  await assertAllowedChain();
  const legs = await detectSmartLegs(publicClient, VAULT);
  if (!legs.debtDex) { console.log("no debt dex"); return; }

  const data = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: VAULT_ENTIRE_DATA_ABI, functionName: "getVaultEntireData", args: [VAULT] });
  const ownBorrowShares = data.totalSupplyAndBorrow.totalBorrowVault;
  const fraction = await loadVaultBorrowShareFraction(publicClient, legs.debtDex, ownBorrowShares);
  console.log("vault's fraction of debt pool:", (fraction * 100).toFixed(4), "%");

  const reserves = await loadDexDebtReserves(publicClient, legs.debtDex);
  const token0DebtAmt = BigInt(Math.floor(Number(reserves.token0Debt) * fraction));
  const token1DebtAmt = BigInt(Math.floor(Number(reserves.token1Debt) * fraction));
  console.log("computed split: token0DebtAmt=", token0DebtAmt, "token1DebtAmt=", token1DebtAmt);

  for (const [label, debtSharesMin, colPerUnitDebt] of [
    ["0/0 (naive)", 0n, 0n],
    ["1/1", 1n, 1n],
  ] as [string, bigint, bigint][]) {
    const calldata = encodeFunctionData({ abi: T3_LIQUIDATE_ABI, functionName: "liquidate", args: [token0DebtAmt, token1DebtAmt, debtSharesMin, colPerUnitDebt, "0x000000000000000000000000000000000000dEaD", false] });
    try {
      await publicClient.call({ to: VAULT, data: calldata });
      console.log(`${label}: NO REVERT (unexpected)`);
    } catch (err) {
      const rdata = extractRevertData(err);
      if (!rdata) { console.log(`${label}: no revert data -`, (err as Error).message.slice(0,150)); continue; }
      try {
        const decoded = decodeErrorResult({ abi: T3_LIQUIDATE_ABI, data: rdata });
        console.log(`${label}: ${decoded.errorName}(${decoded.args.join(",")})`);
      } catch { console.log(`${label}: undecodable raw:`, rdata); }
    }
  }
}
main().catch(console.error);
