import type { Address as ViemAddress, PublicClient } from "viem";
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, decodeErrorResult, keccak256, encodeAbiParameters, numberToHex, parseAbi } from "viem";
import { buildFixedReturnBytecode } from "./stateOverride.js";
import { probeTokenSlots } from "./slotProbe.js";

// Real Multicall3 - see aaveValidator.ts's own comment for why this address is trusted
// (deployed identically across virtually every EVM chain via a deterministic CREATE2
// factory, confirmed to have real deployed code before use).
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const MULTICALL3_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

// Real ISpoke.sol / LiquidationLogic.sol errors, confirmed from aave/aave-v4's own source
// (github.com/aave/aave-v4, 2026-09-10) - not guessed at or ported from V3, since V4's real
// custom errors are genuinely different names/conditions (e.g. MustNotLeaveDust here is
// triggered by the CALLER's debtToCover being too small to avoid dust, not the same trigger
// shape as V3's dust rule).
const SPOKE_ABI = parseAbi([
  "function liquidationCall(uint256 collateralReserveId, uint256 debtReserveId, address user, uint256 debtToCover, bool receiveShares)",
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

const ERC20_BALANCE_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

// Real per-reserve price feed lookup, confirmed from AaveOracle.sol - unlike V3's single
// shared AaveOracle contract (getAssetPrice, one price per call but ONE contract for every
// asset), V4's real getReserveSource(reserveId) already routes each reserve through its OWN
// distinct IPriceFeed contract, the same "override the feed, not the oracle" shape V3 needed
// getSourceOfAsset for - here it's just already reserve-scoped by construction.
const ORACLE_ABI = parseAbi(["function getReserveSource(uint256 reserveId) view returns (address)"]);

// liquidationCall()'s real `liquidator` is plain `msg.sender` (confirmed from Spoke.sol) -
// since Multicall3 calls it directly (not via delegatecall), the Spoke sees Multicall3's own
// address as the caller. Funding any other synthetic address would leave the override
// invisible to the real call, the same real finding V3's validator already made.
const LIQUIDATOR_IDENTITY = MULTICALL3_ADDRESS;

const ERROR_STRING_SELECTOR = "0x08c379a0"; // Error(string) - not expected from V4's require(cond, CustomError()) style, kept as a defensive fallback only.

function decodeSpokeRevert(data: `0x${string}`): string {
  try {
    const decoded = decodeErrorResult({ abi: SPOKE_ABI, data });
    return decoded.errorName;
  } catch {
    // fall through
  }
  if (data.slice(0, 10) === ERROR_STRING_SELECTOR) {
    try {
      const [reason] = decodeAbiParameters([{ type: "string" }], `0x${data.slice(10)}`);
      return `Error("${reason}")`;
    } catch {
      // fall through
    }
  }
  return data;
}

export type AaveV4ValidationResult =
  | { status: "not-liquidatable"; reason: "health-factor-above-one" }
  | { status: "unable-to-validate"; reason: string }
  | { status: "liquidated"; actualDebtRepaid: bigint; actualCollateralSeized: bigint }
  | { status: "unexpected-revert"; rawError: string };

export interface ValidateAaveV4LiquidationParams {
  spoke: ViemAddress;
  oracle: ViemAddress;
  user: ViemAddress;
  collateralReserveId: bigint;
  debtReserveId: bigint;
  collateralAsset: ViemAddress;
  debtAsset: ViemAddress;
  /** Real current health factor (WAD) - the same cheap prefilter V3's validator does before
   *  spending a real call on a position that plainly isn't liquidatable. */
  healthFactor: bigint;
  /** Full real debt-leg amount, passed as debtToCover and let the real contract cap it down
   *  internally via its own target-health-factor + dust logic - V4's real
   *  _calculateDebtToTargetHealthFactor/_calculateCollateralToLiquidate depend on live Hub
   *  share/interest-index state this validator does not (and should not) try to
   *  independently re-derive; the real call is the only trustworthy source for "how much
   *  actually gets liquidated," not a formula ported from source. */
  debtToCoverRequested: bigint;
  /** Optional: reserveId -> hypothetical USD8 price, for the (currently unused in the MVP
   *  candidate path, since a real always-liquidatable position was found at zero shock) case
   *  of testing a position that only becomes liquidatable under a hypothetical shock. */
  oracleOverridePrices?: Record<string, bigint>;
}

/**
 * Checks whether a real liquidationCall() against a real deployed Aave V4 Spoke succeeds
 * right now (or at a hypothetical overridden price) - one real eth_call, no fork, no mined
 * transaction, nothing persists. Mirrors aaveValidator.ts's validateAaveLiquidation shape
 * (same Multicall3 balance-diff sandwich, same LIQUIDATOR_IDENTITY reasoning) adapted for
 * V4's real reserveId-keyed calls, per-reserve oracle sources, and Spoke-as-approval-spender
 * funding target.
 */
export async function validateAaveV4Liquidation(
  client: PublicClient,
  params: ValidateAaveV4LiquidationParams,
): Promise<AaveV4ValidationResult> {
  const { spoke, oracle, user, collateralReserveId, debtReserveId, collateralAsset, debtAsset, healthFactor, debtToCoverRequested, oracleOverridePrices } =
    params;

  if (healthFactor >= 1_000_000_000_000_000_000n) {
    return { status: "not-liquidatable", reason: "health-factor-above-one" };
  }

  const slots = await probeTokenSlots(client, debtAsset, LIQUIDATOR_IDENTITY, spoke);
  if (!slots) {
    return { status: "unable-to-validate", reason: `Could not determine ${debtAsset}'s balance/allowance storage layout within the probed range` };
  }

  // Fund generously - large enough to cover any real debtToCover, an obviously-synthetic
  // amount never mistaken for a real balance.
  const fundedAmount = debtToCoverRequested * 1000n + 10n ** 30n;
  const balanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [LIQUIDATOR_IDENTITY, BigInt(slots.balanceSlotIndex)]));
  const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [LIQUIDATOR_IDENTITY, BigInt(slots.allowanceSlotIndex)]));
  const allowanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spoke, ownerSlot]));

  const priceFeedOverrides: { address: ViemAddress; code: `0x${string}` }[] = [];
  for (const [reserveIdStr, price] of Object.entries(oracleOverridePrices ?? {})) {
    const source = await client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "getReserveSource", args: [BigInt(reserveIdStr)] });
    priceFeedOverrides.push({ address: source, code: buildFixedReturnBytecode(price) });
  }

  const balanceOfCalldata = (account: ViemAddress) => encodeFunctionData({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [account] });

  const liquidationCalldata = encodeFunctionData({
    abi: SPOKE_ABI,
    functionName: "liquidationCall",
    args: [collateralReserveId, debtReserveId, user, debtToCoverRequested, false],
  });

  const calls = [
    { target: debtAsset, allowFailure: false, callData: balanceOfCalldata(LIQUIDATOR_IDENTITY) }, // 0: debt balance before
    { target: spoke, allowFailure: true, callData: liquidationCalldata }, // 1: the real liquidation
    { target: debtAsset, allowFailure: false, callData: balanceOfCalldata(LIQUIDATOR_IDENTITY) }, // 2: debt balance after
    { target: collateralAsset, allowFailure: false, callData: balanceOfCalldata(LIQUIDATOR_IDENTITY) }, // 3: collateral balance after
  ];

  const raw = await client.call({
    to: MULTICALL3_ADDRESS,
    data: encodeFunctionData({ abi: MULTICALL3_ABI, functionName: "aggregate3", args: [calls] }),
    stateOverride: [
      ...priceFeedOverrides,
      { address: debtAsset, stateDiff: [{ slot: balanceSlot, value: numberToHex(fundedAmount, { size: 32 }) }, { slot: allowanceSlot, value: numberToHex(fundedAmount, { size: 32 }) }] },
    ],
  });

  if (!raw.data) {
    return { status: "unable-to-validate", reason: "Multicall3 aggregate3 call returned no data" };
  }

  const results = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", data: raw.data });

  const liquidationResult = results[1];
  if (!liquidationResult?.success) {
    const revertData = liquidationResult?.returnData ?? "0x";
    return { status: "unexpected-revert", rawError: decodeSpokeRevert(revertData) };
  }

  const debtBefore = decodeFunctionResult({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", data: results[0]!.returnData });
  const debtAfter = decodeFunctionResult({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", data: results[2]!.returnData });
  const collateralAfter = decodeFunctionResult({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", data: results[3]!.returnData });

  return {
    status: "liquidated",
    actualDebtRepaid: debtBefore - debtAfter,
    actualCollateralSeized: collateralAfter, // liquidator started with 0 collateral balance
  };
}

export { SPOKE_ABI as AAVE_V4_SPOKE_LIQUIDATION_ABI, decodeSpokeRevert, LIQUIDATOR_IDENTITY as AAVE_V4_VALIDATOR_LIQUIDATOR_IDENTITY };
