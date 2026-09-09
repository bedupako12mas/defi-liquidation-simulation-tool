import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";
import { resolveT2VaultOracle } from "../../../src/validation/fluidT2OracleValidator.js";
import { buildFixedReturnBytecode } from "../../../src/validation/stateOverride.js";
import { extractRevertData } from "../../../src/validation/fluidValidator.js";
import { parseAbi, encodeFunctionData, decodeErrorResult } from "viem";

const VAULT = "0xb4a15526d427f4d20b0dAdaF3baB4177C85A699A" as const; // real failing candidate

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

const LIQUIDATE_ABI = parseAbi([
  "function liquidate(uint256 debtAmt_, uint256 colPerUnitDebt_, uint256 token0ColAmtPerUnitShares_, uint256 token1ColAmtPerUnitShares_, address to_, bool absorb_) payable returns (uint256,uint256,uint256,uint256)",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
]);

const LADDER = [1, 3, 5, 10, 20, 30, 50, 65, 80];

async function main() {
  await assertAllowedChain();
  const data = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: VAULT_ENTIRE_DATA_ABI, functionName: "getVaultEntireData", args: [VAULT] });
  const resolution = await resolveT2VaultOracle(publicClient, data.configs.oracle);
  console.log("resolution:", resolution.overridable.map(o => `${o.leg}@${o.overrideAddress} rate=${o.currentRate}`));
  const requestAmt = data.totalSupplyAndBorrow.totalBorrowVault;
  console.log("requestAmt (totalBorrowVault):", requestAmt, "totalSupplyVault:", data.totalSupplyAndBorrow.totalSupplyVault);

  for (const pct of LADDER) {
    const stateOverride = resolution.overridable.map((leg) => {
      const factor = BigInt(Math.round((1 - pct / 100) * 1_000_000));
      return { address: leg.overrideAddress, code: buildFixedReturnBytecode((leg.currentRate * factor) / 1_000_000n) };
    });
    for (const perUnit of [0n, 1n, 1_000n, 1_000_000n, 1_000_000_000n]) {
      const calldata = encodeFunctionData({ abi: LIQUIDATE_ABI, functionName: "liquidate", args: [requestAmt, 0n, perUnit, perUnit, "0x1111111111111111111111111111111111111111", false] });
      try {
        await publicClient.call({ to: VAULT, data: calldata, stateOverride });
        console.log(`${pct}% perUnit=${perUnit}: NO REVERT (unexpected)`);
      } catch (err) {
        const rdata = extractRevertData(err);
        if (!rdata) { console.log(`${pct}% perUnit=${perUnit}: no revert data`); continue; }
        try {
          const decoded = decodeErrorResult({ abi: LIQUIDATE_ABI, data: rdata });
          console.log(`${pct}% perUnit=${perUnit}: ${decoded.errorName}(${decoded.args.join(",")})`);
        } catch { console.log(`${pct}% perUnit=${perUnit}: undecodable`); }
      }
    }
  }
}
main().catch(console.error);
