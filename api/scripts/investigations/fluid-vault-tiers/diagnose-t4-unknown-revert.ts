import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";
import { resolveSmartLegOracle } from "../../../src/validation/fluidT2OracleValidator.js";
import { detectSmartLegs } from "../../../src/loaders/fluidSmartLeg.js";
import { loadDexDebtReserves, loadVaultBorrowShareFraction } from "../../../src/loaders/fluidDexPoolState.js";
import { startAnvilFork } from "../../../src/fork/anvilFork.js";
import { buildFixedReturnBytecode } from "../../../src/validation/stateOverride.js";
import { probeTokenSlots } from "../../../src/validation/slotProbe.js";
import { redactError } from "../../../src/rpc/redact.js";
import { parseAbi, encodeFunctionData, decodeErrorResult, keccak256, encodeAbiParameters, numberToHex, getAddress, type PublicClient } from "viem";

const AGENT = getAddress(`0x${"e5".repeat(20)}`);

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

const LIQUIDATE_ABI = parseAbi([
  "function liquidate(uint256 token0DebtAmt_, uint256 token1DebtAmt_, uint256 debtSharesMin_, uint256 colPerUnitDebt_, uint256 token0ColAmtPerUnitShares_, uint256 token1ColAmtPerUnitShares_, address to_, bool absorb_) payable returns (uint256 actualDebtShares_, uint256 actualColShares_, uint256 token0Col_, uint256 token1Col_)",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
]);

function shockedRateFor(rate: bigint, magnitudePct: number): bigint {
  const factor = BigInt(Math.round((1 - magnitudePct / 100) * 1_000_000));
  return (rate * factor) / 1_000_000n;
}

async function dryRun(client: PublicClient, vault: `0x${string}`, legs: { overrideAddress: `0x${string}`; currentRate: bigint }[], pct: number) {
  const stateOverride = legs.map((leg) => ({ address: leg.overrideAddress, code: buildFixedReturnBytecode(shockedRateFor(leg.currentRate, pct)) }));
  const calldata = encodeFunctionData({ abi: SIMULATE_LIQUIDATE_ABI, functionName: "simulateLiquidate", args: [0n, false] });
  try {
    await client.call({ to: vault, data: calldata, stateOverride });
    return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n };
  } catch (err) {
    const data = (err as any)?.cause?.data ?? (err as any)?.data;
    if (!data) return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n };
    try {
      const decoded = decodeErrorResult({ abi: SIMULATE_LIQUIDATE_ABI, data });
      if (decoded.errorName === "FluidLiquidateResult") {
        const [actualColAmt, actualDebtAmt] = decoded.args as [bigint, bigint];
        return { swept: actualColAmt > 0n || actualDebtAmt > 0n, actualColAmt, actualDebtAmt };
      }
    } catch {}
    return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n };
  }
}

async function main() {
  await assertAllowedChain();
  const allVaults = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: VAULT_ENTIRE_DATA_ABI, functionName: "getAllVaultsAddresses" });

  let handled = 0;
  for (const vault of allVaults) {
    if (handled >= 3) break;
    try {
      const type = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: VAULT_ENTIRE_DATA_ABI, functionName: "getVaultType", args: [vault] });
      if (Number(type) !== 40000) continue;
      const data = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: VAULT_ENTIRE_DATA_ABI, functionName: "getVaultEntireData", args: [vault] });
      if (data.configs.oracle === "0x0000000000000000000000000000000000000000") continue;
      if (data.totalSupplyAndBorrow.totalBorrowVault === 0n) continue;

      const resolution = await resolveSmartLegOracle(publicClient, data.configs.oracle);
      if (resolution.overridable.length === 0) continue;
      const legs = resolution.overridable.map((o) => ({ overrideAddress: o.overrideAddress, currentRate: o.currentRate }));

      let foundPct: number | null = null;
      let probeResult: { actualDebtAmt: bigint } | null = null;
      for (const pct of [1, 3, 5, 10, 20, 30, 50, 65, 80]) {
        const probe = await dryRun(publicClient, vault, legs, pct);
        if (probe.swept) {
          foundPct = pct;
          probeResult = probe;
          break;
        }
      }
      if (foundPct === null || probeResult === null) continue;

      handled++;
      console.log(`\n=== Candidate ${handled}: ${vault} @ pct=${foundPct} ===`);

      const debtDex = (await detectSmartLegs(publicClient, vault)).debtDex!;
      const reserves = await loadDexDebtReserves(publicClient, debtDex);
      const fraction = await loadVaultBorrowShareFraction(publicClient, debtDex, probeResult.actualDebtAmt);
      const token0DebtAmt = BigInt(Math.floor(Number(reserves.token0Debt) * fraction));
      const token1DebtAmt = BigInt(Math.floor(Number(reserves.token1Debt) * fraction));
      console.log(`token0DebtAmt=${token0DebtAmt} token1DebtAmt=${token1DebtAmt} fraction=${fraction}`);
      if (token0DebtAmt === 0n && token1DebtAmt === 0n) {
        console.log("both debt amounts rounded to zero - not a real candidate");
        continue;
      }

      const fork = await startAnvilFork(undefined, 9100 + handled);
      try {
        for (const leg of legs) {
          await fork.setCode(leg.overrideAddress, buildFixedReturnBytecode(shockedRateFor(leg.currentRate, foundPct)));
        }
        const slots0 = await probeTokenSlots(fork.publicClient, reserves.token0, AGENT, vault);
        const slots1 = await probeTokenSlots(fork.publicClient, reserves.token1, AGENT, vault);
        if (!slots0 || !slots1) {
          console.log("could not determine token slots - skipping");
          continue;
        }
        for (const [token, amt, slots] of [
          [reserves.token0, token0DebtAmt, slots0],
          [reserves.token1, token1DebtAmt, slots1],
        ] as const) {
          const funded = amt * 1000n + 10n ** 30n;
          const balanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [AGENT, BigInt(slots.balanceSlotIndex)]));
          const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [AGENT, BigInt(slots.allowanceSlotIndex)]));
          const allowanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [vault, ownerSlot]));
          await fork.setStorageAt(token, balanceSlot, numberToHex(funded, { size: 32 }));
          await fork.setStorageAt(token, allowanceSlot, numberToHex(funded, { size: 32 }));
        }

        const calldata = encodeFunctionData({
          abi: LIQUIDATE_ABI,
          functionName: "liquidate",
          args: [token0DebtAmt, token1DebtAmt, 0n, 0n, 1_000_000n, 1_000_000n, AGENT, false],
        });

        try {
          const result = await fork.publicClient.call({ account: AGENT, to: vault, data: calldata });
          console.log("eth_call SUCCEEDED:", result);
        } catch (err) {
          console.log("=== eth_call REVERTED - raw error ===");
          const anyErr = err as any;
          let cur = anyErr;
          for (let i = 0; i < 6 && cur; i++) {
            console.log(`depth ${i}: name=${cur.name} data=${cur.data} shortMessage=${cur.shortMessage}`);
            cur = cur.cause;
          }
          console.log("full redacted:", redactError(err));
        }
      } finally {
        fork.stop();
      }
    } catch (err) {
      console.warn(`vault ${vault} failed:`, redactError(err));
    }
  }
}
main().catch(console.error);
