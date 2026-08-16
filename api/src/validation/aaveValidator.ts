import type { Address as ViemAddress, PublicClient } from "viem";
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, keccak256, encodeAbiParameters, numberToHex, parseAbi } from "viem";
import { buildFixedReturnBytecode } from "./stateOverride.js";
import { probeTokenSlots } from "./slotProbe.js";
import { healthFactor } from "../engine/healthFactor.js";
import type { Position, PriceVector } from "../engine/types.js";

// Real Multicall3, deployed identically across virtually every EVM chain via a
// deterministic CREATE2 factory - confirmed to have real deployed code on mainnet before
// use, not trusted from memory alone (docs/decisions.md's #30 entry).
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const MULTICALL3_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

const POOL_ABI = parseAbi([
  "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)",
]);

const ERC20_BALANCE_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

// AaveOracle.getAssetPrice(asset) is ONE shared contract serving every reserve's price -
// overriding ITS bytecode would corrupt every other asset's price too, and Aave's own
// close-factor check sums the borrower's TOTAL debt across every reserve (verified this
// session against LiquidationLogic.sol), so other reserves' real prices have to stay
// intact. Each asset instead routes through its own distinct feed contract
// (getSourceOfAsset(asset), confirmed live against real WETH - a real, separate address
// with real code) - overriding THAT per-asset feed shocks exactly one asset's price and
// leaves every other reserve's real price untouched.
const ORACLE_SOURCE_ABI = parseAbi(["function getSourceOfAsset(address asset) view returns (address)"]);

// Verified against the real, deployed LiquidationLogic.sol this session (docs/decisions.md).
const DEFAULT_LIQUIDATION_CLOSE_FACTOR_BPS = 5000n; // 50.00%
const CLOSE_FACTOR_HF_THRESHOLD = 950_000_000_000_000_000n; // 0.95e18
const MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD = 200_000_000_000n; // $2,000 in 8-decimal base currency

// The funded "liquidator" identity MUST be Multicall3's own address, not an arbitrary
// synthetic one - real, on-chain-confirmed finding (docs/decisions.md's #30 entry).
// liquidationCall() derives params.liquidator from _msgSender(), and since Multicall3
// calls liquidationCall() directly inside aggregate3 (not via delegatecall), the Pool sees
// Multicall3's address as the caller, not whatever address we'd like to pretend is the
// liquidator. Funding a separate synthetic address passed every isolated balance/allowance
// check (both individually and inside the same bundle right before the call) while the
// real liquidationCall still reverted with "ERC20: transfer amount exceeds allowance" -
// confirmed via a bundle that read balance/allowance immediately before the call and got
// back the correct funded values, proving the override itself wasn't the problem.
const LIQUIDATOR_IDENTITY = MULTICALL3_ADDRESS;

// Real Aave V3 custom-error selectors, confirmed live this session by computing
// keccak256("HealthFactorNotBelowThreshold()") and matching it exactly against a real
// revert this validator hit (aave-0xa189fea7...) - a legitimate real outcome (a race between
// this script's own HF prefilter and the real on-chain state at call time - not pinned to
// one shared block, see the block-number comment in validate-aave-liquidation.ts), not a
// validator bug. Only entries actually confirmed this way are named here - an unrecognized
// selector is reported as-is (below), never guessed at.
const POOL_ERROR_NAMES: Record<string, string> = {
  "0x930bb771": "HealthFactorNotBelowThreshold (position's real on-chain HF wasn't actually below 1 at call time)",
  // Identified during #43 (previously an unidentified selector reported honestly since
  // #30 - docs/decisions.md): keccak256("MustNotLeaveDust()"), confirmed by exact match.
  // Real Aave rule (found during earlier #38 scoping research, not yet implemented in
  // computeExpectedMaxLiquidatableDebt above): a liquidation must fully clear debt, fully
  // clear collateral, or leave >=$1,000 of both - this formula only implements the close-
  // factor and collateral-availability caps, so at deep shock magnitudes it can compute a
  // debtToCover that leaves a dust remainder the real contract rejects. Disclosed, not
  // silently worked around - see #43's decisions.md entry for the real occurrence rate.
  "0xb629b0e4": "MustNotLeaveDust (real Aave dust-avoidance rule, not yet modeled in computeExpectedMaxLiquidatableDebt)",
};
const ERROR_STRING_SELECTOR = "0x08c379a0"; // Error(string) - Aave's older require()-with-code reverts (e.g. "35")

/** Best-effort revert decode: real Aave custom errors get a real name, `Error(string)`
 *  reverts (Aave's numbered require() codes) get their string, anything else is reported as
 *  the raw selector rather than silently swallowed - same discipline as fluidValidator.ts's
 *  VAULT_ERROR_NAMES fallback. */
function decodeAaveRevert(data: `0x${string}`): string {
  const selector = data.slice(0, 10);
  const named = POOL_ERROR_NAMES[selector];
  if (named) return named;
  if (selector === ERROR_STRING_SELECTOR) {
    try {
      const [reason] = decodeAbiParameters([{ type: "string" }], `0x${data.slice(10)}`);
      return `Error("${reason}")`;
    } catch {
      // fall through to raw
    }
  }
  return data;
}

export type AaveValidationResult =
  | { status: "not-liquidatable"; reason: "health-factor-above-one" }
  | { status: "unable-to-validate"; reason: string }
  | {
      status: "liquidated";
      expectedDebtRepaid: bigint;
      actualDebtRepaid: bigint;
      actualCollateralSeized: bigint;
      matchesExpectation: boolean;
    }
  | { status: "unexpected-revert"; rawError: string };

function toBaseCurrency(amount: bigint, priceUsd8: bigint, decimals: number, roundUp: boolean): bigint {
  const divisor = 10n ** BigInt(decimals);
  if (roundUp) return (amount * priceUsd8 + divisor - 1n) / divisor;
  return (amount * priceUsd8) / divisor;
}

/**
 * Mirrors Aave's real executeLiquidationCall() close-factor logic exactly (verified against
 * LiquidationLogic.sol this session) - computed independently of the real on-chain call, so
 * there's something genuine to compare its actual output against. Per-reserve-pair, not
 * position-total, per the real source (vars.borrowerReserveCollateralInBaseCurrency /
 * DebtInBaseCurrency).
 */
export function computeExpectedMaxLiquidatableDebt(
  position: Position,
  prices: PriceVector,
  collateralAsset: string,
  debtAsset: string,
  /** Raw Aave form, e.g. 10500n = 105% = a 5% bonus - NOT Position.liquidationIncentiveBps,
   *  which stores the bonus-only part (500n) and may reflect a different, "dominant" leg
   *  than the specific collateralAsset being checked here. Source from
   *  AaveReserveConfig.liquidationBonusRaw for the actual reserve involved. */
  liquidationBonusRaw: bigint,
): bigint | null {
  const collateralLeg = position.collateral.find((c) => c.asset === collateralAsset);
  const debtLeg = position.debt.find((d) => d.asset === debtAsset);
  if (!collateralLeg || !debtLeg) return null;

  const collateralPrice = prices[collateralAsset];
  const debtPrice = prices[debtAsset];
  if (collateralPrice === undefined || debtPrice === undefined) return null;

  const hf = healthFactor(position, prices);
  if (hf === null || hf >= 1_000_000_000_000_000_000n) return null; // not liquidatable at all

  const reserveCollateralInBaseCurrency = toBaseCurrency(collateralLeg.amount, collateralPrice, collateralLeg.decimals, false);
  const reserveDebtInBaseCurrency = toBaseCurrency(debtLeg.amount, debtPrice, debtLeg.decimals, true);
  const totalDebtInBaseCurrency = position.debt.reduce((sum, leg) => {
    const price = prices[leg.asset];
    return price === undefined ? sum : sum + toBaseCurrency(leg.amount, price, leg.decimals, true);
  }, 0n);

  const closeFactorApplies =
    reserveCollateralInBaseCurrency >= MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD &&
    reserveDebtInBaseCurrency >= MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD &&
    hf > CLOSE_FACTOR_HF_THRESHOLD;

  const debtUnit = 10n ** BigInt(debtLeg.decimals);
  const collateralUnit = 10n ** BigInt(collateralLeg.decimals);

  let closeFactorLimitedDebt = debtLeg.amount;
  if (closeFactorApplies) {
    const defaultLiquidatableDebtInBaseCurrency = (totalDebtInBaseCurrency * DEFAULT_LIQUIDATION_CLOSE_FACTOR_BPS) / 10_000n;
    if (reserveDebtInBaseCurrency > defaultLiquidatableDebtInBaseCurrency) {
      closeFactorLimitedDebt = (defaultLiquidatableDebtInBaseCurrency * debtUnit) / debtPrice;
    }
  }

  // Second, independent cap (verified against LiquidationLogic.sol's
  // _calculateAvailableCollateralToLiquidate this session): even if the close factor
  // allows liquidating closeFactorLimitedDebt, the borrower might not HAVE enough
  // collateral in this specific reserve to cover it once converted through price + bonus -
  // real Aave clamps down to whatever collateral actually exists, working the debt amount
  // back out from that. Missing this is exactly what made the first real validator run
  // mismatch - the close-factor cap alone isn't the whole story.
  const baseCollateral = (debtPrice * closeFactorLimitedDebt * collateralUnit) / (collateralPrice * debtUnit);
  const maxCollateralToLiquidate = (baseCollateral * liquidationBonusRaw) / 10_000n; // percentMulFloor

  if (maxCollateralToLiquidate <= collateralLeg.amount) {
    return closeFactorLimitedDebt;
  }

  // percentDivCeil: ceil(collateralAmount-equivalent-debt * 10000 / liquidationBonusRaw)
  const numerator = (collateralPrice * collateralLeg.amount * debtUnit) / (debtPrice * collateralUnit);
  return (numerator * 10_000n + liquidationBonusRaw - 1n) / liquidationBonusRaw;
}

/**
 * Shared by validateAaveLiquidation (via Multicall3) and estimateAaveLiquidationGas (direct
 * estimateGas, no Multicall3 wrapper) - both need the identical price-feed + debt-token
 * overrides, and building them twice risked the two functions silently drifting apart.
 */
async function buildAaveOverrides(
  client: PublicClient,
  oracle: ViemAddress,
  oracleOverridePrices: Record<string, bigint>,
  debtAsset: ViemAddress,
  poolAddress: ViemAddress,
  fundedAmount: bigint,
): Promise<{ priceFeedOverrides: { address: ViemAddress; code: `0x${string}` }[]; tokenOverride: { address: ViemAddress; stateDiff: { slot: `0x${string}`; value: `0x${string}` }[] } } | null> {
  const slots = await probeTokenSlots(client, debtAsset, LIQUIDATOR_IDENTITY, poolAddress);
  if (!slots) return null;

  const balanceSlot = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [LIQUIDATOR_IDENTITY, BigInt(slots.balanceSlotIndex)]),
  );
  const ownerSlot = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [LIQUIDATOR_IDENTITY, BigInt(slots.allowanceSlotIndex)]),
  );
  const allowanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [poolAddress, ownerSlot]));

  const priceFeedOverrides: { address: ViemAddress; code: `0x${string}` }[] = [];
  for (const [asset, price] of Object.entries(oracleOverridePrices)) {
    const source = await client.readContract({
      address: oracle,
      abi: ORACLE_SOURCE_ABI,
      functionName: "getSourceOfAsset",
      args: [asset as ViemAddress],
    });
    priceFeedOverrides.push({ address: source, code: buildFixedReturnBytecode(price) });
  }

  return {
    priceFeedOverrides,
    tokenOverride: {
      address: debtAsset,
      stateDiff: [
        { slot: balanceSlot, value: numberToHex(fundedAmount, { size: 32 }) },
        { slot: allowanceSlot, value: numberToHex(fundedAmount, { size: 32 }) },
      ],
    },
  };
}

export interface ValidateAaveLiquidationParams {
  position: Position;
  shockedPrices: PriceVector;
  /** 8-decimal USD prices, keyed the same way as shockedPrices - what the real oracle
   *  contracts get overridden to return, one entry per asset actually being shocked. */
  oracleOverridePrices: Record<string, bigint>;
  collateralAsset: ViemAddress;
  debtAsset: ViemAddress;
  /** Raw Aave form (e.g. 10500n = 105%), from AaveReserveConfig.liquidationBonusRaw for
   *  this specific collateral reserve - see computeExpectedMaxLiquidatableDebt's comment. */
  collateralLiquidationBonusRaw: bigint;
  dataProvider: ViemAddress;
  oracle: ViemAddress;
}

/**
 * Checks whether a real liquidationCall() against Aave's actual deployed Pool, at a
 * hypothetical shocked price, matches what our engine's Level 2 bad-debt approximation
 * predicts. RPC-only - one real eth_call, no fork, no mined transaction, nothing persists.
 */
export async function validateAaveLiquidation(
  client: PublicClient,
  poolAddress: ViemAddress,
  params: ValidateAaveLiquidationParams,
): Promise<AaveValidationResult> {
  const { position, shockedPrices, oracleOverridePrices, collateralAsset, debtAsset, collateralLiquidationBonusRaw, dataProvider, oracle } =
    params;

  const debtLeg = position.debt.find((d) => d.asset === debtAsset);
  if (!debtLeg) {
    return { status: "unable-to-validate", reason: `Position has no debt leg for asset ${debtAsset}` };
  }

  const expectedDebtRepaid = computeExpectedMaxLiquidatableDebt(
    position,
    shockedPrices,
    collateralAsset,
    debtAsset,
    collateralLiquidationBonusRaw,
  );
  if (expectedDebtRepaid === null) {
    return { status: "not-liquidatable", reason: "health-factor-above-one" };
  }

  // Fund generously - large enough to cover any real debtToCover, an obviously-synthetic
  // amount never mistaken for a real balance.
  const fundedAmount = debtLeg.amount * 1000n + 10n ** 30n;

  const overrides = await buildAaveOverrides(client, oracle, oracleOverridePrices, debtAsset, poolAddress, fundedAmount);
  if (!overrides) {
    return {
      status: "unable-to-validate",
      reason: `Could not determine ${debtAsset}'s balance/allowance storage layout within the probed range`,
    };
  }
  const { priceFeedOverrides, tokenOverride } = overrides;

  const balanceOfCalldata = (account: ViemAddress) =>
    encodeFunctionData({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [account] });

  const liquidationCalldata = encodeFunctionData({
    abi: POOL_ABI,
    functionName: "liquidationCall",
    args: [collateralAsset, debtAsset, position.user as ViemAddress, debtLeg.amount, false],
  });

  const calls = [
    { target: debtAsset, allowFailure: false, callData: balanceOfCalldata(LIQUIDATOR_IDENTITY) }, // 0: debt balance before
    { target: poolAddress, allowFailure: true, callData: liquidationCalldata }, // 1: the real liquidation
    { target: debtAsset, allowFailure: false, callData: balanceOfCalldata(LIQUIDATOR_IDENTITY) }, // 2: debt balance after
    { target: collateralAsset, allowFailure: false, callData: balanceOfCalldata(LIQUIDATOR_IDENTITY) }, // 3: collateral balance after
  ];

  const raw = await client.call({
    to: MULTICALL3_ADDRESS,
    data: encodeFunctionData({ abi: MULTICALL3_ABI, functionName: "aggregate3", args: [calls] }),
    stateOverride: [...priceFeedOverrides, tokenOverride],
  });

  if (!raw.data) {
    return { status: "unable-to-validate", reason: "Multicall3 aggregate3 call returned no data" };
  }

  const results = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", data: raw.data });

  const liquidationResult = results[1];
  if (!liquidationResult?.success) {
    const revertData = liquidationResult?.returnData ?? "0x";
    return { status: "unexpected-revert", rawError: decodeAaveRevert(revertData) };
  }

  const debtBefore = decodeFunctionResult({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", data: results[0]!.returnData });
  const debtAfter = decodeFunctionResult({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", data: results[2]!.returnData });
  const collateralAfter = decodeFunctionResult({
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    data: results[3]!.returnData,
  });

  const actualDebtRepaid = debtBefore - debtAfter;
  const actualCollateralSeized = collateralAfter; // liquidator started with 0 collateral balance

  return {
    status: "liquidated",
    expectedDebtRepaid,
    actualDebtRepaid,
    actualCollateralSeized,
    matchesExpectation: actualDebtRepaid === expectedDebtRepaid,
  };
}

export interface EstimateAaveLiquidationGasParams {
  position: Position;
  oracleOverridePrices: Record<string, bigint>;
  collateralAsset: ViemAddress;
  debtAsset: ViemAddress;
  debtToCover: bigint;
  oracle: ViemAddress;
}

export type EstimateAaveGasResult = { status: "estimated"; gasUsed: bigint } | { status: "unable-to-estimate"; reason: string };

/**
 * #43: a REAL eth_estimateGas for liquidationCall() - deliberately NOT routed through
 * Multicall3 (unlike validateAaveLiquidation's correctness check), since a real liquidator
 * bot calls the Pool directly and Multicall3's own call overhead would inflate the number.
 * Reuses the identical price-feed + debt-token overrides validateAaveLiquidation builds,
 * via the shared buildAaveOverrides helper, so the two never silently diverge.
 */
export async function estimateAaveLiquidationGas(
  client: PublicClient,
  poolAddress: ViemAddress,
  params: EstimateAaveLiquidationGasParams,
): Promise<EstimateAaveGasResult> {
  const { position, oracleOverridePrices, collateralAsset, debtAsset, debtToCover, oracle } = params;

  const fundedAmount = debtToCover * 1000n + 10n ** 30n;
  const overrides = await buildAaveOverrides(client, oracle, oracleOverridePrices, debtAsset, poolAddress, fundedAmount);
  if (!overrides) {
    return { status: "unable-to-estimate", reason: `Could not determine ${debtAsset}'s balance/allowance storage layout` };
  }
  const { priceFeedOverrides, tokenOverride } = overrides;

  const liquidationCalldata = encodeFunctionData({
    abi: POOL_ABI,
    functionName: "liquidationCall",
    args: [collateralAsset, debtAsset, position.user as ViemAddress, debtToCover, false],
  });

  try {
    const gasUsed = await client.estimateGas({
      account: LIQUIDATOR_IDENTITY,
      to: poolAddress,
      data: liquidationCalldata,
      stateOverride: [...priceFeedOverrides, tokenOverride],
    });
    return { status: "estimated", gasUsed };
  } catch (err) {
    // Same real gap fluidValidator.ts's extractRevertData exists to close - viem's
    // estimateGas error nests the raw revert bytes at varying depths, and the top-level
    // .message alone ("Execution reverted for an unknown reason") hides the actual reason
    // (a real Aave custom error, or Error(string)) that would otherwise be decodable.
    const data = extractRevertDataFromError(err);
    const reason = data ? decodeAaveRevert(data) : err instanceof Error ? err.message.split("\n")[0]! : String(err);
    return { status: "unable-to-estimate", reason };
  }
}

function extractRevertDataFromError(err: unknown): `0x${string}` | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  let current: unknown = err;
  for (let i = 0; i < 6 && current; i++) {
    if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, unknown>;
      if (typeof obj.data === "string" && obj.data.startsWith("0x") && obj.data.length > 2) {
        return obj.data as `0x${string}`;
      }
      current = obj.cause;
    } else {
      break;
    }
  }
  return undefined;
}
