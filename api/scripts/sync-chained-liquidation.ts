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
import { parseAbi, encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeEventLog, keccak256, encodeAbiParameters, numberToHex, getAddress } from "viem";
import { FLUID_VAULT_RESOLVER } from "../src/loaders/fluidAddresses.js";
import { resolveSmartLegOracle } from "../src/validation/fluidT2OracleValidator.js";
import { detectSmartLegs } from "../src/loaders/fluidSmartLeg.js";
import { loadDexDebtReserves, loadVaultBorrowShareFraction } from "../src/loaders/fluidDexPoolState.js";
import type { AssetShockConfig } from "../src/engine/shockModel.js";
import type { PriceVector, Position } from "../src/engine/types.js";
import type { AaveReserveConfig } from "../src/loaders/aaveReserveConfig.js";
import type { Insertable } from "kysely";
import type { ChainedLiquidationResultsTable } from "../src/db/types.js";
import { loadFluidVaultConfigs } from "../src/loaders/fluidVaultConfig.js";
import { resolveFluidPrices } from "../src/loaders/fluidPriceResolution.js";
import { resolveFluidOverrideTarget, validateFluidLiquidation, estimateFluidLiquidationGas, extractRevertData } from "../src/validation/fluidValidator.js";
import type { FluidVaultConfig } from "../src/loaders/fluidVaultConfig.js";
import { AAVE_V4_SPOKES, type AaveV4SpokeName } from "../src/loaders/aaveV4Addresses.js";
import { validateAaveV4Liquidation } from "../src/validation/aaveV4Validator.js";
import { multicallWithRateLimitRetry } from "../src/rpc/rateLimitRetry.js";

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
/**
 * Binary search for the minimal integer magnitude percentage (0..maxPct) at which `probe`
 * first reports a real, genuine sweep - replacing every tier's fixed candidate-search ladder
 * (a hand-picked list like [1,3,5,10,20,30,50,65,80]). Real, verified investigation before
 * building this (see docs/decisions.md's 2026-09-06 entry): Fluid's own
 * FluidVaultTicksBranchesResolver looked like it might let candidate discovery skip the
 * dry-run ladder entirely, but its real deployed source (confirmed via Sourcify,
 * 0x8F31451Afa539cAfB92CBd5cdA41DC026f9CDc62) shows its `ratio` field is a bare
 * TickMath.getRatioAtTick(tick) value - raw debt/collateral in native token units, with zero
 * oracle-price awareness - and its branch data involves real, non-trivial internal
 * bookkeeping (partial-tick interpolation, debtFactor/baseBranchTick merge chains) that would
 * be a real, live risk to reimplement externally rather than ask the vault itself. Kept the
 * ground-truth dry-run call as the only source of truth; improved purely the SEARCH
 * ALGORITHM instead.
 *
 * Relies on the same monotonic-severity assumption every shock sweep in this codebase already
 * makes (sweepMagnitudes()'s whole design: larger magnitude = strictly worse health, never
 * better, for a fixed preset) - not a new assumption introduced here.
 *
 * Real, honest efficiency comparison vs. the ladder it replaces: checking maxPct first means a
 * genuine non-candidate is rejected in ONE probe call, versus the old ladder's up to 9 calls to
 * reach the same conclusion. A genuine candidate costs about the same number of calls
 * (~log2(maxPct), so ~5-7 for maxPct=80) as the old ladder's average case, but converges on the
 * EXACT integer percentage where the vault first becomes liquidatable, not whichever of 9 fixed
 * buckets happened to be the first that worked - a real precision gain, not just a speed one.
 */
async function findMinLiquidatablePct<T extends { swept: boolean }>(
  maxPct: number,
  probe: (pct: number) => Promise<T>,
): Promise<{ pct: number; result: T } | null> {
  const highResult = await probe(maxPct);
  if (!highResult.swept) return null; // not a real candidate anywhere in [0, maxPct]

  // A vault already liquidatable at 0% shock is a real, distinct finding (existing bad debt /
  // an already-distressed position) - checked explicitly, not silently folded into "pct 1".
  const zeroResult = await probe(0);
  if (zeroResult.swept) return { pct: 0, result: zeroResult };

  let low = 0;
  let high = maxPct;
  let highR = highResult;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const midResult = await probe(mid);
    if (midResult.swept) {
      high = mid;
      highR = midResult;
    } else {
      low = mid;
    }
  }
  return { pct: high, result: highR };
}

const FLUID_CHAIN_AGENT = getAddress(`0x${"b2".repeat(20)}`);
const FLUID_MARKET_MAX_PCT = 80; // was a 9-rung ladder - now a binary-search upper bound, see findMinLiquidatablePct
const FLUID_DEPEG_MAX_PCT = 30; // was a 6-rung ladder - now a binary-search upper bound, see findMinLiquidatablePct
const FLUID_NATIVE_ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE".toLowerCase();
const FLUID_SLOT0_KEY = numberToHex(0n, { size: 32 });
const FLUID_SLOT0_RATE_MASK = (1n << 168n) - 1n;
const FLUID_MAX_CANDIDATES = 5;
const LIQUIDITY_RESOLVER = "0xF82111c4354622AB12b9803cD3F6164FCE52e847" as const;
const LIQUIDITY_RESOLVER_ABI = parseAbi(["function getUserBorrow(address user_, address token_) view returns (uint256)"]);
const FLUID_LIQUIDATE_ABI = parseAbi([
  "function liquidate(uint256 debtAmt_, uint256 colPerUnitDebt_, address to_, bool absorb_) payable returns (uint256 actualDebtAmt_, uint256 actualColAmt_)",
]);

// T2's REAL liquidate() signature - six params, not T1's four. Sourced directly from
// Fluid's own real, verified, production liquidator bot
// (VaultLiquidatorImplementationV1.sol, 0x26c38EE04B4380443b40f94E6fd5b8678AB96F95, real
// Sourcify-verified source - see docs/decisions.md's 2026-09-03 entry): the two extra
// params (token0/1ColAmtPerUnitShares_) are per-token slippage protection for the DEX-share
// collateral leg, which T1's single-token collateral doesn't need. Calling T1's 4-arg
// signature against a real T2 vault produces the WRONG selector entirely, which silently
// falls through the vault's fallback into an auth-gated admin path (Vault__NotAnAuth,
// 31013) - a real, live-confirmed dead end this session, not a price/direction bug as first
// suspected.
const T2_LIQUIDATE_ABI = parseAbi([
  "function liquidate(uint256 debtAmt_, uint256 colPerUnitDebt_, uint256 token0ColAmtPerUnitShares_, uint256 token1ColAmtPerUnitShares_, address to_, bool absorb_) payable returns (uint256 actualDebtAmt_, uint256 actualColAmt_, uint256 actualToken0Amt_, uint256 actualToken1Amt_)",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
  // Real, live-caught (2026-09-06, binary-search verification run): a genuinely new real
  // candidate reverted with FluidDexError(51018) = DexT1__BelowWithdrawMin (selector
  // 0x2fee3e0e, confirmed by computing keccak256("FluidDexError(uint256)") directly, then
  // cross-checking 51018 against Fluid's own contracts/protocols/dex/errorTypes.sol via
  // GitHub) - the fixed 1_000_000n token0/1ColAmtPerUnitShares_ constant (empirically chosen
  // against an earlier real vault, see this file's T2 fork-tier comment above) computed a
  // withdrawal too small for THIS vault's specific pool depth. A real, disclosed limitation
  // of using one fixed constant across vaults with very different real scales, not fixed here
  // - added to the ABI so it decodes cleanly instead of falling through to "undecodable".
  "error FluidDexError(uint256 errorId_)",
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
        const probeMarketPct = async (pct: number): Promise<{ swept: boolean; overrideValue: bigint }> => {
          const shockedPrices = applyShock(realPrices, assetConfig, -pct / 100, preset);
          const ratio = realPrices[collateralAssetKey] ? (shockedPrices[collateralAssetKey]! * 100_000_000n) / realPrices[collateralAssetKey]! : 100_000_000n;
          const overrideValue = (realRawAnswer * ratio) / 100_000_000n;
          const probe = await validateFluidLiquidation(publicClient, { vault: vault.vault, oracle: vault.oracle, overrideValue, priceComponent: "market", debtAmt: requestAmt });
          if (probe.status !== "swept") return { swept: false, overrideValue };
          const realProbe = await estimateFluidLiquidationGas(publicClient, { vault: vault.vault, oracle: vault.oracle, borrowToken: vault.borrowToken, overrideValue, priceComponent: "market", debtAmt: requestAmt });
          return { swept: realProbe.status === "estimated", overrideValue };
        };
        const marketFound = await findMinLiquidatablePct(FLUID_MARKET_MAX_PCT, probeMarketPct);
        if (marketFound) {
          found.push({ vault, overrideValue: marketFound.result.overrideValue, requestAmt, priceComponent: "market", overrideAddress: marketResolution.overrideAddress, stubKind: "chainlink-tuple", magnitudePct: -marketFound.pct });
          foundForThisVault = true;
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
        const probeDepegPct = async (pct: number): Promise<{ swept: boolean; overrideValue: bigint }> => {
          const overrideValue = (realRate * BigInt(100 - pct)) / 100n;
          const probe = await validateFluidLiquidation(publicClient, { vault: vault.vault, oracle: vault.oracle, overrideValue, priceComponent: "internal-exchange-rate", debtAmt: requestAmt });
          if (probe.status !== "swept") return { swept: false, overrideValue };
          const realProbe = await estimateFluidLiquidationGas(publicClient, { vault: vault.vault, oracle: vault.oracle, borrowToken: vault.borrowToken, overrideValue, priceComponent: "internal-exchange-rate", debtAmt: requestAmt });
          return { swept: realProbe.status === "estimated", overrideValue };
        };
        const depegFound = await findMinLiquidatablePct(FLUID_DEPEG_MAX_PCT, probeDepegPct);
        if (depegFound) {
          found.push({ vault, overrideValue: depegFound.result.overrideValue, requestAmt, priceComponent: "internal-exchange-rate", overrideAddress: depegResolution.overrideAddress, stubKind: "capped-rate-storage", magnitudePct: -depegFound.pct });
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
    // Explicit gas, not auto-estimated - see the T4 section's comment (this file, below) for
    // the real bug this generalized fix closes: eth_estimateGas undershot for real Fluid
    // liquidate() calls on at least two vaults (a T4 one confirmed directly, a T3 one
    // observed flip between two otherwise-identical runs), producing a mined-but-reverted tx
    // with zero revert data - indistinguishable from a genuine unrecognized error until
    // traced. Applied uniformly to every Fluid tier now that it's confirmed cross-tier, not
    // T4-specific.
    const txHashA = await wallet.sendTransaction({ account: FLUID_CHAIN_AGENT, to: candidate.vault.vault, data: liquidateCalldataA, chain: null, gas: 5_000_000n });
    const receiptA = await fork.publicClient.waitForTransactionReceipt({ hash: txHashA });
    console.log(`[sync-chained] fluid ${candidate.vault.vault}: A's real liquidation ${receiptA.status}, block ${receiptA.blockNumber}, gasUsed ${receiptA.gasUsed}`);

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

// Deploy 2/6 (#66) - T2 fork tier. Same real "A's mined liquidate() vs. an identical
// isolated-vs-chained re-check" pattern as T1's Fluid path above (liquidate() is
// vault-level/tick-based for every Fluid vault type, not just T1) - the only genuinely new
// piece is HOW the collateral-side price gets shocked, since T2's smart-collateral oracle is
// a structurally different contract family (see docs/decisions.md's 2026-09-03 entry and
// src/validation/fluidT2OracleValidator.ts). Real census: of 34 live T2 vaults, 20 resolve
// to >=1 overridable price leg (a nested IFluidOracle whose entire bytecode can be
// overridden directly via buildFixedReturnBytecode, regardless of its internal
// implementation) - the other 12 are honestly reported unresolved (a fixed peg with no live
// oracle, or a hardcoded-constant oracle) and are skipped as candidates, not force-tested.
const T2_CHAIN_AGENT = getAddress(`0x${"c3".repeat(20)}`);
const T2_DEPEG_MAX_PCT = 80; // was a 9-rung ladder - now a binary-search upper bound, see findMinLiquidatablePct
const T2_MAX_CANDIDATES = 5;

const T2_VAULT_ENTIRE_DATA_ABI = parseAbi([
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

interface T2CandidateInfo {
  vault: `0x${string}`;
  borrowToken: `0x${string}`;
  borrowDecimals: number;
  requestAmt: bigint;
  legs: { overrideAddress: `0x${string}`; currentRate: bigint }[];
  magnitudePct: number;
}

function shockedRateFor(rate: bigint, magnitudePct: number): bigint {
  // rate is 1e27-scaled (IFluidOracle's own native convention) - a single deliberate float
  // boundary here (Math.round on the magnitude), same discipline as engine/shockModel.ts's
  // own documented float boundary, not scattered elsewhere in the calculation.
  const factor = BigInt(Math.round((1 - magnitudePct / 100) * 1_000_000));
  return (rate * factor) / 1_000_000n;
}

const T2_TOKEN_DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);

async function findT2Candidates(): Promise<T2CandidateInfo[]> {
  const allVaults = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: T2_VAULT_ENTIRE_DATA_ABI, functionName: "getAllVaultsAddresses" });
  const found: T2CandidateInfo[] = [];

  for (const vault of allVaults) {
    if (found.length >= T2_MAX_CANDIDATES) break;
    try {
      const type = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: T2_VAULT_ENTIRE_DATA_ABI, functionName: "getVaultType", args: [vault] });
      if (Number(type) !== 20000) continue;

      const data = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: T2_VAULT_ENTIRE_DATA_ABI, functionName: "getVaultEntireData", args: [vault] });
      if (data.configs.oracle === "0x0000000000000000000000000000000000000000") continue; // uninitialized vault slot - see docs/decisions.md
      if (data.totalSupplyAndBorrow.totalBorrowVault === 0n) continue; // nothing real to liquidate

      const resolution = await resolveSmartLegOracle(publicClient, data.configs.oracle);
      if (resolution.overridable.length === 0) continue; // honestly unresolvable - not a candidate, not force-tested

      const legs = resolution.overridable.map((o) => ({ overrideAddress: o.overrideAddress, currentRate: o.currentRate }));
      const requestAmt = data.totalSupplyAndBorrow.totalBorrowVault;

      const thresholdFound = await findMinLiquidatablePct(T2_DEPEG_MAX_PCT, (pct) =>
        dryRunT2LiquidateOnClient(publicClient, vault, legs, pct, requestAmt),
      );
      if (thresholdFound) {
        // constantVariables.borrow is the borrow LEG's source module (Liquidity, for a
        // normal, non-smart-debt leg) - NOT the debt token itself. The real token address
        // is borrowToken.token0 (borrowToken.token1 is zero for a non-smart-debt vault,
        // confirmed live: real USDT here, matching supplyToken/borrowToken's Tokens-pair
        // shape used consistently across every vault type). A real, live-caught field-name
        // trap this session, not assumed correct from the field's name alone.
        const borrowTokenAddress = data.constantVariables.borrowToken.token0;
        const borrowDecimals = await publicClient.readContract({ address: borrowTokenAddress, abi: T2_TOKEN_DECIMALS_ABI, functionName: "decimals" });
        found.push({ vault, borrowToken: borrowTokenAddress, borrowDecimals, requestAmt, legs, magnitudePct: thresholdFound.pct });
      }
    } catch (err) {
      console.warn(`[sync-chained] fluid-t2 candidate search: ${vault} failed, skipping:`, redactError(err));
    }
  }
  return found;
}

async function runT2ChainedTest(candidate: T2CandidateInfo, forkPort: number): Promise<Insertable<ChainedLiquidationResultsTable>> {
  const base = {
    protocol: "fluid-t2" as const,
    preset_id: "correlated",
    magnitude_pct: (-candidate.magnitudePct).toString(),
    position_a_id: `fluid-t2-${candidate.vault}-request-A`,
    position_b_id: `fluid-t2-${candidate.vault}-request-B`,
    debt_asset_symbol: null as string | null,
    debt_asset_decimals: candidate.borrowDecimals,
  };

  let fork: AnvilFork | undefined;
  try {
    fork = await startAnvilFork(undefined, forkPort);

    for (const leg of candidate.legs) {
      await fork.setCode(leg.overrideAddress, buildFixedReturnBytecode(shockedRateFor(leg.currentRate, candidate.magnitudePct)));
    }

    const slots = await probeTokenSlots(fork.publicClient, candidate.borrowToken, T2_CHAIN_AGENT, candidate.vault);
    if (!slots) {
      return { ...base, position_a_tx_status: "not-attempted", isolated_status: null, isolated_debt_repaid: null, chained_status: null, chained_debt_repaid: null, debt_repaid_diff: null, detail: `Could not determine ${candidate.borrowToken}'s balance/allowance storage layout - real, disclosed limitation of the slot-probing technique for this token.` };
    }
    const fundedAmount = candidate.requestAmt * 1000n + 10n ** 30n;
    const balanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [T2_CHAIN_AGENT, BigInt(slots.balanceSlotIndex)]));
    const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [T2_CHAIN_AGENT, BigInt(slots.allowanceSlotIndex)]));
    const allowanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [candidate.vault, ownerSlot]));
    await fork.setStorageAt(candidate.borrowToken, balanceSlot, numberToHex(fundedAmount, { size: 32 }));
    await fork.setStorageAt(candidate.borrowToken, allowanceSlot, numberToHex(fundedAmount, { size: 32 }));

    const legsForDryRun = candidate.legs.map((l) => ({ overrideAddress: l.overrideAddress, currentRate: l.currentRate }));
    const isolatedProbe = await dryRunT2LiquidateOnClient(fork.publicClient, candidate.vault, legsForDryRun, candidate.magnitudePct, candidate.requestAmt);

    const wallet = await fork.impersonate(T2_CHAIN_AGENT);
    // token0/1ColAmtPerUnitShares_ CANNOT both be 0 for a real (non-dead-address) recipient -
    // vaultT2/coreModule/main.sol's _colLiquidatePerfectAfter computes
    // colToken0Min_/colToken1Min_ = (perUnitShares_ * perfectColShares_) / 1e18 and reverts
    // with VaultDex__InvalidOperateAmount if BOTH come out to exactly zero (real, live-caught
    // this session - the dead-address dry-run path never reaches this check at all, which is
    // why 0/0 worked there but not here). 1n turned out to be too small too - real,
    // per-vault-varying perfectColShares_ can round 1n's product with 1e18 back down to zero
    // depending on scale (confirmed live: 1n failed for a real WEETH/ETH vault at 65%, worked
    // at 80%). 1_000_000n is verified live across both magnitudes with real margin (1n-1e15
    // all succeed for this vault; 1e18 is too large and hits a different, expected "excessive
    // minimum" revert instead) - a real, checked value, not a second guess.
    const liquidateCalldataA = encodeFunctionData({ abi: T2_LIQUIDATE_ABI, functionName: "liquidate", args: [candidate.requestAmt, 0n, 1_000_000n, 1_000_000n, T2_CHAIN_AGENT, false] });
    // Explicit gas, not auto-estimated - see the T4 section's comment (this file, below) for
    // the real, cross-tier eth_estimateGas undershoot bug this closes uniformly.
    const txHashA = await wallet.sendTransaction({ account: T2_CHAIN_AGENT, to: candidate.vault, data: liquidateCalldataA, chain: null, gas: 5_000_000n });
    const receiptA = await fork.publicClient.waitForTransactionReceipt({ hash: txHashA });
    console.log(`[sync-chained] fluid-t2 ${candidate.vault}: A's real liquidation ${receiptA.status}, block ${receiptA.blockNumber}`);

    if (receiptA.status !== "success") {
      // Diagnostic only - waitForTransactionReceipt doesn't surface a revert reason, so
      // re-simulate the identical call (same block, same state) as a plain eth_call to
      // decode why the real tx reverted.
      let revertDetail = "unknown";
      try {
        await fork.publicClient.call({ account: T2_CHAIN_AGENT, to: candidate.vault, data: liquidateCalldataA });
      } catch (simErr) {
        const simData = extractRevertData(simErr);
        if (simData) {
          try {
            const decoded = decodeErrorResult({ abi: T2_LIQUIDATE_ABI, data: simData });
            revertDetail = decoded.errorName === "FluidVaultError" ? `FluidVaultError(${decoded.args[0]})` : `${decoded.errorName}(${decoded.args.join(",")})`;
          } catch {
            revertDetail = `undecodable revert data: ${simData.slice(0, 80)}`;
          }
        } else {
          revertDetail = (simErr as Error).message.split("\n")[0]!;
        }
      }
      console.log(`[sync-chained] fluid-t2 ${candidate.vault}: revert reason - ${revertDetail}`);
      return { ...base, position_a_tx_status: receiptA.status, isolated_status: isolatedProbe.swept ? "swept" : "not-applicable", isolated_debt_repaid: isolatedProbe.swept ? isolatedProbe.actualDebtAmt.toString() : null, chained_status: null, chained_debt_repaid: null, debt_repaid_diff: null, detail: `A's real liquidation reverted on the fork (${revertDetail}) - chaining not testable for this vault.` };
    }

    const chainedProbe = await dryRunT2LiquidateOnClient(fork.publicClient, candidate.vault, legsForDryRun, candidate.magnitudePct, candidate.requestAmt);
    console.log(`[sync-chained] fluid-t2 ${candidate.vault}: chained re-check reason - ${chainedProbe.reason}`);

    const isolatedRepaid = isolatedProbe.swept ? isolatedProbe.actualDebtAmt : null;
    const chainedRepaid = chainedProbe.swept ? chainedProbe.actualDebtAmt : null;
    const diff = isolatedRepaid !== null && chainedRepaid !== null ? chainedRepaid - isolatedRepaid : null;

    return {
      ...base,
      position_a_tx_status: receiptA.status,
      isolated_status: isolatedProbe.swept ? "swept" : "not-applicable",
      isolated_debt_repaid: isolatedRepaid,
      chained_status: chainedProbe.swept ? "swept" : "not-applicable",
      chained_debt_repaid: chainedRepaid,
      debt_repaid_diff: diff,
      detail:
        "A and B request the IDENTICAL full totalBorrowVault amount (Fluid's liquidate() is vault-level/tick-based, not per-user, for every vault type including T2) - a real diff here measures real tick consumption, not index drift.",
    };
  } finally {
    fork?.stop();
  }
}

async function dryRunT2LiquidateOnClient(
  client: typeof publicClient,
  vault: `0x${string}`,
  legs: { overrideAddress: `0x${string}`; currentRate: bigint }[],
  magnitudePct: number,
  debtAmt: bigint,
): Promise<{ swept: boolean; actualColAmt: bigint; actualDebtAmt: bigint; reason: string }> {
  const stateOverride = legs.map((leg) => ({
    address: leg.overrideAddress,
    code: buildFixedReturnBytecode(shockedRateFor(leg.currentRate, magnitudePct)),
  }));
  const calldata = encodeFunctionData({ abi: T2_LIQUIDATE_ABI, functionName: "liquidate", args: [debtAmt, 0n, 0n, 0n, "0x000000000000000000000000000000000000dEaD", false] });
  try {
    await client.call({ to: vault, data: calldata, stateOverride });
    return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n, reason: "no revert at all (unexpected)" };
  } catch (err) {
    const data = extractRevertData(err);
    if (!data) return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n, reason: "no revert data extracted" };
    try {
      const decoded = decodeErrorResult({ abi: T2_LIQUIDATE_ABI, data });
      if (decoded.errorName === "FluidLiquidateResult") {
        const [actualColAmt, actualDebtAmt] = decoded.args as [bigint, bigint];
        return { swept: actualColAmt > 0n || actualDebtAmt > 0n, actualColAmt, actualDebtAmt, reason: "FluidLiquidateResult" };
      }
      return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n, reason: `${decoded.errorName}(${decoded.args.join(",")})` };
    } catch {
      return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n, reason: `undecodable raw data: ${data}` };
    }
  }
}

async function syncFluidT2(): Promise<Insertable<ChainedLiquidationResultsTable>[]> {
  console.log("[sync-chained] fluid-t2: searching real T2 vaults for genuinely liquidatable candidates...");
  const candidates = await findT2Candidates();
  console.log(`[sync-chained] fluid-t2: found ${candidates.length} real candidate(s).`);

  const rows: Insertable<ChainedLiquidationResultsTable>[] = [];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const row = await runT2ChainedTest(candidates[i]!, 8700 + i);
      rows.push(row);
    } catch (err) {
      console.warn(`[sync-chained] fluid-t2 candidate ${i} (${candidates[i]!.vault}) failed, skipping:`, redactError(err));
    }
  }
  return rows;
}

// Deploy 4/6 (#68) - T3 fork tier. T3 -> normal collateral, smart debt: the mirror image of
// T2's fork tier. Real, on-chain investigation this session found the real liquidate()
// signature differs in a structurally different way than T2's did: T3's real params are
// (token0DebtAmt_, token1DebtAmt_, debtSharesMin_, colPerUnitDebt_, to_, absorb_) - REAL
// token amounts to repay, not per-unit-share slippage minimums, so there's no T2-style
// "rounds to zero" trap (_debtLiquidateBefore only rejects token0DebtAmt_==token1DebtAmt_==0,
// a natural requirement, not a rounding artifact). The real complexity here instead: T3's
// real liquidate() pulls the debt tokens via BORROW.payback(...) as its FIRST step (unlike
// T2's collateral withdrawal, which doesn't need anything pulled upfront) - confirmed live,
// a plain unfunded eth_call reverts with SafeTransfer__TransferFromFailed (71001) even for
// the to_=DEAD_ADDRESS dry-run path. simulateLiquidate(0, false) remains the free, zero-
// funding discovery mechanism (confirmed live on a real, active T3 vault: Vault__
// InvalidLiquidation, not a transfer failure) - used for the cheap candidate-search ladder;
// the real, mined execution needs real funding for BOTH debt tokens (probeTokenSlots twice).
const T3_CHAIN_AGENT = getAddress(`0x${"d4".repeat(20)}`);
const T3_DEPEG_MAX_PCT = 80; // was a 9-rung ladder - now a binary-search upper bound, see findMinLiquidatablePct
const T3_MAX_CANDIDATES = 5;

const T3_VAULT_ENTIRE_DATA_ABI = parseAbi([
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

const T3_SIMULATE_LIQUIDATE_ABI = parseAbi([
  "function simulateLiquidate(uint256 debtAmt_, bool absorb_) external",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
]);

const T3_LIQUIDATE_ABI = parseAbi([
  "function liquidate(uint256 token0DebtAmt_, uint256 token1DebtAmt_, uint256 debtSharesMin_, uint256 colPerUnitDebt_, address to_, bool absorb_) payable returns (uint256 actualDebtShares_, uint256 actualCol_)",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
]);

interface T3CandidateInfo {
  vault: `0x${string}`;
  debtDex: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  token0Decimals: number;
  token1Decimals: number;
  legs: { overrideAddress: `0x${string}`; currentRate: bigint }[];
  magnitudePct: number;
  token0DebtAmt: bigint;
  token1DebtAmt: bigint;
}

async function dryRunT3LiquidateOnClient(
  client: typeof publicClient,
  vault: `0x${string}`,
  legs: { overrideAddress: `0x${string}`; currentRate: bigint }[],
  magnitudePct: number,
): Promise<{ swept: boolean; actualColAmt: bigint; actualDebtAmt: bigint; reason: string }> {
  const stateOverride = legs.map((leg) => ({
    address: leg.overrideAddress,
    code: buildFixedReturnBytecode(shockedRateFor(leg.currentRate, magnitudePct)),
  }));
  // debtAmt_ is ignored internally by simulateLiquidate (always substitutes a max-value
  // sentinel) - 0 here is just a placeholder, not a meaningful input.
  const calldata = encodeFunctionData({ abi: T3_SIMULATE_LIQUIDATE_ABI, functionName: "simulateLiquidate", args: [0n, false] });
  try {
    await client.call({ to: vault, data: calldata, stateOverride });
    return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n, reason: "no revert at all (unexpected)" };
  } catch (err) {
    const data = extractRevertData(err);
    if (!data) return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n, reason: "no revert data extracted" };
    try {
      const decoded = decodeErrorResult({ abi: T3_SIMULATE_LIQUIDATE_ABI, data });
      if (decoded.errorName === "FluidLiquidateResult") {
        const [actualColAmt, actualDebtAmt] = decoded.args as [bigint, bigint];
        return { swept: actualColAmt > 0n || actualDebtAmt > 0n, actualColAmt, actualDebtAmt, reason: "FluidLiquidateResult" };
      }
      return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n, reason: `${decoded.errorName}(${decoded.args.join(",")})` };
    } catch {
      return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n, reason: `undecodable raw data: ${data}` };
    }
  }
}

async function findT3Candidates(): Promise<T3CandidateInfo[]> {
  const allVaults = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: T3_VAULT_ENTIRE_DATA_ABI, functionName: "getAllVaultsAddresses" });
  const found: T3CandidateInfo[] = [];

  for (const vault of allVaults) {
    if (found.length >= T3_MAX_CANDIDATES) break;
    try {
      const type = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: T3_VAULT_ENTIRE_DATA_ABI, functionName: "getVaultType", args: [vault] });
      if (Number(type) !== 30000) continue;

      const data = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: T3_VAULT_ENTIRE_DATA_ABI, functionName: "getVaultEntireData", args: [vault] });
      if (data.configs.oracle === "0x0000000000000000000000000000000000000000") continue;
      if (data.totalSupplyAndBorrow.totalBorrowVault === 0n) continue; // empty vault - see docs/decisions.md

      const resolution = await resolveSmartLegOracle(publicClient, data.configs.oracle);
      if (resolution.overridable.length === 0) continue; // honestly unresolvable (fixed peg) - not force-tested

      const legs = resolution.overridable.map((o) => ({ overrideAddress: o.overrideAddress, currentRate: o.currentRate }));

      const thresholdFound = await findMinLiquidatablePct(T3_DEPEG_MAX_PCT, (pct) =>
        dryRunT3LiquidateOnClient(publicClient, vault, legs, pct),
      );
      if (thresholdFound) {
        // Real, live-caught fix: using this vault's FULL real share (ownBorrowShares - its
        // entire debt) here, mirroring T2's requestAmt = totalBorrowVault convention, is wrong
        // for T3 - confirmed live via two real reverts (Panic(17) arithmetic over/underflow,
        // and FluidVaultError(35002) = VaultDex__DebtSharesPaidMoreThanAvailableLiquidation).
        // Unlike T2's collateral withdrawal (naturally clamped to what's available), T3's debt
        // repayment amount is NOT clamped - requesting more than what's genuinely liquidatable
        // right now reverts outright instead of silently reducing. Fix: actualDebtAmt IS
        // already the real, Fluid-computed "genuinely liquidatable now" share amount
        // (simulateLiquidate's X128 request gets clamped to this internally) - use THAT as the
        // share numerator instead of the vault's full debt.
        const debtDex = (await detectSmartLegs(publicClient, vault)).debtDex;
        if (debtDex) {
          const reserves = await loadDexDebtReserves(publicClient, debtDex);
          const fraction = await loadVaultBorrowShareFraction(publicClient, debtDex, thresholdFound.result.actualDebtAmt);
          const token0DebtAmt = BigInt(Math.floor(Number(reserves.token0Debt) * fraction));
          const token1DebtAmt = BigInt(Math.floor(Number(reserves.token1Debt) * fraction));
          if (!(token0DebtAmt === 0n && token1DebtAmt === 0n)) {
            // real fraction rounded to nothing - not a real candidate, otherwise proceed
            const [token0Decimals, token1Decimals] = await Promise.all([
              publicClient.readContract({ address: reserves.token0, abi: T2_TOKEN_DECIMALS_ABI, functionName: "decimals" }),
              publicClient.readContract({ address: reserves.token1, abi: T2_TOKEN_DECIMALS_ABI, functionName: "decimals" }),
            ]);
            found.push({ vault, debtDex, token0: reserves.token0, token1: reserves.token1, token0Decimals, token1Decimals, legs, magnitudePct: thresholdFound.pct, token0DebtAmt, token1DebtAmt });
          }
        }
      }
    } catch (err) {
      console.warn(`[sync-chained] fluid-t3 candidate search: ${vault} failed, skipping:`, redactError(err));
    }
  }
  return found;
}

async function runT3ChainedTest(candidate: T3CandidateInfo, forkPort: number): Promise<Insertable<ChainedLiquidationResultsTable>> {
  const base = {
    protocol: "fluid-t3" as const,
    preset_id: "correlated",
    magnitude_pct: (-candidate.magnitudePct).toString(),
    position_a_id: `fluid-t3-${candidate.vault}-request-A`,
    position_b_id: `fluid-t3-${candidate.vault}-request-B`,
    // Null, not token0's decimals - actualDebtAmt_ from FluidLiquidateResult is in debt-SHARE
    // units for a smart-debt vault (the shared _liquidate() core's generic accounting unit),
    // not a single real token's amount - labeling it with token0's decimals would imply a
    // token-denominated figure that isn't accurate. Disclosed in detail instead of guessed.
    debt_asset_symbol: null as string | null,
    debt_asset_decimals: null as number | null,
  };

  let fork: AnvilFork | undefined;
  try {
    fork = await startAnvilFork(undefined, forkPort);

    for (const leg of candidate.legs) {
      await fork.setCode(leg.overrideAddress, buildFixedReturnBytecode(shockedRateFor(leg.currentRate, candidate.magnitudePct)));
    }

    // Real funding for BOTH debt tokens - T3's liquidate() pulls them immediately (see this
    // section's top comment), unlike T2's single-token debt funding.
    const slots0 = await probeTokenSlots(fork.publicClient, candidate.token0, T3_CHAIN_AGENT, candidate.vault);
    const slots1 = await probeTokenSlots(fork.publicClient, candidate.token1, T3_CHAIN_AGENT, candidate.vault);
    if (!slots0 || !slots1) {
      return { ...base, position_a_tx_status: "not-attempted", isolated_status: null, isolated_debt_repaid: null, chained_status: null, chained_debt_repaid: null, debt_repaid_diff: null, detail: "Could not determine one or both debt tokens' balance/allowance storage layout - real, disclosed limitation of the slot-probing technique." };
    }
    for (const [token, amt, slots] of [
      [candidate.token0, candidate.token0DebtAmt, slots0],
      [candidate.token1, candidate.token1DebtAmt, slots1],
    ] as const) {
      const funded = amt * 1000n + 10n ** 30n;
      const balanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [T3_CHAIN_AGENT, BigInt(slots.balanceSlotIndex)]));
      const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [T3_CHAIN_AGENT, BigInt(slots.allowanceSlotIndex)]));
      const allowanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [candidate.vault, ownerSlot]));
      await fork.setStorageAt(token, balanceSlot, numberToHex(funded, { size: 32 }));
      await fork.setStorageAt(token, allowanceSlot, numberToHex(funded, { size: 32 }));
    }

    const isolatedProbe = await dryRunT3LiquidateOnClient(fork.publicClient, candidate.vault, candidate.legs, candidate.magnitudePct);

    const wallet = await fork.impersonate(T3_CHAIN_AGENT);
    // debtSharesMin_/colPerUnitDebt_ = 0 - no T2-style rounds-to-zero trap here
    // (_debtLiquidateBefore only rejects token0DebtAmt_==token1DebtAmt_==0, both of which
    // are real, nonzero, already-computed amounts here), and colPerUnitDebt_ is a plain
    // single scalar for the NORMAL collateral leg, same 0-tolerant convention as T1.
    const liquidateCalldataA = encodeFunctionData({ abi: T3_LIQUIDATE_ABI, functionName: "liquidate", args: [candidate.token0DebtAmt, candidate.token1DebtAmt, 0n, 0n, T3_CHAIN_AGENT, false] });
    // Explicit gas, not auto-estimated - see the T4 section's comment (this file, below) for
    // the real, cross-tier eth_estimateGas undershoot bug this closes uniformly. Directly
    // observed here too, not just theorized: a T3 candidate that succeeded cleanly in one
    // live run reverted with zero revert data in the very next run before this fix landed.
    const txHashA = await wallet.sendTransaction({ account: T3_CHAIN_AGENT, to: candidate.vault, data: liquidateCalldataA, chain: null, gas: 5_000_000n });
    const receiptA = await fork.publicClient.waitForTransactionReceipt({ hash: txHashA });
    console.log(`[sync-chained] fluid-t3 ${candidate.vault}: A's real liquidation ${receiptA.status}, block ${receiptA.blockNumber}, gasUsed ${receiptA.gasUsed}`);

    if (receiptA.status !== "success") {
      let revertDetail = "unknown";
      try {
        await fork.publicClient.call({ account: T3_CHAIN_AGENT, to: candidate.vault, data: liquidateCalldataA });
      } catch (simErr) {
        const simData = extractRevertData(simErr);
        if (simData) {
          try {
            const decoded = decodeErrorResult({ abi: T3_LIQUIDATE_ABI, data: simData });
            revertDetail = decoded.errorName === "FluidVaultError" ? `FluidVaultError(${decoded.args[0]})` : `${decoded.errorName}(${decoded.args.join(",")})`;
          } catch {
            revertDetail = `undecodable revert data: ${simData.slice(0, 80)}`;
          }
        } else {
          revertDetail = (simErr as Error).message.split("\n")[0]!;
        }
      }
      console.log(`[sync-chained] fluid-t3 ${candidate.vault}: revert reason - ${revertDetail}`);
      return { ...base, position_a_tx_status: receiptA.status, isolated_status: isolatedProbe.swept ? "swept" : "not-applicable", isolated_debt_repaid: isolatedProbe.swept ? isolatedProbe.actualDebtAmt.toString() : null, chained_status: null, chained_debt_repaid: null, debt_repaid_diff: null, detail: `A's real liquidation reverted on the fork (${revertDetail}) - chaining not testable for this vault.` };
    }

    const chainedProbe = await dryRunT3LiquidateOnClient(fork.publicClient, candidate.vault, candidate.legs, candidate.magnitudePct);
    console.log(`[sync-chained] fluid-t3 ${candidate.vault}: chained re-check reason - ${chainedProbe.reason}`);

    const isolatedRepaid = isolatedProbe.swept ? isolatedProbe.actualDebtAmt : null;
    const chainedRepaid = chainedProbe.swept ? chainedProbe.actualDebtAmt : null;
    const diff = isolatedRepaid !== null && chainedRepaid !== null ? chainedRepaid - isolatedRepaid : null;

    return {
      ...base,
      position_a_tx_status: receiptA.status,
      isolated_status: isolatedProbe.swept ? "swept" : "not-applicable",
      isolated_debt_repaid: isolatedRepaid,
      chained_status: chainedProbe.swept ? "swept" : "not-applicable",
      chained_debt_repaid: chainedRepaid,
      debt_repaid_diff: diff,
      detail:
        "A and B request the IDENTICAL real per-vault-share debt repayment (Fluid's liquidate() is vault-level/tick-based, not per-user, for every vault type including T3) - a real diff here measures real tick consumption, not index drift.",
    };
  } finally {
    fork?.stop();
  }
}

async function syncFluidT3(): Promise<Insertable<ChainedLiquidationResultsTable>[]> {
  console.log("[sync-chained] fluid-t3: searching real T3 vaults for genuinely liquidatable candidates...");
  const candidates = await findT3Candidates();
  console.log(`[sync-chained] fluid-t3: found ${candidates.length} real candidate(s).`);

  const rows: Insertable<ChainedLiquidationResultsTable>[] = [];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const row = await runT3ChainedTest(candidates[i]!, 8800 + i);
      rows.push(row);
    } catch (err) {
      console.warn(`[sync-chained] fluid-t3 candidate ${i} (${candidates[i]!.vault}) failed, skipping:`, redactError(err));
    }
  }
  return rows;
}

// Deploy 6/6 (#70) - T4 fork tier. T4 -> smart collateral AND smart debt: combines T2's
// collateral-side execution (colPerUnitDebt_/token0-1ColAmtPerUnitShares_, same rounds-to-
// zero trap, same 1_000_000n fix) with T3's debt-side execution (token0/1DebtAmt_ real token
// amounts, same immediate BORROW.payback(...) pull, same real per-vault-share fix using
// simulateLiquidate's own clamped actualDebtAmt_ as the fraction numerator). Confirmed from
// Fluid's own real liquidator source this session (docs/decisions.md's 2026-09-03 entry,
// iVaultT4.sol via Sourcify) - the real signature is literally T3's debt params concatenated
// with T2's collateral params, not a new shape: (token0DebtAmt_, token1DebtAmt_,
// debtSharesMin_, colPerUnitDebt_, token0ColAmtPerUnitShares_, token1ColAmtPerUnitShares_,
// to_, absorb_). Candidate discovery uses simulateLiquidate (T3's zero-funding mechanism,
// not T2's direct-liquidate-to-DEAD_ADDRESS one) - confirmed necessary live: T4's debt leg
// pulls real tokens immediately, same as T3, so a zero-funded direct liquidate() call would
// revert on the transfer before ever reaching a decodable result.
const T4_CHAIN_AGENT = getAddress(`0x${"e5".repeat(20)}`);
const T4_DEPEG_MAX_PCT = 80; // was a 9-rung ladder - now a binary-search upper bound, see findMinLiquidatablePct
const T4_MAX_CANDIDATES = 5;

const T4_VAULT_ENTIRE_DATA_ABI = parseAbi([
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

const T4_SIMULATE_LIQUIDATE_ABI = parseAbi([
  "function simulateLiquidate(uint256 debtAmt_, bool absorb_) external",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
]);

const T4_LIQUIDATE_ABI = parseAbi([
  "function liquidate(uint256 token0DebtAmt_, uint256 token1DebtAmt_, uint256 debtSharesMin_, uint256 colPerUnitDebt_, uint256 token0ColAmtPerUnitShares_, uint256 token1ColAmtPerUnitShares_, address to_, bool absorb_) payable returns (uint256 actualDebtShares_, uint256 actualColShares_, uint256 token0Col_, uint256 token1Col_)",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
  // Same real error class T2 hit (see T2_LIQUIDATE_ABI's comment) - T4 shares the identical
  // fixed-1_000_000n collateral-side mechanism, so it's plausibly exposed to the same
  // pool-depth-dependent DexT1__BelowWithdrawMin failure.
  "error FluidDexError(uint256 errorId_)",
]);

interface T4CandidateInfo {
  vault: `0x${string}`;
  debtDex: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  legs: { overrideAddress: `0x${string}`; currentRate: bigint }[];
  magnitudePct: number;
  token0DebtAmt: bigint;
  token1DebtAmt: bigint;
}

async function dryRunT4LiquidateOnClient(
  client: typeof publicClient,
  vault: `0x${string}`,
  legs: { overrideAddress: `0x${string}`; currentRate: bigint }[],
  magnitudePct: number,
): Promise<{ swept: boolean; actualColAmt: bigint; actualDebtAmt: bigint; reason: string }> {
  const stateOverride = legs.map((leg) => ({
    address: leg.overrideAddress,
    code: buildFixedReturnBytecode(shockedRateFor(leg.currentRate, magnitudePct)),
  }));
  const calldata = encodeFunctionData({ abi: T4_SIMULATE_LIQUIDATE_ABI, functionName: "simulateLiquidate", args: [0n, false] });
  try {
    await client.call({ to: vault, data: calldata, stateOverride });
    return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n, reason: "no revert at all (unexpected)" };
  } catch (err) {
    const data = extractRevertData(err);
    if (!data) return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n, reason: "no revert data extracted" };
    try {
      const decoded = decodeErrorResult({ abi: T4_SIMULATE_LIQUIDATE_ABI, data });
      if (decoded.errorName === "FluidLiquidateResult") {
        const [actualColAmt, actualDebtAmt] = decoded.args as [bigint, bigint];
        return { swept: actualColAmt > 0n || actualDebtAmt > 0n, actualColAmt, actualDebtAmt, reason: "FluidLiquidateResult" };
      }
      return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n, reason: `${decoded.errorName}(${decoded.args.join(",")})` };
    } catch {
      return { swept: false, actualColAmt: 0n, actualDebtAmt: 0n, reason: `undecodable raw data: ${data}` };
    }
  }
}

async function findT4Candidates(): Promise<T4CandidateInfo[]> {
  const allVaults = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: T4_VAULT_ENTIRE_DATA_ABI, functionName: "getAllVaultsAddresses" });
  const found: T4CandidateInfo[] = [];

  for (const vault of allVaults) {
    if (found.length >= T4_MAX_CANDIDATES) break;
    try {
      const type = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: T4_VAULT_ENTIRE_DATA_ABI, functionName: "getVaultType", args: [vault] });
      if (Number(type) !== 40000) continue;

      const data = await publicClient.readContract({ address: FLUID_VAULT_RESOLVER, abi: T4_VAULT_ENTIRE_DATA_ABI, functionName: "getVaultEntireData", args: [vault] });
      if (data.configs.oracle === "0x0000000000000000000000000000000000000000") continue;
      if (data.totalSupplyAndBorrow.totalBorrowVault === 0n) continue; // empty vault - see docs/decisions.md

      // Exactly one overridable lever per real T4 vault, confirmed via the full 26-vault
      // census (docs/decisions.md's 2026-09-03 T4 entries) - reserves-conversion for a
      // same-pool vault, col-debt for a two-pool vault, never both, never zero-or-two.
      const resolution = await resolveSmartLegOracle(publicClient, data.configs.oracle);
      if (resolution.overridable.length === 0) continue; // honestly unresolvable (fixed peg) - not force-tested

      const legs = resolution.overridable.map((o) => ({ overrideAddress: o.overrideAddress, currentRate: o.currentRate }));

      const thresholdFound = await findMinLiquidatablePct(T4_DEPEG_MAX_PCT, (pct) =>
        dryRunT4LiquidateOnClient(publicClient, vault, legs, pct),
      );
      if (thresholdFound) {
        // Same real per-vault-share fix as T3's debt leg (this vault's debt leg is
        // structurally identical to T3's - a real smart-debt DEX pool): use
        // simulateLiquidate's own clamped actualDebtAmt_ as the fraction numerator, not
        // this vault's full theoretical debt share.
        const debtDex = (await detectSmartLegs(publicClient, vault)).debtDex;
        if (debtDex) {
          const reserves = await loadDexDebtReserves(publicClient, debtDex);
          const fraction = await loadVaultBorrowShareFraction(publicClient, debtDex, thresholdFound.result.actualDebtAmt);
          const token0DebtAmt = BigInt(Math.floor(Number(reserves.token0Debt) * fraction));
          const token1DebtAmt = BigInt(Math.floor(Number(reserves.token1Debt) * fraction));
          if (!(token0DebtAmt === 0n && token1DebtAmt === 0n)) {
            found.push({ vault, debtDex, token0: reserves.token0, token1: reserves.token1, legs, magnitudePct: thresholdFound.pct, token0DebtAmt, token1DebtAmt });
          }
        }
      }
    } catch (err) {
      console.warn(`[sync-chained] fluid-t4 candidate search: ${vault} failed, skipping:`, redactError(err));
    }
  }
  return found;
}

async function runT4ChainedTest(candidate: T4CandidateInfo, forkPort: number): Promise<Insertable<ChainedLiquidationResultsTable>> {
  const base = {
    protocol: "fluid-t4" as const,
    preset_id: "correlated",
    magnitude_pct: (-candidate.magnitudePct).toString(),
    position_a_id: `fluid-t4-${candidate.vault}-request-A`,
    position_b_id: `fluid-t4-${candidate.vault}-request-B`,
    // Null, not a token's decimals - same reasoning as T3's: actualDebtAmt_ from
    // FluidLiquidateResult is in debt-SHARE units, not a single real token's amount.
    debt_asset_symbol: null as string | null,
    debt_asset_decimals: null as number | null,
  };

  let fork: AnvilFork | undefined;
  try {
    fork = await startAnvilFork(undefined, forkPort);

    for (const leg of candidate.legs) {
      await fork.setCode(leg.overrideAddress, buildFixedReturnBytecode(shockedRateFor(leg.currentRate, candidate.magnitudePct)));
    }

    // Real funding for BOTH debt tokens - T4's debt leg pulls them immediately, same as T3
    // (unlike T2's collateral withdrawal, which needs nothing pulled upfront).
    const slots0 = await probeTokenSlots(fork.publicClient, candidate.token0, T4_CHAIN_AGENT, candidate.vault);
    const slots1 = await probeTokenSlots(fork.publicClient, candidate.token1, T4_CHAIN_AGENT, candidate.vault);
    if (!slots0 || !slots1) {
      return { ...base, position_a_tx_status: "not-attempted", isolated_status: null, isolated_debt_repaid: null, chained_status: null, chained_debt_repaid: null, debt_repaid_diff: null, detail: "Could not determine one or both debt tokens' balance/allowance storage layout - real, disclosed limitation of the slot-probing technique." };
    }
    for (const [token, amt, slots] of [
      [candidate.token0, candidate.token0DebtAmt, slots0],
      [candidate.token1, candidate.token1DebtAmt, slots1],
    ] as const) {
      const funded = amt * 1000n + 10n ** 30n;
      const balanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [T4_CHAIN_AGENT, BigInt(slots.balanceSlotIndex)]));
      const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [T4_CHAIN_AGENT, BigInt(slots.allowanceSlotIndex)]));
      const allowanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [candidate.vault, ownerSlot]));
      await fork.setStorageAt(token, balanceSlot, numberToHex(funded, { size: 32 }));
      await fork.setStorageAt(token, allowanceSlot, numberToHex(funded, { size: 32 }));
    }

    const isolatedProbe = await dryRunT4LiquidateOnClient(fork.publicClient, candidate.vault, candidate.legs, candidate.magnitudePct);

    const wallet = await fork.impersonate(T4_CHAIN_AGENT);
    // debtSharesMin_/colPerUnitDebt_ = 0 (T3's no-floor convention for the debt-share and
    // overall-ratio checks); token0/1ColAmtPerUnitShares_ = 1_000_000n each (T2's real,
    // live-verified fix for the collateral-side rounds-to-zero trap - both legs' rounding
    // traps apply here since T4 reuses both underlying code paths unchanged).
    const liquidateCalldataA = encodeFunctionData({
      abi: T4_LIQUIDATE_ABI,
      functionName: "liquidate",
      args: [candidate.token0DebtAmt, candidate.token1DebtAmt, 0n, 0n, 1_000_000n, 1_000_000n, T4_CHAIN_AGENT, false],
    });
    // Explicit gas, not auto-estimated - real, live-caught bug: two real candidates reverted
    // with NO revert data at all (not an unrecognized error - the re-simulation eth_call for
    // the SAME calldata on the SAME state succeeded cleanly, which only happens for an
    // out-of-gas revert, since that's the one failure mode with genuinely zero return data by
    // EVM design). T4's liquidate() does real work T2/T3 individually don't - for a two-pool
    // vault it touches TWO separate DEX pools' storage in one transaction (collateral
    // withdrawal from one, debt repayment into the other) - plausibly harder for
    // eth_estimateGas to size correctly than either simpler tier. A generous fixed gas limit
    // sidesteps estimation entirely, the same real-world fix production liquidator bots use
    // for MEV-sensitive transactions rather than trusting estimation under time pressure.
    const txHashA = await wallet.sendTransaction({ account: T4_CHAIN_AGENT, to: candidate.vault, data: liquidateCalldataA, chain: null, gas: 5_000_000n });
    const receiptA = await fork.publicClient.waitForTransactionReceipt({ hash: txHashA });
    console.log(`[sync-chained] fluid-t4 ${candidate.vault}: A's real liquidation ${receiptA.status}, block ${receiptA.blockNumber}, gasUsed ${receiptA.gasUsed}`);

    if (receiptA.status !== "success") {
      let revertDetail = "unknown";
      try {
        await fork.publicClient.call({ account: T4_CHAIN_AGENT, to: candidate.vault, data: liquidateCalldataA });
      } catch (simErr) {
        const simData = extractRevertData(simErr);
        if (simData) {
          try {
            const decoded = decodeErrorResult({ abi: T4_LIQUIDATE_ABI, data: simData });
            revertDetail = decoded.errorName === "FluidVaultError" ? `FluidVaultError(${decoded.args[0]})` : `${decoded.errorName}(${decoded.args.join(",")})`;
          } catch {
            revertDetail = `undecodable revert data: ${simData.slice(0, 80)}`;
          }
        } else {
          revertDetail = (simErr as Error).message.split("\n")[0]!;
        }
      }
      console.log(`[sync-chained] fluid-t4 ${candidate.vault}: revert reason - ${revertDetail}`);
      return { ...base, position_a_tx_status: receiptA.status, isolated_status: isolatedProbe.swept ? "swept" : "not-applicable", isolated_debt_repaid: isolatedProbe.swept ? isolatedProbe.actualDebtAmt.toString() : null, chained_status: null, chained_debt_repaid: null, debt_repaid_diff: null, detail: `A's real liquidation reverted on the fork (${revertDetail}) - chaining not testable for this vault.` };
    }

    const chainedProbe = await dryRunT4LiquidateOnClient(fork.publicClient, candidate.vault, candidate.legs, candidate.magnitudePct);
    console.log(`[sync-chained] fluid-t4 ${candidate.vault}: chained re-check reason - ${chainedProbe.reason}`);

    const isolatedRepaid = isolatedProbe.swept ? isolatedProbe.actualDebtAmt : null;
    const chainedRepaid = chainedProbe.swept ? chainedProbe.actualDebtAmt : null;
    const diff = isolatedRepaid !== null && chainedRepaid !== null ? chainedRepaid - isolatedRepaid : null;

    return {
      ...base,
      position_a_tx_status: receiptA.status,
      isolated_status: isolatedProbe.swept ? "swept" : "not-applicable",
      isolated_debt_repaid: isolatedRepaid,
      chained_status: chainedProbe.swept ? "swept" : "not-applicable",
      chained_debt_repaid: chainedRepaid,
      debt_repaid_diff: diff,
      detail:
        "A and B request the IDENTICAL real per-vault-share debt repayment (Fluid's liquidate() is vault-level/tick-based, not per-user, for every vault type including T4) - a real diff here measures real tick consumption, not index drift.",
    };
  } finally {
    fork?.stop();
  }
}

async function syncFluidT4(): Promise<Insertable<ChainedLiquidationResultsTable>[]> {
  console.log("[sync-chained] fluid-t4: searching real T4 vaults for genuinely liquidatable candidates...");
  const candidates = await findT4Candidates();
  console.log(`[sync-chained] fluid-t4: found ${candidates.length} real candidate(s).`);

  const rows: Insertable<ChainedLiquidationResultsTable>[] = [];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const row = await runT4ChainedTest(candidates[i]!, 8900 + i);
      rows.push(row);
    } catch (err) {
      console.warn(`[sync-chained] fluid-t4 candidate ${i} (${candidates[i]!.vault}) failed, skipping:`, redactError(err));
    }
  }
  return rows;
}

// #72: Aave V4's mainnet-fork tier. Scoped deliberately simpler than V3's #37 (position A
// vs. unrelated position B): V4 uses a real target-health-factor liquidation design
// (LiquidationLogic.sol, confirmed from aave/aave-v4's own source, 2026-09-10) rather than
// V3's fixed close-factor - so the genuinely interesting real question here is "does ONE
// real liquidationCall() actually restore a position above the target health factor, the
// way its own design intends," not a second unrelated position's before/after drift. Same
// "isolated vs. chained" shape as Fluid's T2/T3/T4 fork tiers (re-check the SAME real
// position's own state before vs. after its own real mined transaction), not V3's two-
// position shape.
//
// Deliberately does NOT reimplement V4's real debt/collateral-to-liquidate formula
// independently (unlike aaveValidator.ts's computeExpectedMaxLiquidatableDebt for V3) -
// _calculateDebtToTargetHealthFactor/_calculateCollateralToLiquidate depend on live Hub
// share/interest-index state (previewAddByShares/previewRemoveByShares) not independently
// derivable from Spoke-level reads alone. Same principled choice as the
// FluidVaultTicksBranchesResolver decision (docs/decisions.md's 2026-09-06 entry): trust the
// real contract's own dry-run/mined-tx result as ground truth, don't re-derive it externally.
const AAVE_V4_CHAIN_AGENT = getAddress(`0x${"a4".repeat(20)}`);
const AAVE_V4_CANDIDATE_SCAN_LIMIT = 500;
const AAVE_V4_ENRICH_BATCH_SIZE = 20;

const AAVE_V4_SPOKE_READ_ABI = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 riskPremium, uint256 avgCollateralFactor, uint256 healthFactor, uint256 totalCollateralValue, uint256 totalDebtValueRay, uint256 activeCollateralCount, uint256 borrowCount)",
  "function getReserveCount() view returns (uint256)",
  "function getReserve(uint256 reserveId) view returns (address underlying, address hub, uint16 assetId, uint8 decimals, uint24 collateralRisk, uint8 flags, uint32 dynamicConfigKey)",
  "function getUserReserveStatus(uint256 reserveId, address user) view returns (bool usedAsCollateral, bool isBorrowed)",
  "function getUserTotalDebt(uint256 reserveId, address user) view returns (uint256)",
  "function ORACLE() view returns (address)",
]);

const AAVE_V4_ORACLE_READ_ABI = parseAbi([
  "function getReserveSource(uint256 reserveId) view returns (address)",
  "function getReservePrice(uint256 reserveId) view returns (uint256)",
]);

// Real, live-observed fact (2026-09-10): the direct getUserAccountData scan below very often
// finds zero real (user, spoke) pairs with HF<1 at all - a real, healthy sign of a
// competitive liquidation market clearing distressed positions fast, not a bug (fluid-t3/t4
// found zero real candidates in this exact same run too - see docs/decisions.md). Real
// positions constantly hover near the 1.0 boundary though (a live scan found one at HF
// 1.001995 - 0.2% away), so a SMALL fallback shock search on the closest real position keeps
// this tier actually exercisable rather than depending entirely on catching a rare live
// moment. Linear, not binary - the real search space here is tiny (a handful of percent) and
// this only ever needs to run once per sync, unlike sweepMagnitudes()'s wider searches.
const AAVE_V4_SHOCK_FALLBACK_MAX_PCT = 20;

interface AaveV4CandidateInfo {
  spoke: `0x${string}`;
  spokeName: AaveV4SpokeName;
  user: `0x${string}`;
  oracle: `0x${string}`;
  collateralReserveId: bigint;
  collateralAsset: `0x${string}`;
  debtReserveId: bigint;
  debtAsset: `0x${string}`;
  debtAssetDecimals: number;
  debtLegAmount: bigint;
  healthFactor: bigint;
  magnitudePct: number;
  /** Set only when this candidate needed the shock fallback (real HF was >= 1.0 at baseline)
   *  - the collateral reserve's real price-feed source and the shocked price to persistently
   *  override it to, both on the fork and in the isolated/chained dry-run checks. Null for a
   *  candidate that was genuinely already liquidatable with no shock needed. */
  collateralPriceOverride: { source: `0x${string}`; shockedPrice: bigint } | null;
}

async function findReservesForUser(spoke: `0x${string}`, user: `0x${string}`): Promise<{ collateralReserveId: bigint; debtReserveId: bigint } | null> {
  const reserveCount = await publicClient.readContract({ address: spoke, abi: AAVE_V4_SPOKE_READ_ABI, functionName: "getReserveCount" });
  let collateralReserveId: bigint | null = null;
  let debtReserveId: bigint | null = null;
  for (let reserveId = 0n; reserveId < reserveCount; reserveId++) {
    const [usedAsCollateral, isBorrowed] = await publicClient.readContract({ address: spoke, abi: AAVE_V4_SPOKE_READ_ABI, functionName: "getUserReserveStatus", args: [reserveId, user] });
    if (usedAsCollateral && collateralReserveId === null) collateralReserveId = reserveId;
    if (isBorrowed && debtReserveId === null) debtReserveId = reserveId;
    if (collateralReserveId !== null && debtReserveId !== null) break;
  }
  return collateralReserveId !== null && debtReserveId !== null ? { collateralReserveId, debtReserveId } : null;
}

/**
 * Re-reads getUserAccountData with the collateral reserve's real price-feed source
 * temporarily overridden - a plain eth_call + stateOverride, same technique as
 * aaveV4Validator.ts's price overrides, used here just to TEST a candidate magnitude, not to
 * execute anything.
 */
async function healthFactorUnderShock(spoke: `0x${string}`, user: `0x${string}`, source: `0x${string}`, shockedPrice: bigint): Promise<bigint> {
  const calldata = encodeFunctionData({ abi: AAVE_V4_SPOKE_READ_ABI, functionName: "getUserAccountData", args: [user] });
  const raw = await publicClient.call({ to: spoke, data: calldata, stateOverride: [{ address: source, code: buildFixedReturnBytecode(shockedPrice) }] });
  if (!raw.data) throw new Error("getUserAccountData returned no data under shock");
  const decoded = decodeFunctionResult({ abi: AAVE_V4_SPOKE_READ_ABI, functionName: "getUserAccountData", data: raw.data });
  return decoded[2];
}

// Real ISpoke.sol function + event + errors, confirmed from aave/aave-v4's own source
// (2026-09-10) - see aaveV4Validator.ts's own comment for the same real facts (liquidator is
// plain msg.sender, amounts are only ever surfaced via this event since liquidationCall()
// itself returns nothing).
const AAVE_V4_LIQUIDATE_ABI = parseAbi([
  "function liquidationCall(uint256 collateralReserveId, uint256 debtReserveId, address user, uint256 debtToCover, bool receiveShares)",
  "event LiquidationCall(uint256 indexed collateralReserveId, uint256 indexed debtReserveId, address indexed user, address liquidator, bool receiveShares, uint256 debtAmountRestored, uint256 drawnSharesLiquidated, (int256 sharesDelta, int256 offsetRayDelta, uint256 restoredPremiumRay) premiumDelta, uint256 collateralAmountRemoved, uint256 collateralSharesLiquidated, uint256 collateralSharesToLiquidator)",
  "error SelfLiquidation()",
  "error InvalidDebtToCover()",
  "error ReservePaused()",
  "error ReserveNotEnabledAsCollateral()",
  "error ReserveNotSupplied()",
  "error ReserveNotBorrowed()",
  "error HealthFactorNotBelowThreshold()",
  "error MustNotLeaveDust()",
  "error CannotReceiveShares()",
]);

/**
 * Finds one real, currently-liquidatable (right now, no hypothetical shock needed) Aave V4
 * (user, Spoke) pair among the already-discovered candidate pool. Same cheap two-stage shape
 * as aaveV4UserEnrichment.ts's own enrichAaveV4Positions (a getUserAccountData multicall
 * pre-filter before any per-reserve enumeration) - reused here as a fresh LIVE check, not the
 * days-old stored snapshot, since a real fork test needs the position to genuinely be
 * liquidatable at the block the fork actually starts from.
 */
async function findAaveV4Candidate(): Promise<AaveV4CandidateInfo | null> {
  const rows = await db.selectFrom("aave_v4_borrow_candidates").select("address").limit(AAVE_V4_CANDIDATE_SCAN_LIMIT).execute();
  const spokeEntries = Object.entries(AAVE_V4_SPOKES) as [AaveV4SpokeName, `0x${string}`][];
  let lowestHf: { spoke: `0x${string}`; spokeName: AaveV4SpokeName; user: `0x${string}`; healthFactor: bigint } | null = null;

  for (let i = 0; i < rows.length; i += AAVE_V4_ENRICH_BATCH_SIZE) {
    const batch = rows.slice(i, i + AAVE_V4_ENRICH_BATCH_SIZE);
    const contracts = batch.flatMap((r) =>
      spokeEntries.map(([, spoke]) => ({ address: spoke, abi: AAVE_V4_SPOKE_READ_ABI, functionName: "getUserAccountData", args: [r.address as `0x${string}`] }) as const),
    );
    type AccountDataResult =
      | { status: "success"; result: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint] }
      | { status: "failure"; error: Error };
    const results = await multicallWithRateLimitRetry<AccountDataResult>(publicClient, contracts, undefined, "sync-chained-aave-v4");

    for (let bi = 0; bi < batch.length; bi++) {
      for (let si = 0; si < spokeEntries.length; si++) {
        const result = results[bi * spokeEntries.length + si];
        if (!result || result.status !== "success") continue;
        const [, , healthFactorVal, , , , borrowCount] = result.result;
        if (borrowCount === 0n) continue;

        const [spokeName, spoke] = spokeEntries[si]!;
        const user = batch[bi]!.address as `0x${string}`;

        if (healthFactorVal < 1_000_000_000_000_000_000n) {
          // A real, already-liquidatable pair - build and return the candidate directly, no
          // shock needed.
          const reserves = await findReservesForUser(spoke, user);
          if (!reserves) continue; // real but not testable this way - keep scanning
          const oracle = await publicClient.readContract({ address: spoke, abi: AAVE_V4_SPOKE_READ_ABI, functionName: "ORACLE" });
          const [collateralReserve, debtReserve, debtLegAmount] = await Promise.all([
            publicClient.readContract({ address: spoke, abi: AAVE_V4_SPOKE_READ_ABI, functionName: "getReserve", args: [reserves.collateralReserveId] }),
            publicClient.readContract({ address: spoke, abi: AAVE_V4_SPOKE_READ_ABI, functionName: "getReserve", args: [reserves.debtReserveId] }),
            publicClient.readContract({ address: spoke, abi: AAVE_V4_SPOKE_READ_ABI, functionName: "getUserTotalDebt", args: [reserves.debtReserveId, user] }),
          ]);
          if (debtLegAmount === 0n) continue;
          return {
            spoke,
            spokeName,
            user,
            oracle,
            collateralReserveId: reserves.collateralReserveId,
            collateralAsset: collateralReserve[0],
            debtReserveId: reserves.debtReserveId,
            debtAsset: debtReserve[0],
            debtAssetDecimals: debtReserve[3],
            debtLegAmount,
            healthFactor: healthFactorVal,
            magnitudePct: 0,
            collateralPriceOverride: null,
          };
        }

        if (lowestHf === null || healthFactorVal < lowestHf.healthFactor) {
          lowestHf = { spoke, spokeName, user, healthFactor: healthFactorVal };
        }
      }
    }
  }

  // Real, live-observed (2026-09-10): the direct scan above often finds nothing (a real,
  // competitive liquidation market clears distressed positions fast). Fall back to a small
  // shock search on whichever real pair currently sits closest to the threshold, so this
  // tier stays exercisable rather than depending on catching a rare live moment.
  if (!lowestHf) return null;
  const reserves = await findReservesForUser(lowestHf.spoke, lowestHf.user);
  if (!reserves) return null;

  const oracle = await publicClient.readContract({ address: lowestHf.spoke, abi: AAVE_V4_SPOKE_READ_ABI, functionName: "ORACLE" });
  const [collateralReserve, debtReserve, debtLegAmount, realCollateralPrice, source] = await Promise.all([
    publicClient.readContract({ address: lowestHf.spoke, abi: AAVE_V4_SPOKE_READ_ABI, functionName: "getReserve", args: [reserves.collateralReserveId] }),
    publicClient.readContract({ address: lowestHf.spoke, abi: AAVE_V4_SPOKE_READ_ABI, functionName: "getReserve", args: [reserves.debtReserveId] }),
    publicClient.readContract({ address: lowestHf.spoke, abi: AAVE_V4_SPOKE_READ_ABI, functionName: "getUserTotalDebt", args: [reserves.debtReserveId, lowestHf.user] }),
    publicClient.readContract({ address: oracle, abi: AAVE_V4_ORACLE_READ_ABI, functionName: "getReservePrice", args: [reserves.collateralReserveId] }),
    publicClient.readContract({ address: oracle, abi: AAVE_V4_ORACLE_READ_ABI, functionName: "getReserveSource", args: [reserves.collateralReserveId] }),
  ]);
  if (debtLegAmount === 0n) return null;

  for (let pct = 1; pct <= AAVE_V4_SHOCK_FALLBACK_MAX_PCT; pct++) {
    const shockedPrice = (realCollateralPrice * BigInt(100 - pct)) / 100n;
    const shockedHf = await healthFactorUnderShock(lowestHf.spoke, lowestHf.user, source, shockedPrice);
    if (shockedHf < 1_000_000_000_000_000_000n) {
      console.log(`[sync-chained] aave-v4: closest real pair needed a -${pct}% collateral shock to become liquidatable (real HF was ${(Number(lowestHf.healthFactor) / 1e18).toFixed(6)}).`);
      return {
        spoke: lowestHf.spoke,
        spokeName: lowestHf.spokeName,
        user: lowestHf.user,
        oracle,
        collateralReserveId: reserves.collateralReserveId,
        collateralAsset: collateralReserve[0],
        debtReserveId: reserves.debtReserveId,
        debtAsset: debtReserve[0],
        debtAssetDecimals: debtReserve[3],
        debtLegAmount,
        healthFactor: shockedHf,
        magnitudePct: -pct,
        collateralPriceOverride: { source, shockedPrice },
      };
    }
  }
  return null;
}

async function runAaveV4ChainedTest(candidate: AaveV4CandidateInfo, forkPort: number): Promise<Insertable<ChainedLiquidationResultsTable>> {
  const positionId = `aave-v4-${candidate.spokeName}-${candidate.user.toLowerCase()}`;
  const base = {
    protocol: "aave-v4" as const,
    preset_id: "correlated",
    magnitude_pct: candidate.magnitudePct.toString(), // "0" when genuinely liquidatable already; negative when the shock fallback found this candidate
    position_a_id: positionId,
    position_b_id: `${positionId}-recheck`,
    debt_asset_symbol: null as string | null,
    debt_asset_decimals: candidate.debtAssetDecimals,
  };
  const oracleOverridePrices = candidate.collateralPriceOverride
    ? { [candidate.collateralReserveId.toString()]: candidate.collateralPriceOverride.shockedPrice }
    : undefined;

  let fork: AnvilFork | undefined;
  try {
    fork = await startAnvilFork(undefined, forkPort);

    // Persistent price override FIRST, before anything else reads real state on this fork -
    // must be in place for both the isolated dry-run below and the real mined tx to see the
    // SAME shocked price. Only set when this candidate needed the shock fallback (real HF
    // was already < 1.0 for a direct hit - nothing to override).
    if (candidate.collateralPriceOverride) {
      await fork.setCode(candidate.collateralPriceOverride.source, buildFixedReturnBytecode(candidate.collateralPriceOverride.shockedPrice));
    }

    const isolatedProbe = await validateAaveV4Liquidation(fork.publicClient, {
      spoke: candidate.spoke,
      oracle: candidate.oracle,
      user: candidate.user,
      collateralReserveId: candidate.collateralReserveId,
      debtReserveId: candidate.debtReserveId,
      collateralAsset: candidate.collateralAsset,
      debtAsset: candidate.debtAsset,
      healthFactor: candidate.healthFactor, // already the shocked HF when a shock was applied - see findAaveV4Candidate
      debtToCoverRequested: candidate.debtLegAmount,
      oracleOverridePrices,
    });

    // Persistent debt-token funding for the real mined tx, separate from
    // validateAaveV4Liquidation's own ephemeral Multicall3-funded dry-run above - spender is
    // the Spoke (confirmed from Spoke.sol: liquidator is plain msg.sender, and
    // liquidationCall pulls the debt asset via safeTransferFrom(liquidator, hub, ...) called
    // FROM the Spoke, so the ALLOWANCE the ERC20 checks is liquidator -> Spoke).
    const slots = await probeTokenSlots(fork.publicClient, candidate.debtAsset, AAVE_V4_CHAIN_AGENT, candidate.spoke);
    if (!slots) {
      return { ...base, position_a_tx_status: "not-attempted", isolated_status: isolatedProbe.status, isolated_debt_repaid: isolatedProbe.status === "liquidated" ? isolatedProbe.actualDebtRepaid.toString() : null, chained_status: null, chained_debt_repaid: null, debt_repaid_diff: null, detail: `Could not determine ${candidate.debtAsset}'s balance/allowance storage layout - real, disclosed limitation of the slot-probing technique for this token.` };
    }
    const fundedAmount = candidate.debtLegAmount * 1000n + 10n ** 30n;
    const balanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [AAVE_V4_CHAIN_AGENT, BigInt(slots.balanceSlotIndex)]));
    const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [AAVE_V4_CHAIN_AGENT, BigInt(slots.allowanceSlotIndex)]));
    const allowanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [candidate.spoke, ownerSlot]));
    await fork.setStorageAt(candidate.debtAsset, balanceSlot, numberToHex(fundedAmount, { size: 32 }));
    await fork.setStorageAt(candidate.debtAsset, allowanceSlot, numberToHex(fundedAmount, { size: 32 }));

    const wallet = await fork.impersonate(AAVE_V4_CHAIN_AGENT);
    const liquidationCalldataA = encodeFunctionData({
      abi: AAVE_V4_LIQUIDATE_ABI,
      functionName: "liquidationCall",
      args: [candidate.collateralReserveId, candidate.debtReserveId, candidate.user, candidate.debtLegAmount, false],
    });
    const txHashA = await wallet.sendTransaction({ account: AAVE_V4_CHAIN_AGENT, to: candidate.spoke, data: liquidationCalldataA, chain: null, gas: 5_000_000n });
    const receiptA = await fork.publicClient.waitForTransactionReceipt({ hash: txHashA });
    console.log(`[sync-chained] aave-v4 ${positionId}: A's real liquidation ${receiptA.status}, block ${receiptA.blockNumber}`);

    if (receiptA.status !== "success") {
      let revertDetail = "unknown";
      try {
        await fork.publicClient.call({ account: AAVE_V4_CHAIN_AGENT, to: candidate.spoke, data: liquidationCalldataA });
      } catch (simErr) {
        const simData = extractRevertData(simErr);
        if (simData) {
          try {
            const decoded = decodeErrorResult({ abi: AAVE_V4_LIQUIDATE_ABI, data: simData });
            revertDetail = decoded.errorName;
          } catch {
            revertDetail = `undecodable revert data: ${simData.slice(0, 80)}`;
          }
        } else {
          revertDetail = (simErr as Error).message.split("\n")[0]!;
        }
      }
      console.log(`[sync-chained] aave-v4 ${positionId}: revert reason - ${revertDetail}`);
      return { ...base, position_a_tx_status: receiptA.status, isolated_status: isolatedProbe.status, isolated_debt_repaid: isolatedProbe.status === "liquidated" ? isolatedProbe.actualDebtRepaid.toString() : null, chained_status: null, chained_debt_repaid: null, debt_repaid_diff: null, detail: `A's real liquidation reverted on the fork (${revertDetail}) - chaining not testable for this position.` };
    }

    // Real amounts come from the mined tx's own emitted event - liquidationCall() itself
    // returns nothing (confirmed from ISpoke.sol), unlike Aave V3's balance-diff sandwich
    // this replaces for the MINED-tx path specifically (the isolated dry-run above still
    // uses the balance-diff sandwich, since eth_call can't surface event logs the same way).
    let actualDebtRestored: bigint | null = null;
    let actualCollateralRemoved: bigint | null = null;
    for (const log of receiptA.logs) {
      try {
        const decoded = decodeEventLog({ abi: AAVE_V4_LIQUIDATE_ABI, data: log.data, topics: log.topics, eventName: "LiquidationCall" });
        actualDebtRestored = decoded.args.debtAmountRestored;
        actualCollateralRemoved = decoded.args.collateralAmountRemoved;
        break;
      } catch {
        continue; // not the log we're looking for (e.g. an ERC20 Transfer log in the same tx)
      }
    }

    // Real post-mining state - re-fetch health factor live rather than reuse the pre-mining
    // value, since the whole point of this check is whether the mined liquidation actually
    // moved it. A stale HF here would silently make validateAaveV4Liquidation's prefilter
    // wrong regardless of what actually happened on-chain.
    const postAccountData = await fork.publicClient.readContract({ address: candidate.spoke, abi: AAVE_V4_SPOKE_READ_ABI, functionName: "getUserAccountData", args: [candidate.user] });
    const postHealthFactor = postAccountData[2];

    const chainedProbe = await validateAaveV4Liquidation(fork.publicClient, {
      spoke: candidate.spoke,
      oracle: candidate.oracle,
      user: candidate.user,
      collateralReserveId: candidate.collateralReserveId,
      debtReserveId: candidate.debtReserveId,
      collateralAsset: candidate.collateralAsset,
      debtAsset: candidate.debtAsset,
      healthFactor: postHealthFactor,
      debtToCoverRequested: candidate.debtLegAmount,
      oracleOverridePrices,
    });
    console.log(`[sync-chained] aave-v4 ${positionId}: post-liquidation health factor ${(Number(postHealthFactor) / 1e18).toFixed(4)}, chained probe status ${chainedProbe.status}`);

    const isolatedRepaid = isolatedProbe.status === "liquidated" ? isolatedProbe.actualDebtRepaid : null;
    const chainedRepaid = chainedProbe.status === "liquidated" ? chainedProbe.actualDebtRepaid : null;
    const diff = isolatedRepaid !== null && chainedRepaid !== null ? chainedRepaid - isolatedRepaid : null;

    return {
      ...base,
      position_a_tx_status: receiptA.status,
      isolated_status: isolatedProbe.status,
      isolated_debt_repaid: isolatedRepaid,
      chained_status: chainedProbe.status,
      chained_debt_repaid: chainedRepaid,
      debt_repaid_diff: diff,
      detail:
        chainedProbe.status === "not-liquidatable"
          ? `Real mined liquidationCall() restored HF to ${(Number(postHealthFactor) / 1e18).toFixed(4)} (>= 1.0), matching V4's real target-health-factor design (LiquidationConfig.targetHealthFactor) - one real liquidation was enough, unlike V3's fixed close-factor which often needs a second partial liquidation. Real event: ${actualDebtRestored !== null ? `debtAmountRestored=${actualDebtRestored}, collateralAmountRemoved=${actualCollateralRemoved}` : "LiquidationCall event not found in receipt logs"}.`
          : `Real mined liquidationCall() left HF at ${(Number(postHealthFactor) / 1e18).toFixed(4)} (still < 1.0) - the position remained liquidatable after one real liquidation, a genuinely different real outcome from the single-shot-heals-it case. Real event: ${actualDebtRestored !== null ? `debtAmountRestored=${actualDebtRestored}, collateralAmountRemoved=${actualCollateralRemoved}` : "LiquidationCall event not found in receipt logs"}.`,
    };
  } finally {
    fork?.stop();
  }
}

async function syncAaveV4(): Promise<Insertable<ChainedLiquidationResultsTable>[]> {
  console.log("[sync-chained] aave-v4: searching for a real, currently-liquidatable V4 position...");
  const candidate = await findAaveV4Candidate();
  if (!candidate) {
    console.log("[sync-chained] aave-v4: no real currently-liquidatable candidate found.");
    return [];
  }
  console.log(`[sync-chained] aave-v4: found real candidate aave-v4-${candidate.spokeName}-${candidate.user} (HF ${(Number(candidate.healthFactor) / 1e18).toFixed(4)}).`);

  try {
    return [await runAaveV4ChainedTest(candidate, 9000)];
  } catch (err) {
    console.warn("[sync-chained] aave-v4 candidate failed, skipping:", redactError(err));
    return [];
  }
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

  let fluidT2Rows: Insertable<ChainedLiquidationResultsTable>[] = [];
  try {
    fluidT2Rows = await syncFluidT2();
  } catch (err) {
    console.warn("[sync-chained] fluid-t2 sync failed entirely, writing zero fluid-t2 rows:", redactError(err));
  }

  let fluidT3Rows: Insertable<ChainedLiquidationResultsTable>[] = [];
  try {
    fluidT3Rows = await syncFluidT3();
  } catch (err) {
    console.warn("[sync-chained] fluid-t3 sync failed entirely, writing zero fluid-t3 rows:", redactError(err));
  }

  let fluidT4Rows: Insertable<ChainedLiquidationResultsTable>[] = [];
  try {
    fluidT4Rows = await syncFluidT4();
  } catch (err) {
    console.warn("[sync-chained] fluid-t4 sync failed entirely, writing zero fluid-t4 rows:", redactError(err));
  }

  let aaveV4Rows: Insertable<ChainedLiquidationResultsTable>[] = [];
  try {
    aaveV4Rows = await syncAaveV4();
  } catch (err) {
    console.warn("[sync-chained] aave-v4 sync failed entirely, writing zero aave-v4 rows:", redactError(err));
  }

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("chained_liquidation_results").where("protocol", "=", "aave").execute();
    if (aaveRows.length > 0) await trx.insertInto("chained_liquidation_results").values(aaveRows).execute();
    await trx.deleteFrom("chained_liquidation_results").where("protocol", "=", "fluid").execute();
    if (fluidRows.length > 0) await trx.insertInto("chained_liquidation_results").values(fluidRows).execute();
    await trx.deleteFrom("chained_liquidation_results").where("protocol", "=", "fluid-t2").execute();
    if (fluidT2Rows.length > 0) await trx.insertInto("chained_liquidation_results").values(fluidT2Rows).execute();
    await trx.deleteFrom("chained_liquidation_results").where("protocol", "=", "fluid-t3").execute();
    if (fluidT3Rows.length > 0) await trx.insertInto("chained_liquidation_results").values(fluidT3Rows).execute();
    await trx.deleteFrom("chained_liquidation_results").where("protocol", "=", "fluid-t4").execute();
    if (fluidT4Rows.length > 0) await trx.insertInto("chained_liquidation_results").values(fluidT4Rows).execute();
    await trx.deleteFrom("chained_liquidation_results").where("protocol", "=", "aave-v4").execute();
    if (aaveV4Rows.length > 0) await trx.insertInto("chained_liquidation_results").values(aaveV4Rows).execute();
  });
  console.log(`[sync-chained] wrote ${aaveRows.length} aave row(s), ${fluidRows.length} fluid row(s), ${fluidT2Rows.length} fluid-t2 row(s), ${fluidT3Rows.length} fluid-t3 row(s), ${fluidT4Rows.length} fluid-t4 row(s), ${aaveV4Rows.length} aave-v4 row(s).`);

  await db.destroy();
}

main().catch(async (err) => {
  console.error(redactError(err));
  await db.destroy();
  process.exitCode = 1;
});
