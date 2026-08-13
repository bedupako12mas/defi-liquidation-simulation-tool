import type { PublicClient } from "viem";
import { parseAbi } from "viem";
import { FLUID_VAULT_T1_RESOLVER } from "./fluidAddresses.js";

// Field order verified against real live calls before being committed (getVaultsEntireData
// against 2 real vaults, sane decoded values) - see docs/decisions.md's "Fluid resolver
// addresses verified live" and the vault-config-decode entries. VaultPositionsResolver has
// its own, much simpler UserPosition struct (fluidPositions.ts) - the two resolvers are NOT
// interchangeable, confirmed by a real decode failure caught before it reached this file.
const VAULT_ENTIRE_DATA_ABI = parseAbi([
  "struct ConstantViews { address liquidity; address factory; address adminImplementation; address secondaryImplementation; address supplyToken; address borrowToken; uint8 supplyDecimals; uint8 borrowDecimals; uint vaultId; bytes32 liquiditySupplyExchangePriceSlot; bytes32 liquidityBorrowExchangePriceSlot; bytes32 liquidityUserSupplySlot; bytes32 liquidityUserBorrowSlot; }",
  "struct Configs { uint16 supplyRateMagnifier; uint16 borrowRateMagnifier; uint16 collateralFactor; uint16 liquidationThreshold; uint16 liquidationMaxLimit; uint16 withdrawalGap; uint16 liquidationPenalty; uint16 borrowFee; address oracle; uint oraclePriceOperate; uint oraclePriceLiquidate; address rebalancer; }",
  "struct ExchangePricesAndRates { uint lastStoredLiquiditySupplyExchangePrice; uint lastStoredLiquidityBorrowExchangePrice; uint lastStoredVaultSupplyExchangePrice; uint lastStoredVaultBorrowExchangePrice; uint liquiditySupplyExchangePrice; uint liquidityBorrowExchangePrice; uint vaultSupplyExchangePrice; uint vaultBorrowExchangePrice; uint supplyRateVault; uint borrowRateVault; uint supplyRateLiquidity; uint borrowRateLiquidity; uint rewardsRate; }",
  "struct TotalSupplyAndBorrow { uint totalSupplyVault; uint totalBorrowVault; uint totalSupplyLiquidity; uint totalBorrowLiquidity; uint absorbedSupply; uint absorbedBorrow; }",
  "struct LimitsAndAvailability { uint withdrawLimit; uint withdrawableUntilLimit; uint withdrawable; uint borrowLimit; uint borrowableUntilLimit; uint borrowable; uint borrowLimitUtilization; uint minimumBorrowing; }",
  "struct CurrentBranchState { uint status; int minimaTick; uint debtFactor; uint partials; uint debtLiquidity; uint baseBranchId; int baseBranchMinima; }",
  "struct VaultState { uint totalPositions; int topTick; uint currentBranch; uint totalBranch; uint totalBorrow; uint totalSupply; CurrentBranchState currentBranchState; }",
  "struct UserSupplyData { bool modeWithInterest; uint256 supply; uint256 withdrawalLimit; uint256 lastUpdateTimestamp; uint256 expandPercent; uint256 expandDuration; uint256 baseWithdrawalLimit; uint256 withdrawableUntilLimit; uint256 withdrawable; uint256 decayEndTimestamp; uint256 decayAmount; }",
  "struct UserBorrowData { bool modeWithInterest; uint256 borrow; uint256 borrowLimit; uint256 lastUpdateTimestamp; uint256 expandPercent; uint256 expandDuration; uint256 baseBorrowLimit; uint256 maxBorrowLimit; uint256 borrowableUntilLimit; uint256 borrowable; uint256 borrowLimitUtilization; }",
  "struct VaultEntireData { address vault; ConstantViews constantVariables; Configs configs; ExchangePricesAndRates exchangePricesAndRates; TotalSupplyAndBorrow totalSupplyAndBorrow; LimitsAndAvailability limitsAndAvailability; VaultState vaultState; UserSupplyData liquidityUserSupplyData; UserBorrowData liquidityUserBorrowData; }",
  "function getVaultsEntireData() view returns (VaultEntireData[] vaultsData_)",
]);

export interface FluidVaultConfig {
  vault: `0x${string}`;
  supplyToken: `0x${string}`;
  borrowToken: `0x${string}`;
  supplyDecimals: number;
  borrowDecimals: number;
  /** Basis points, e.g. 9000n = 90% - same convention as Aave's liquidationThresholdBps,
   *  verified directly against real Configs.liquidationThreshold values (9000 observed). */
  liquidationThresholdBps: bigint;
  /** Basis points, e.g. 100n = 1% - same "bonus only" convention as the engine's
   *  liquidationIncentiveBps (Position.liquidationIncentiveBps's own doc comment), not
   *  Aave's raw multiplier convention. Verified directly (100/200 observed on real vaults). */
  liquidationIncentiveBps: bigint;
  /** Raw IFluidOracle.getExchangeRateLiquidate() value - collateral (supplyToken) priced
   *  in borrowToken terms, scaled by 10^targetDecimals (NOT a fixed 1e18/1e8 - see
   *  targetDecimals below). Converting this to USD is fluidPriceResolution.ts's job, not
   *  this file's - this loader only reads real on-chain state, unmodified. */
  oraclePriceLiquidateRaw: bigint;
  /** contracts/oracle/fluidOracle.sol: targetDecimals = borrowDecimals + (27 -
   *  supplyDecimals). Computed here (not fetched - both decimals are already read above),
   *  verified against a real vault: ETH(18)/USDC(6) -> 15, and
   *  1880373467381393293n / 10^15 = 1880.37... - a plausible real ETH/USD price. */
  targetDecimals: number;
  totalPositions: bigint;
}

export async function loadFluidVaultConfigs(client: PublicClient): Promise<FluidVaultConfig[]> {
  const vaultsData = await client.readContract({
    address: FLUID_VAULT_T1_RESOLVER,
    abi: VAULT_ENTIRE_DATA_ABI,
    functionName: "getVaultsEntireData",
  });

  return vaultsData.map((v) => ({
    vault: v.vault,
    supplyToken: v.constantVariables.supplyToken,
    borrowToken: v.constantVariables.borrowToken,
    supplyDecimals: v.constantVariables.supplyDecimals,
    borrowDecimals: v.constantVariables.borrowDecimals,
    liquidationThresholdBps: BigInt(v.configs.liquidationThreshold),
    liquidationIncentiveBps: BigInt(v.configs.liquidationPenalty),
    oraclePriceLiquidateRaw: v.configs.oraclePriceLiquidate,
    targetDecimals: v.constantVariables.borrowDecimals + (27 - v.constantVariables.supplyDecimals),
    totalPositions: v.vaultState.totalPositions,
  }));
}
