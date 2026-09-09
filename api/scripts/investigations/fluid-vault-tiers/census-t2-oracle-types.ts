// Real, on-chain census of every live T2 vault's actual oracle implementation - answers
// "should the fork tier's scope increase because each vault has a different oracle?" with
// real numbers instead of a guess. Distinguishing markers verified against Fluid's real
// public source (github.com/Instadapp/fluid-contracts-public) before being used here:
//   - chainlinkOracleData() exists only on DexSmartColCLOracle (reserves-conversion price
//     comes from a real Chainlink feed, up to 3 hops).
//   - RESERVES_PEG_BUFFER_PERCENT() exists only on DexSmartColPegOracle (reserves-conversion
//     price comes from a SEPARATELY deployed FluidOracle, PLUS a fixed safety haircut applied
//     directly to the reserves - a real, additional per-vault number worth recording).
//   - Neither present, but dexOracleData()/dexSmartColSharesRates() succeed -> by elimination,
//     DexSmartColNoBorrowOracle (Fluid's own source labels this "TO BE USED ONLY WITH NO
//     BORROW VAULTS (very tight borrow limits)" - its reserves-conversion price comes from the
//     DEX POOL'S OWN internal lastStoredPrice, not an external anchor - a real, admitted,
//     narrower-blast-radius risk tradeoff on Fluid's own part).
// getDexColDebtOracleData() is common to all three - a second, independent override lever
// (can be the zero address = identity, or a separately-deployed IFluidOracle, most likely the
// same T1-style hop-chain oracle already handled by fluidValidator.ts's existing resolver).
import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";
import { parseAbi } from "viem";

const RESOLVER_ABI = parseAbi([
  "function getAllVaultsAddresses() view returns (address[])",
  "function getVaultType(address) view returns (uint256)",
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

const ORACLE_PROBE_ABI = parseAbi([
  "function infoName() view returns (string)",
  "function chainlinkOracleData() view returns (uint256, address, bool, uint256, address, bool, uint256, address, bool, uint256)",
  "function RESERVES_PEG_BUFFER_PERCENT() view returns (uint256)",
  "function dexOracleData() view returns (address, bool, address, uint256, uint256)",
  "function dexSmartColSharesRates() view returns (uint256, uint256)",
  "function getDexColDebtOracleData() view returns (address, bool)",
]);

interface CensusRow {
  vault: string;
  infoName: string;
  oracleType: "CL" | "Peg" | "NoBorrow-or-unknown";
  oracleAddress: string;
  dexPool: string;
  pegBufferPercent?: string;
  chainlinkFeed1?: string;
  colDebtOracle: string;
  colDebtIsIdentity: boolean;
  liquidationThresholdBps: number;
  totalBorrowVaultRaw: string;
  totalSupplyVaultRaw: string;
}

async function main() {
  await assertAllowedChain();

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

  console.log(`Found ${t2Vaults.length} real T2 vaults. Probing each one's real oracle...\n`);

  const rows: CensusRow[] = [];
  const failures: { vault: string; error: string }[] = [];

  for (const vault of t2Vaults) {
    try {
      const data = await publicClient.readContract({
        address: FLUID_VAULT_RESOLVER,
        abi: VAULT_ENTIRE_DATA_ABI,
        functionName: "getVaultEntireData",
        args: [vault],
      });
      const oracle = data.configs.oracle;

      const infoName = await publicClient
        .readContract({ address: oracle, abi: ORACLE_PROBE_ABI, functionName: "infoName" })
        .catch(() => "UNKNOWN");

      const clData = await publicClient
        .readContract({ address: oracle, abi: ORACLE_PROBE_ABI, functionName: "chainlinkOracleData" })
        .catch(() => null);

      const pegBuffer = await publicClient
        .readContract({ address: oracle, abi: ORACLE_PROBE_ABI, functionName: "RESERVES_PEG_BUFFER_PERCENT" })
        .catch(() => null);

      const dexData = await publicClient
        .readContract({ address: oracle, abi: ORACLE_PROBE_ABI, functionName: "dexOracleData" })
        .catch(() => null);

      const colDebtData = await publicClient
        .readContract({ address: oracle, abi: ORACLE_PROBE_ABI, functionName: "getDexColDebtOracleData" })
        .catch(() => null);

      const oracleType: CensusRow["oracleType"] = clData !== null ? "CL" : pegBuffer !== null ? "Peg" : "NoBorrow-or-unknown";

      rows.push({
        vault,
        infoName,
        oracleType,
        oracleAddress: oracle,
        dexPool: dexData ? dexData[0] : "N/A",
        pegBufferPercent: pegBuffer !== null ? pegBuffer.toString() : undefined,
        chainlinkFeed1: clData ? clData[1] : undefined,
        colDebtOracle: colDebtData ? colDebtData[0] : "N/A",
        colDebtIsIdentity: colDebtData ? colDebtData[0] === "0x0000000000000000000000000000000000000000" : false,
        liquidationThresholdBps: data.configs.liquidationThreshold,
        totalBorrowVaultRaw: data.totalSupplyAndBorrow.totalBorrowVault.toString(),
        totalSupplyVaultRaw: data.totalSupplyAndBorrow.totalSupplyVault.toString(),
      });
    } catch (e) {
      failures.push({ vault, error: (e as Error).message.slice(0, 150) });
    }
  }

  console.log("=== CENSUS RESULTS ===\n");
  for (const r of rows) {
    console.log(
      `${r.vault} [${r.oracleType}] "${r.infoName}"\n` +
        `  oracle=${r.oracleAddress} dexPool=${r.dexPool}\n` +
        `  liqThresholdBps=${r.liquidationThresholdBps} totalBorrow=${r.totalBorrowVaultRaw} totalSupply=${r.totalSupplyVaultRaw}\n` +
        (r.pegBufferPercent !== undefined ? `  pegBufferPercent(1e6 scale)=${r.pegBufferPercent}\n` : "") +
        (r.chainlinkFeed1 !== undefined ? `  chainlinkFeed1=${r.chainlinkFeed1}\n` : "") +
        `  colDebtOracle=${r.colDebtOracle} (identity=${r.colDebtIsIdentity})\n`,
    );
  }

  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.oracleType, (byType.get(r.oracleType) ?? 0) + 1);
  console.log("=== SUMMARY ===");
  console.log(`Total real T2 vaults: ${t2Vaults.length}`);
  console.log(`Successfully classified: ${rows.length}`);
  console.log(`Failed to classify: ${failures.length}`);
  for (const [type, count] of byType) console.log(`  ${type}: ${count}`);
  const nonIdentityColDebt = rows.filter((r) => !r.colDebtIsIdentity).length;
  console.log(`Vaults with a NON-identity colDebtOracle (a second real override lever needed): ${nonIdentityColDebt}`);
  if (failures.length > 0) {
    console.log("\n=== FAILURES ===");
    for (const f of failures) console.log(`${f.vault}: ${f.error}`);
  }
}
main().catch(console.error);
