import { publicClient, assertAllowedChain } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { resolveAaveAddresses } from "../src/loaders/aaveAddresses.js";
import { loadReserveConfigs } from "../src/loaders/aaveReserveConfig.js";
import { enrichPositions } from "../src/loaders/aaveUserEnrichment.js";
import { classifySymbolForShock } from "../src/routes/aaveShockClassification.js";
import { applyShock, SHOCK_PRESETS } from "../src/engine/shockModel.js";
import { healthFactor } from "../src/engine/healthFactor.js";
import { validateAaveLiquidation } from "../src/validation/aaveValidator.js";
import { startAnvilFork, type AnvilFork } from "../src/fork/anvilFork.js";
import { buildFixedReturnBytecode, buildFixedTupleReturnBytecode } from "../src/validation/stateOverride.js";
import { probeTokenSlots } from "../src/validation/slotProbe.js";
import { redactError } from "../src/rpc/redact.js";
import { parseAbi, encodeFunctionData, keccak256, encodeAbiParameters, numberToHex, getAddress } from "viem";
import type { AssetShockConfig } from "../src/engine/shockModel.js";
import type { PriceVector, Position } from "../src/engine/types.js";
import type { AaveReserveConfig } from "../src/loaders/aaveReserveConfig.js";
import type { Insertable } from "kysely";
import type { ChainedLiquidationResultsTable } from "../src/db/types.js";
import { loadFluidVaultConfigs } from "../src/loaders/fluidVaultConfig.js";
import { resolveFluidPrices } from "../src/loaders/fluidPriceResolution.js";
import { resolveFluidOverrideTarget, validateFluidLiquidation, estimateFluidLiquidationGas } from "../src/validation/fluidValidator.js";
import type { FluidVaultConfig } from "../src/loaders/fluidVaultConfig.js";

/**
 * #37: the real, fork-requiring capability locked in per docs/decisions.md - does liquidating
 * position A FOR REAL change position B's REAL liquidation outcome, compared to testing B in
 * isolation (validation_results' eth_call method, stateless by construction)? For every real
 * group of currently-liquidatable positions sharing the same (collateral, debt) reserve pair,
 * spins up ONE fresh ephemeral anvil fork, mines A's real liquidationCall(), and compares B's
 * validateAaveLiquidation result before vs. after on that same fork. One fresh fork per group -
 * not one shared across all groups - so "isolated" always means "before ANY real liquidation
 * has been mined on this fork," not contaminated by an earlier group's A.
 *
 * Live-verified design: see the two real bugs this methodology caught before this script was
 * written (docs/decisions.md's #37 entry) - a case-mismatch that silently dropped every price
 * override, and a liquidator-identity collision that let A's real collateral contaminate B's
 * balance reading. Both are fixed here from the start, not rediscovered.
 */
const PRESET_ID = "correlated";
const MAGNITUDE = -0.3;
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
// A's real mined liquidation MUST use a different identity than Multicall3 (which
// validateAaveLiquidation always checks internally, hardcoded) - reusing it left A's real
// collateral sitting in the same balance B's checks read from, an inflation artifact caught live.
const A_LIQUIDATOR_IDENTITY = getAddress(`0x${"a1".repeat(20)}`);
const CANDIDATE_LIMIT = 300;
const PREFILTER_ATTEMPTS = 10;

const ORACLE_SOURCE_ABI = parseAbi(["function getSourceOfAsset(address asset) view returns (address)"]);
const POOL_ABI = parseAbi([
  "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)",
]);

async function findChainedResult(
  pool: `0x${string}`,
  oracle: `0x${string}`,
  dataProvider: `0x${string}`,
  positionB: Position,
  candidatesForA: Position[],
  shockedPrices: PriceVector,
  configByAsset: Map<string, AaveReserveConfig>,
  forkPort: number,
  pinnedBlock: bigint,
): Promise<Insertable<ChainedLiquidationResultsTable> | null> {
  const collateralB = positionB.collateral[0]!.asset as `0x${string}`;
  const debtB = positionB.debt[0]!.asset as `0x${string}`;
  const collateralConfigB = configByAsset.get(collateralB.toLowerCase());
  if (!collateralConfigB) return null;

  // Prefilter via the same cheap eth_call validateAaveLiquidation uses (no fork, no
  // mutation) - real Aave has caps beyond HF<1 (e.g. the disclosed MustNotLeaveDust gap)
  // a naive filter can't predict, so the real mined tx below isn't a coin flip.
  // NOT pinned to pinnedBlock (validateAaveLiquidation has no blockNumber param, and it's
  // shared, already-tested code the Validation tab also depends on - not worth threading a
  // block param through it for this). A small residual staleness here is low-stakes: it can
  // only make this prefilter's prediction occasionally wrong, which is already handled
  // (A's real tx status is checked and disclosed either way, never assumed from the prefilter).
  let positionA: Position | undefined;
  for (const candidate of candidatesForA.slice(0, PREFILTER_ATTEMPTS)) {
    const collateralAsset = candidate.collateral[0]!.asset as `0x${string}`;
    const debtAsset = candidate.debt[0]!.asset as `0x${string}`;
    const collateralConfig = configByAsset.get(collateralAsset.toLowerCase());
    if (!collateralConfig) continue;
    const probe = await validateAaveLiquidation(publicClient, pool, {
      position: candidate,
      shockedPrices,
      oracleOverridePrices: { [collateralAsset]: shockedPrices[collateralAsset]!, [debtAsset]: shockedPrices[debtAsset]! },
      collateralAsset,
      debtAsset,
      collateralLiquidationBonusRaw: collateralConfig.liquidationBonusRaw,
      dataProvider,
      oracle,
    });
    if (probe.status === "liquidated") {
      positionA = candidate;
      break;
    }
  }
  if (!positionA) {
    console.log(`[sync-chained] ${positionB.id}: no candidate A simulated successfully - skipping this group.`);
    return null;
  }

  const collateralA = positionA.collateral[0]!.asset as `0x${string}`;
  const debtA = positionA.debt[0]!.asset as `0x${string}`;

  let fork: AnvilFork | undefined;
  try {
    // A distinct port per group, not the shared default - SIGKILL doesn't guarantee the OS
    // releases the previous group's port before the next spawn, and reusing one port raced
    // live (a real WaitForTransactionReceiptTimeoutError on the second group in a run).
    // Pinned to the SAME block main() read reserveConfigs/positions at - without this, the
    // fork forks at "latest AT SPAWN TIME," a few seconds after the data above was read, a
    // real (if usually minor) TOCTOU gap between what was checked and what the fork actually
    // starts from. Pinning closes it and makes a run reproducible against the same real state.
    fork = await startAnvilFork(pinnedBlock, forkPort);

    // NOT lowercased: shockedPrices is keyed by the exact checksummed casing
    // reserveConfigs/position legs already share - lowercasing here silently drops every
    // lookup (caught live: see this file's top comment).
    const assetsToShock = new Set([collateralA, debtA, collateralB, debtB]);
    for (const asset of assetsToShock) {
      const price = shockedPrices[asset];
      if (price === undefined) continue;
      const source = await fork.publicClient.readContract({ address: oracle, abi: ORACLE_SOURCE_ABI, functionName: "getSourceOfAsset", args: [asset] });
      await fork.setCode(source, buildFixedReturnBytecode(price));
    }

    // Persistent debt-token funding for A_LIQUIDATOR_IDENTITY only - B's own funding is
    // handled entirely by validateAaveLiquidation's existing per-call override.
    const debtLegA = positionA.debt.find((d) => d.asset === debtA)!;
    const slots = await probeTokenSlots(fork.publicClient, debtA, A_LIQUIDATOR_IDENTITY, pool);
    if (!slots) {
      console.log(`[sync-chained] ${positionB.id}: could not probe slots for ${debtA} - skipping.`);
      return null;
    }
    const fundedAmount = debtLegA.amount * 1000n + 10n ** 30n;
    const balanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [A_LIQUIDATOR_IDENTITY, BigInt(slots.balanceSlotIndex)]));
    const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [A_LIQUIDATOR_IDENTITY, BigInt(slots.allowanceSlotIndex)]));
    const allowanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [pool, ownerSlot]));
    await fork.setStorageAt(debtA, balanceSlot, numberToHex(fundedAmount, { size: 32 }));
    await fork.setStorageAt(debtA, allowanceSlot, numberToHex(fundedAmount, { size: 32 }));

    const isolatedB = await validateAaveLiquidation(fork.publicClient, pool, {
      position: positionB,
      shockedPrices,
      oracleOverridePrices: { [collateralB]: shockedPrices[collateralB]!, [debtB]: shockedPrices[debtB]! },
      collateralAsset: collateralB,
      debtAsset: debtB,
      collateralLiquidationBonusRaw: collateralConfigB.liquidationBonusRaw,
      dataProvider,
      oracle,
    });

    const wallet = await fork.impersonate(A_LIQUIDATOR_IDENTITY);
    const liquidationCalldataA = encodeFunctionData({
      abi: POOL_ABI,
      functionName: "liquidationCall",
      args: [collateralA, debtA, positionA.user as `0x${string}`, debtLegA.amount, false],
    });
    const txHashA = await wallet.sendTransaction({ account: A_LIQUIDATOR_IDENTITY, to: pool, data: liquidationCalldataA, chain: null });
    const receiptA = await fork.publicClient.waitForTransactionReceipt({ hash: txHashA });
    console.log(`[sync-chained] ${positionA.id} -> ${positionB.id}: A's real liquidation ${receiptA.status}, block ${receiptA.blockNumber}`);

    const debtConfig = configByAsset.get(debtB.toLowerCase());
    const base = {
      protocol: "aave" as const,
      preset_id: PRESET_ID,
      magnitude_pct: (MAGNITUDE * 100).toString(),
      position_a_id: positionA.id,
      position_b_id: positionB.id,
      debt_asset_symbol: debtConfig?.symbol ?? null,
      debt_asset_decimals: debtConfig?.decimals ?? null,
      position_a_tx_status: receiptA.status,
    };

    if (receiptA.status !== "success") {
      return { ...base, isolated_status: isolatedB.status, isolated_debt_repaid: null, chained_status: null, chained_debt_repaid: null, debt_repaid_diff: null, detail: "A's real liquidation reverted on the fork - chaining not testable for this pair." };
    }

    const chainedB = await validateAaveLiquidation(fork.publicClient, pool, {
      position: positionB,
      shockedPrices,
      oracleOverridePrices: { [collateralB]: shockedPrices[collateralB]!, [debtB]: shockedPrices[debtB]! },
      collateralAsset: collateralB,
      debtAsset: debtB,
      collateralLiquidationBonusRaw: collateralConfigB.liquidationBonusRaw,
      dataProvider,
      oracle,
    });

    const isolatedRepaid = isolatedB.status === "liquidated" ? isolatedB.actualDebtRepaid : null;
    const chainedRepaid = chainedB.status === "liquidated" ? chainedB.actualDebtRepaid : null;
    const diff = isolatedRepaid !== null && chainedRepaid !== null ? chainedRepaid - isolatedRepaid : null;

    return {
      ...base,
      isolated_status: isolatedB.status,
      isolated_debt_repaid: isolatedRepaid,
      chained_status: chainedB.status,
      chained_debt_repaid: chainedRepaid,
      debt_repaid_diff: diff,
      detail: null,
    };
  } finally {
    fork?.stop();
  }
}

// #38: Fluid's liquidate() is vault-level and tick-based, NOT per-user (confirmed via
// loadFluidVaultConfigs' real ABI) - so the Aave-style "position A vs position B" split
// doesn't apply. The real analog: A's real, mined liquidate() request for a vault's full
// totalBorrowVault, vs. testing the IDENTICAL request in isolation before vs. after A is
// mined. Tries both "market" (correlated, Chainlink/Redstone hop) and "internal-exchange-
// rate" (LST-depeg, CappedRate hop) - unlike #43's cross-protocol profitability comparison,
// this doesn't need to match Aave's shock conditions, so widening the candidate pool to both
// hop types is fair game and was needed live: only 12-14 of 101 vaults have a market hop at
// all, and among those, only 1 ever had both a real liquidatable amount AND a probeable
// borrowToken - the depeg path found the first genuinely working real candidate.
const FLUID_CHAIN_AGENT = getAddress(`0x${"b2".repeat(20)}`);
const FLUID_MARKET_LADDER_PCT = [10, 15, 20, 25, 30, 40, 50, 65, 80];
const FLUID_DEPEG_LADDER_PCT = [1, 3, 5, 10, 20, 30];
const FLUID_NATIVE_ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE".toLowerCase();
const FLUID_SLOT0_KEY = numberToHex(0n, { size: 32 });
const FLUID_SLOT0_RATE_MASK = (1n << 168n) - 1n;
const FLUID_MAX_CANDIDATES = 5;
const LIQUIDITY_RESOLVER = "0xF82111c4354622AB12b9803cD3F6164FCE52e847" as const;
const LIQUIDITY_RESOLVER_ABI = parseAbi(["function getUserBorrow(address user_, address token_) view returns (uint256)"]);
const FLUID_LIQUIDATE_ABI = parseAbi([
  "function liquidate(uint256 debtAmt_, uint256 colPerUnitDebt_, address to_, bool absorb_) payable returns (uint256 actualDebtAmt_, uint256 actualColAmt_)",
]);

interface FluidCandidate {
  vault: FluidVaultConfig;
  overrideValue: bigint;
  requestAmt: bigint;
  priceComponent: "market" | "internal-exchange-rate";
  overrideAddress: `0x${string}`;
  stubKind: "chainlink-tuple" | "capped-rate-storage";
  /** The real magnitude (ladder pct) that first became liquidatable - genuinely informative
   *  (how close to threshold this candidate was), not a placeholder. */
  magnitudePct: number;
}

async function findFluidCandidates(vaults: FluidVaultConfig[], realPrices: PriceVector, assetConfig: Record<string, AssetShockConfig>): Promise<FluidCandidate[]> {
  const found: FluidCandidate[] = [];
  for (const vault of vaults) {
    if (found.length >= FLUID_MAX_CANDIDATES) break;
    if (vault.totalBorrowVault < 4n) continue;

    // Real, admin-set (vault, token) pause flag on Fluid's Liquidity module - errorId 11002
    // (ErrorTypes.UserModule__UserPaused, exact-keccak-confirmed against real source:
    // github.com/Instadapp/fluid-contracts-public/blob/main/contracts/liquidity/
    // errorTypes.sol). userModule/main.sol's _borrowOrPayback checks bit 255 of
    // _userBorrowData[vault][token] before allowing borrow OR payback - a paused vault can't
    // be liquidated via this path at all, structurally. Checked directly (LiquidityResolver's
    // real mainnet address, from Instadapp's own fluid-deployments repo) rather than
    // discovered via a real revert: only 8 of 101 real vaults are paused right now, not a
    // protocol-wide condition.
    const rawUserBorrow = await publicClient.readContract({ address: LIQUIDITY_RESOLVER, abi: LIQUIDITY_RESOLVER_ABI, functionName: "getUserBorrow", args: [vault.vault, vault.borrowToken] });
    if (((rawUserBorrow >> 255n) & 1n) === 1n) continue;

    let foundForThisVault = false;

    const marketResolution = await resolveFluidOverrideTarget(publicClient, vault.oracle, "market");
    if (marketResolution.status === "resolved" && marketResolution.stubKind === "chainlink-tuple") {
      const realRawAnswer = await publicClient
        .readContract({ address: marketResolution.overrideAddress, abi: parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]), functionName: "latestRoundData" })
        .then((r) => r[1] as bigint)
        .catch(() => null);
      if (realRawAnswer !== null && realRawAnswer > 0n) {
        const collateralAssetKey = vault.supplyToken.toLowerCase();
        const requestAmt = vault.totalBorrowVault;
        const preset = SHOCK_PRESETS.correlated;
        for (const pct of FLUID_MARKET_LADDER_PCT) {
          const shockedPrices = applyShock(realPrices, assetConfig, -pct / 100, preset);
          const ratio = realPrices[collateralAssetKey] ? (shockedPrices[collateralAssetKey]! * 100_000_000n) / realPrices[collateralAssetKey]! : 100_000_000n;
          const overrideValue = (realRawAnswer * ratio) / 100_000_000n;
          const probe = await validateFluidLiquidation(publicClient, { vault: vault.vault, oracle: vault.oracle, overrideValue, priceComponent: "market", debtAmt: requestAmt });
          if (probe.status !== "swept") continue;
          const realProbe = await estimateFluidLiquidationGas(publicClient, { vault: vault.vault, oracle: vault.oracle, borrowToken: vault.borrowToken, overrideValue, priceComponent: "market", debtAmt: requestAmt });
          if (realProbe.status === "estimated") {
            found.push({ vault, overrideValue, requestAmt, priceComponent: "market", overrideAddress: marketResolution.overrideAddress, stubKind: "chainlink-tuple", magnitudePct: -pct });
            foundForThisVault = true;
            break;
          }
        }
      }
    }
    if (foundForThisVault) continue;

    const depegResolution = await resolveFluidOverrideTarget(publicClient, vault.oracle, "internal-exchange-rate");
    if (depegResolution.status === "resolved" && depegResolution.stubKind === "capped-rate-storage") {
      const realRate = await publicClient
        .readContract({ address: depegResolution.overrideAddress, abi: parseAbi(["function getExchangeRateLiquidate() view returns (uint256)"]), functionName: "getExchangeRateLiquidate" })
        .catch(() => null);
      if (realRate !== null && realRate > 0n) {
        const requestAmt = vault.totalBorrowVault;
        for (const pct of FLUID_DEPEG_LADDER_PCT) {
          const overrideValue = (realRate * BigInt(100 - pct)) / 100n;
          const probe = await validateFluidLiquidation(publicClient, { vault: vault.vault, oracle: vault.oracle, overrideValue, priceComponent: "internal-exchange-rate", debtAmt: requestAmt });
          if (probe.status !== "swept") continue;
          const realProbe = await estimateFluidLiquidationGas(publicClient, { vault: vault.vault, oracle: vault.oracle, borrowToken: vault.borrowToken, overrideValue, priceComponent: "internal-exchange-rate", debtAmt: requestAmt });
          if (realProbe.status === "estimated") {
            found.push({ vault, overrideValue, requestAmt, priceComponent: "internal-exchange-rate", overrideAddress: depegResolution.overrideAddress, stubKind: "capped-rate-storage", magnitudePct: -pct });
            break;
          }
        }
      }
    }
  }
  return found;
}

async function runFluidChainedTest(candidate: FluidCandidate, forkPort: number): Promise<Insertable<ChainedLiquidationResultsTable>> {
  const base = {
    protocol: "fluid" as const,
    preset_id: candidate.priceComponent === "market" ? "correlated" : "lst-depeg",
    magnitude_pct: candidate.magnitudePct.toString(), // the real, ladder-found magnitude that first became liquidatable for this candidate
    position_a_id: `fluid-${candidate.vault.vault}-request-A`,
    position_b_id: `fluid-${candidate.vault.vault}-request-B`,
    debt_asset_symbol: null as string | null,
    debt_asset_decimals: candidate.vault.borrowDecimals,
  };

  let fork: AnvilFork | undefined;
  try {
    fork = await startAnvilFork(undefined, forkPort);

    if (candidate.stubKind === "chainlink-tuple") {
      await fork.setCode(candidate.overrideAddress, buildFixedTupleReturnBytecode([0n, candidate.overrideValue, 0n, 0n, 0n]));
    } else {
      const currentSlot0 = BigInt((await fork.publicClient.getStorageAt({ address: candidate.overrideAddress, slot: FLUID_SLOT0_KEY }))!);
      const newSlot0 = (currentSlot0 & ~FLUID_SLOT0_RATE_MASK) | (candidate.overrideValue & FLUID_SLOT0_RATE_MASK);
      await fork.setStorageAt(candidate.overrideAddress, FLUID_SLOT0_KEY, numberToHex(newSlot0, { size: 32 }));
    }

    const slots = await probeTokenSlots(fork.publicClient, candidate.vault.borrowToken, FLUID_CHAIN_AGENT, candidate.vault.vault);
    if (!slots) {
      return { ...base, position_a_tx_status: "not-attempted", isolated_status: null, isolated_debt_repaid: null, chained_status: null, chained_debt_repaid: null, debt_repaid_diff: null, detail: `Could not determine ${candidate.vault.borrowToken}'s balance/allowance storage layout - real, disclosed limitation of the slot-probing technique for this specific token.` };
    }
    const fundedAmount = candidate.requestAmt * 1000n + 10n ** 30n;
    const balanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [FLUID_CHAIN_AGENT, BigInt(slots.balanceSlotIndex)]));
    const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [FLUID_CHAIN_AGENT, BigInt(slots.allowanceSlotIndex)]));
    const allowanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [candidate.vault.vault, ownerSlot]));
    await fork.setStorageAt(candidate.vault.borrowToken, balanceSlot, numberToHex(fundedAmount, { size: 32 }));
    await fork.setStorageAt(candidate.vault.borrowToken, allowanceSlot, numberToHex(fundedAmount, { size: 32 }));

    const isolatedB = await validateFluidLiquidation(fork.publicClient, { vault: candidate.vault.vault, oracle: candidate.vault.oracle, overrideValue: candidate.overrideValue, priceComponent: candidate.priceComponent, debtAmt: candidate.requestAmt });

    const wallet = await fork.impersonate(FLUID_CHAIN_AGENT);
    const liquidateCalldataA = encodeFunctionData({ abi: FLUID_LIQUIDATE_ABI, functionName: "liquidate", args: [candidate.requestAmt, 0n, FLUID_CHAIN_AGENT, false] });
    const txHashA = await wallet.sendTransaction({ account: FLUID_CHAIN_AGENT, to: candidate.vault.vault, data: liquidateCalldataA, chain: null });
    const receiptA = await fork.publicClient.waitForTransactionReceipt({ hash: txHashA });
    console.log(`[sync-chained] fluid ${candidate.vault.vault}: A's real liquidation ${receiptA.status}, block ${receiptA.blockNumber}`);

    if (receiptA.status !== "success") {
      return { ...base, position_a_tx_status: receiptA.status, isolated_status: isolatedB.status, isolated_debt_repaid: null, chained_status: null, chained_debt_repaid: null, debt_repaid_diff: null, detail: "A's real liquidation reverted on the fork - chaining not testable for this vault." };
    }

    const chainedB = await validateFluidLiquidation(fork.publicClient, { vault: candidate.vault.vault, oracle: candidate.vault.oracle, overrideValue: candidate.overrideValue, priceComponent: candidate.priceComponent, debtAmt: candidate.requestAmt });

    const isolatedRepaid = isolatedB.status === "swept" ? isolatedB.actualDebtAmt : null;
    const chainedRepaid = chainedB.status === "swept" ? chainedB.actualDebtAmt : null;
    const diff = isolatedRepaid !== null && chainedRepaid !== null ? chainedRepaid - isolatedRepaid : null;

    return {
      ...base,
      position_a_tx_status: receiptA.status,
      isolated_status: isolatedB.status,
      isolated_debt_repaid: isolatedRepaid,
      chained_status: chainedB.status,
      chained_debt_repaid: chainedRepaid,
      debt_repaid_diff: diff,
      detail:
        "A and B request the IDENTICAL full totalBorrowVault amount (Fluid's liquidate() is vault-level/tick-based, not per-user, so there's no separate independent B position the way Aave has) - a real diff here measures real tick consumption, not index drift.",
    };
  } finally {
    fork?.stop();
  }
}

async function syncFluid(): Promise<Insertable<ChainedLiquidationResultsTable>[]> {
  const vaults = await loadFluidVaultConfigs(publicClient);
  const aaveReserves = await loadReserveConfigs(publicClient);
  const priceResolution = resolveFluidPrices(vaults, aaveReserves);
  const realPrices: PriceVector = Object.fromEntries([...priceResolution.pricesUsd8.entries()]);

  const symbolByAddress = new Map(aaveReserves.map((r) => [r.asset.toLowerCase(), r.symbol]));
  const assetConfig: Record<string, AssetShockConfig> = {};
  for (const v of vaults) {
    for (const asset of [v.supplyToken.toLowerCase(), v.borrowToken.toLowerCase()]) {
      if (assetConfig[asset]) continue;
      const symbol = asset === FLUID_NATIVE_ETH_SENTINEL ? "WETH" : symbolByAddress.get(asset);
      assetConfig[asset] = classifySymbolForShock(symbol ?? "UNKNOWN");
    }
  }

  console.log(`[sync-chained] fluid: searching ${vaults.length} real vaults for up to ${FLUID_MAX_CANDIDATES} genuinely liquidatable candidates...`);
  const candidates = await findFluidCandidates(vaults, realPrices, assetConfig);
  console.log(`[sync-chained] fluid: found ${candidates.length} real candidate(s).`);

  const rows: Insertable<ChainedLiquidationResultsTable>[] = [];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const debtConfig = { symbol: symbolByAddress.get(candidates[i]!.vault.borrowToken.toLowerCase()) ?? null };
      const row = await runFluidChainedTest(candidates[i]!, 8600 + i);
      rows.push({ ...row, debt_asset_symbol: debtConfig.symbol });
    } catch (err) {
      console.warn(`[sync-chained] fluid candidate ${i} (${candidates[i]!.vault.vault}) failed, skipping:`, redactError(err));
    }
  }
  return rows;
}

async function main() {
  await assertAllowedChain();

  // Captured once, used for every real-chain read below AND as the fork's own pin point -
  // otherwise the fork forks at "latest at spawn time," a few seconds after this data was
  // read, a real TOCTOU gap between what was checked and what the fork actually starts from.
  const pinnedBlock = await publicClient.getBlockNumber();
  console.log(`[sync-chained] pinned to block ${pinnedBlock}`);

  const candidates = await db.selectFrom("aave_borrow_candidates").select("address").limit(CANDIDATE_LIMIT).execute();
  const { dataProvider, pool, oracle } = await resolveAaveAddresses(publicClient); // static addresses, block-independent - not worth pinning
  const reserveConfigs = await loadReserveConfigs(publicClient, pinnedBlock);
  const { positions } = await enrichPositions(publicClient, dataProvider, candidates.map((c) => c.address), reserveConfigs, pinnedBlock, 8);

  const realPrices: PriceVector = Object.fromEntries(reserveConfigs.map((r) => [r.asset, r.priceUsd8]));
  const assetConfig: Record<string, AssetShockConfig> = Object.fromEntries(
    reserveConfigs.map((r) => [r.asset, classifySymbolForShock(r.symbol)]),
  );
  const configByAsset = new Map(reserveConfigs.map((r) => [r.asset.toLowerCase(), r]));
  const shockedPrices = applyShock(realPrices, assetConfig, MAGNITUDE, SHOCK_PRESETS[PRESET_ID]);

  const testable = positions.filter((p) => {
    if (p.collateral.length === 0 || p.debt.length === 0) return false;
    const hf = healthFactor(p, shockedPrices);
    return hf !== null && hf < 1_000_000_000_000_000_000n;
  });
  console.log(`[sync-chained] ${positions.length} positions loaded, ${testable.length} liquidatable at ${MAGNITUDE * 100}% correlated.`);

  const byPair = new Map<string, Position[]>();
  for (const p of testable) {
    const key = `${p.collateral[0]!.asset.toLowerCase()}-${p.debt[0]!.asset.toLowerCase()}`;
    (byPair.get(key) ?? byPair.set(key, []).get(key)!).push(p);
  }
  const groups = [...byPair.values()].filter((arr) => arr.length >= 2);
  console.log(`[sync-chained] ${groups.length} real shared-reserve-pair group(s) found among liquidatable positions.`);

  // One group's transient failure (e.g. a real RPC/fork timeout - not hypothetical, hit
  // live: an eth_sendTransaction to the fork timed out mid-run) must not sink every other
  // group's already-real results, including all of Fluid's (which runs after, in the same
  // process) - each group is isolated so a single bad one is skipped, not fatal.
  const aaveRows: Insertable<ChainedLiquidationResultsTable>[] = [];
  for (let i = 0; i < groups.length; i++) {
    const [positionB, ...candidatesForA] = groups[i]!;
    try {
      const result = await findChainedResult(pool, oracle, dataProvider, positionB!, candidatesForA, shockedPrices, configByAsset, 8546 + i, pinnedBlock);
      if (result) aaveRows.push(result);
    } catch (err) {
      console.warn(`[sync-chained] aave group ${i} (${positionB!.id}) failed, skipping:`, redactError(err));
    }
  }

  let fluidRows: Insertable<ChainedLiquidationResultsTable>[] = [];
  try {
    fluidRows = await syncFluid();
  } catch (err) {
    console.warn("[sync-chained] fluid sync failed entirely, writing zero fluid rows:", redactError(err));
  }

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("chained_liquidation_results").where("protocol", "=", "aave").execute();
    if (aaveRows.length > 0) await trx.insertInto("chained_liquidation_results").values(aaveRows).execute();
    await trx.deleteFrom("chained_liquidation_results").where("protocol", "=", "fluid").execute();
    if (fluidRows.length > 0) await trx.insertInto("chained_liquidation_results").values(fluidRows).execute();
  });
  console.log(`[sync-chained] wrote ${aaveRows.length} aave row(s), ${fluidRows.length} fluid row(s).`);

  await db.destroy();
}

main().catch(async (err) => {
  console.error(redactError(err));
  await db.destroy();
  process.exitCode = 1;
});
