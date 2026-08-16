import type { Address as ViemAddress, PublicClient } from "viem";
import { parseAbi, encodeFunctionData, decodeErrorResult, numberToHex, keccak256, encodeAbiParameters } from "viem";
import { buildFixedReturnBytecode, buildFixedTupleReturnBytecode } from "./stateOverride.js";
import { probeTokenSlots } from "./slotProbe.js";

// Same real, canonical Multicall3 as aaveValidator.ts (confirmed real deployed code this
// session, docs/decisions.md's #30 entry) - used here as both caller and to_ for #43's real
// gas-estimation call, matching the exact combination confirmed live to succeed (real,
// decoded, non-reverting (actualDebtAmt_, actualColAmt_) return - see docs/decisions.md's
// #43 scoping entry).
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

// Confirmed live against 44 of 95 real unique vault oracles this session (docs/decisions.md
// #30 entry) - a vault's Configs.oracle is a FluidGenericOracle combining up to 5 "hops"
// from Chainlink/Redstone (market price) or a nested IFluidOracle (potentially a
// FluidCappedRate instance - the "Fluid"/"FluidDebt" source types). This is the real
// mechanism behind Thrilok's guidance: market shocks target Chainlink/Redstone hops
// directly (no capping involved, ever); LST-depeg shocks target the nested Fluid-type hop,
// after confirming it's actually a CappedRate instance.
const HOPS_ABI = parseAbi([
  "function getOracleHopSources() view returns ((address source, bool invertRate, uint256 multiplier, uint256 divisor, uint8 sourceType)[] sources_)",
]);

const CONFIG_DATA_ABI = parseAbi([
  "function configData() view returns (address liquidity_, uint16 minUpdateDiffPercent_, uint24 minHeartbeat_, uint40 lastUpdateTime_, address rateSource_, bool invertCenterPrice_, bool avoidForcedLiquidationsCol_, bool avoidForcedLiquidationsDebt_, uint256 maxAPRPercent_, uint24 maxDownFromMaxReachedPercentCol_, uint24 maxDownFromMaxReachedPercentDebt_, uint256 maxDebtUpCapPercent_)",
]);

const LIQUIDATE_ABI = parseAbi([
  "function liquidate(uint256 debtAmt_, uint256 colPerUnitDebt_, address to_, bool absorb_) payable returns (uint256 actualDebtAmt_, uint256 actualColAmt_)",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  // Fluid's real generic vault error - a single error type parameterized by a numeric ID
  // (contracts/protocols/vault/errorTypes.sol), not a distinct Solidity error per case.
  "error FluidVaultError(uint256 errorId_)",
]);

// Real error IDs relevant to liquidate() specifically, verified against the real
// errorTypes.sol this session - named here so a raw numeric ID isn't reported unexplained.
const VAULT_ERROR_NAMES: Record<number, string> = {
  31007: "Vault__TopTickDoesNotExist",
  31008: "Vault__InvalidMsgValueLiquidate",
  31009: "Vault__ExcessSlippageLiquidation",
  31022: "Vault__InvalidLiquidationAmt",
  31024: "Vault__BranchDebtTooLow",
  31029: "Vault__InvalidLiquidation (actualDebtAmt_ rounded to zero - nothing real to liquidate at this magnitude)",
  31032: "Vault__LiquidationReverts",
  31033: "Vault__InvalidOraclePrice",
};

// GenericOracleStructs.SourceType enum order, verified against real source this session.
const SOURCE_TYPE_FLUID = 0;
const SOURCE_TYPE_REDSTONE = 1;
const SOURCE_TYPE_CHAINLINK = 2;
const SOURCE_TYPE_FLUID_DEBT = 4;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// Real dead-address constant liquidate() checks for its built-in dry-run mode.
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

// fluidCappedRate.sol's Slot0 { uint168 rate; uint40 lastUpdateTime; uint8 flags;
// uint24 minHeartbeat; uint16 minUpdateDiffPercent; } - tightly packed into one 32-byte
// slot, `rate` declared first so it occupies the low 168 bits. Confirmed live this session:
// decoding storage slot 0 this way reproduced getExchangeRateLiquidate()'s real value
// exactly, and overriding just this masked portion (preserving the other packed fields)
// correctly propagated through the outer oracle too.
const SLOT0_KEY = numberToHex(0n, { size: 32 });
const SLOT0_RATE_MASK = (1n << 168n) - 1n;

export type FluidOverrideResolution =
  | {
      status: "resolved";
      overrideAddress: ViemAddress;
      /** "chainlink-tuple" - _readChainlinkSource() calls latestRoundData(), a 5-word
       *  tuple (uint80, int256 answer, uint256, uint256, uint80) - verified against the
       *  real source reader this session, not assumed.
       *  "capped-rate-storage" - overriding a CappedRate's raw rate SOURCE bytecode does
       *  NOT work: getExchangeRateLiquidate() only calls the raw source when its own
       *  heartbeat has elapsed (fluidCappedRate.sol); an actively-used real vault's cached
       *  rate is usually fresh, so it just serves _slot0's cached value straight from
       *  storage, silently bypassing any raw-source override - confirmed live this session
       *  (a bytecode override on rateSource_ produced zero effect on a real vault's
       *  getExchangeRateLiquidate()). The real fix is overriding _slot0's cached `rate`
       *  field directly, which DOES correctly propagate through the outer oracle -
       *  confirmed live. overrideAddress here is the CappedRate's OWN address (not
       *  rateSource_), and overrideValue is interpreted as the desired final cached rate
       *  directly, in the CappedRate's own native units - see validateFluidLiquidation. */
      stubKind: "chainlink-tuple" | "capped-rate-storage";
    }
  | { status: "not-applicable"; reason: string }
  | { status: "unable-to-validate"; reason: string };

/**
 * Finds the real contract address to override for a given vault + shock scenario.
 * "market" -> the vault oracle's own Chainlink/Redstone hop (matches Thrilok's confirmed
 * "chainlink eth/usd hops pass through uncapped" - never touches capping logic).
 * "internal-exchange-rate" -> recurses into a nested Fluid-type hop and confirms it's
 * really a CappedRate instance before targeting its raw rate source - "not-applicable" (not
 * a failure) if the vault has no yield-wrapper hop at all, since the scenario genuinely
 * doesn't apply to that vault's asset composition.
 *
 * KNOWN, DISCLOSED SCOPE LIMIT: only handles vaults where exactly one hop matches the
 * requested category. A vault needing correct multi-hop algebraic composition (solving for
 * one hop's override value given the others' real, unchanged contributions) returns
 * "unable-to-validate" rather than risk an unverified multi-hop price calculation - real,
 * bounded future work, not silently guessed at.
 */
export async function resolveFluidOverrideTarget(
  client: PublicClient,
  vaultOracle: ViemAddress,
  priceComponent: "market" | "internal-exchange-rate",
): Promise<FluidOverrideResolution> {
  let hops;
  try {
    hops = await client.readContract({ address: vaultOracle, abi: HOPS_ABI, functionName: "getOracleHopSources" });
  } catch {
    return {
      status: "unable-to-validate",
      reason: "Oracle doesn't expose getOracleHopSources() - not a recognized GenericOracle instance",
    };
  }

  const realHops = hops.filter((h) => h.source.toLowerCase() !== ZERO_ADDRESS);

  if (priceComponent === "internal-exchange-rate") {
    const fluidHops = realHops.filter((h) => h.sourceType === SOURCE_TYPE_FLUID || h.sourceType === SOURCE_TYPE_FLUID_DEBT);
    if (fluidHops.length === 0) {
      return {
        status: "not-applicable",
        reason: "No yield-wrapper (Fluid-type) hop in this vault's oracle - LST-depeg scenario doesn't apply to this vault",
      };
    }
    if (fluidHops.length > 1) {
      return { status: "unable-to-validate", reason: "Multiple Fluid-type hops - multi-hop composition not yet supported" };
    }

    try {
      // configData() succeeding at all confirms this really is a CappedRate instance -
      // its return value isn't otherwise used here, since the override targets the
      // CappedRate's own cached storage, not rateSource_ (see stubKind's doc comment).
      await client.readContract({ address: fluidHops[0]!.source, abi: CONFIG_DATA_ABI, functionName: "configData" });
      return { status: "resolved", overrideAddress: fluidHops[0]!.source, stubKind: "capped-rate-storage" };
    } catch {
      return { status: "unable-to-validate", reason: "Fluid-type hop isn't a recognized CappedRate instance" };
    }
  }

  // "market" component - correlated / stablecoin-depeg shocks.
  const marketHops = realHops.filter((h) => h.sourceType === SOURCE_TYPE_CHAINLINK || h.sourceType === SOURCE_TYPE_REDSTONE);
  if (marketHops.length === 0) {
    return { status: "unable-to-validate", reason: "No Chainlink/Redstone market-price hop found in this vault's oracle" };
  }
  if (marketHops.length > 1) {
    return { status: "unable-to-validate", reason: "Multiple market-price hops - multi-hop composition not yet supported" };
  }
  return { status: "resolved", overrideAddress: marketHops[0]!.source, stubKind: "chainlink-tuple" };
}

export type FluidValidationResult =
  | { status: "not-applicable"; reason: string }
  | { status: "unable-to-validate"; reason: string }
  | { status: "swept"; actualColAmt: bigint; actualDebtAmt: bigint }
  | { status: "unexpected-revert"; rawError: string };

export interface ValidateFluidLiquidationParams {
  vault: ViemAddress;
  oracle: ViemAddress;
  /** Fixed value to inject - meaning depends on the resolved stubKind. For
   *  "chainlink-tuple": the raw feed answer (Chainlink-style, whatever decimals that feed
   *  uses). For "capped-rate-storage": the desired FINAL cached rate directly, in the
   *  CappedRate's own native units (its real current value is readable via
   *  getExchangeRateLiquidate() on the CappedRate address itself - shock relative to
   *  that, not relative to some other raw source's units). */
  overrideValue: bigint;
  priceComponent: "market" | "internal-exchange-rate";
  /** Real, grounded sweep size - the vault's own total real borrow is the recommended
   *  choice (loaders/fluidVaultConfig.ts's totalSupplyAndBorrow), not an arbitrary guess -
   *  see #30's decision log. */
  debtAmt: bigint;
}

/**
 * Checks a real liquidate() call against Fluid's actual deployed vault, at a hypothetical
 * shocked price. RPC-only - confirmed zero funding needed (the to_=0xdead dry-run reverts
 * with the real amounts strictly before any token movement - verified against the full
 * liquidate() source this session, not just the NatSpec).
 */
export async function validateFluidLiquidation(
  client: PublicClient,
  params: ValidateFluidLiquidationParams,
): Promise<FluidValidationResult> {
  const { vault, oracle, overrideValue, priceComponent, debtAmt } = params;

  const resolution = await resolveFluidOverrideTarget(client, oracle, priceComponent);
  if (resolution.status !== "resolved") {
    return resolution;
  }

  const liquidateCalldata = encodeFunctionData({
    abi: LIQUIDATE_ABI,
    functionName: "liquidate",
    args: [debtAmt, 0n, DEAD_ADDRESS, false],
  });

  let stateOverride: Parameters<typeof client.call>[0]["stateOverride"];
  if (resolution.stubKind === "chainlink-tuple") {
    // latestRoundData() returns (uint80 roundId, int256 answer, uint256 startedAt,
    // uint256 updatedAt, uint80 answeredInRound) - only `answer` (index 1) is actually
    // read by _readChainlinkSource; the rest can be zero.
    stateOverride = [
      { address: resolution.overrideAddress, code: buildFixedTupleReturnBytecode([0n, overrideValue, 0n, 0n, 0n]) },
    ];
  } else {
    // capped-rate-storage: read the REAL current slot0 first, preserve every field except
    // `rate` (lastUpdateTime/flags/minHeartbeat/minUpdateDiffPercent all packed in the same
    // slot - corrupting them would produce confusing, unrelated failures) - see
    // resolveFluidOverrideTarget's stubKind doc comment for why bytecode override doesn't
    // work here at all.
    const currentSlot0 = BigInt((await client.getStorageAt({ address: resolution.overrideAddress, slot: SLOT0_KEY }))!);
    const newSlot0 = (currentSlot0 & ~SLOT0_RATE_MASK) | (overrideValue & SLOT0_RATE_MASK);
    stateOverride = [
      {
        address: resolution.overrideAddress,
        stateDiff: [{ slot: SLOT0_KEY, value: numberToHex(newSlot0, { size: 32 }) }],
      },
    ];
  }

  try {
    await client.call({ to: vault, data: liquidateCalldata, stateOverride });
    // liquidate() with to_=dead ALWAYS reverts (by design, even on "success") - reaching
    // here without a revert means something is structurally wrong, not a valid outcome.
    return { status: "unexpected-revert", rawError: "call succeeded without reverting - to_=dead should always revert" };
  } catch (err) {
    const data = extractRevertData(err);
    if (!data) {
      return { status: "unexpected-revert", rawError: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
    }
    try {
      const decoded = decodeErrorResult({ abi: LIQUIDATE_ABI, data });
      if (decoded.errorName === "FluidLiquidateResult") {
        const [actualColAmt, actualDebtAmt] = decoded.args as readonly [bigint, bigint];
        return { status: "swept", actualColAmt, actualDebtAmt };
      }
      if (decoded.errorName === "FluidVaultError") {
        const [errorId] = decoded.args as readonly [bigint];
        const name = VAULT_ERROR_NAMES[Number(errorId)] ?? `unrecognized errorId ${errorId}`;
        return { status: "unexpected-revert", rawError: `FluidVaultError: ${name}` };
      }
      // Defensive fallback - the ABI above only declares these two errors, so decode
      // should never actually reach here, but don't silently swallow an unrecognized shape.
      const fallback = decoded as { errorName: string; args?: readonly unknown[] };
      return { status: "unexpected-revert", rawError: `${fallback.errorName}(${fallback.args?.join(", ") ?? ""})` };
    } catch {
      return { status: "unexpected-revert", rawError: data };
    }
  }
}

export interface EstimateFluidLiquidationGasParams {
  vault: ViemAddress;
  oracle: ViemAddress;
  /** ConstantViews.borrowToken (fluidVaultConfig.ts) - the real debt token, needed to fund
   *  a real (non-dry-run) call. Deliberately NOT ConstantViews.liquidity - see #43's
   *  confirmed-live finding, docs/decisions.md. */
  borrowToken: ViemAddress;
  overrideValue: bigint;
  priceComponent: "market" | "internal-exchange-rate";
  debtAmt: bigint;
}

export type EstimateFluidGasResult =
  | { status: "estimated"; gasUsed: bigint }
  | { status: "not-applicable"; reason: string }
  | { status: "unable-to-estimate"; reason: string };

/**
 * #43: a REAL eth_estimateGas for liquidate() - genuinely different from
 * validateFluidLiquidation's correctness check, which deliberately calls with
 * to_=0x000...dEaD so it always reverts (its dry-run trick). estimateGas has no valid
 * answer for a call with no successful execution path, so this uses a real to_ and real
 * funding instead - confirmed live this session (docs/decisions.md's #43 scoping entry):
 * the vault itself (not ConstantViews.liquidity) is the real ERC20 spender, and
 * absorb_=false alone succeeds (confirming genuine liquidator-repays economics, not
 * protocol-level bad-debt absorption).
 */
export async function estimateFluidLiquidationGas(
  client: PublicClient,
  params: EstimateFluidLiquidationGasParams,
): Promise<EstimateFluidGasResult> {
  const { vault, oracle, borrowToken, overrideValue, priceComponent, debtAmt } = params;

  const resolution = await resolveFluidOverrideTarget(client, oracle, priceComponent);
  if (resolution.status === "not-applicable") return resolution;
  if (resolution.status === "unable-to-validate") return { status: "unable-to-estimate", reason: resolution.reason };

  let priceOverride: NonNullable<Parameters<typeof client.estimateGas>[0]["stateOverride"]>[number];
  if (resolution.stubKind === "chainlink-tuple") {
    priceOverride = { address: resolution.overrideAddress, code: buildFixedTupleReturnBytecode([0n, overrideValue, 0n, 0n, 0n]) };
  } else {
    const currentSlot0 = BigInt((await client.getStorageAt({ address: resolution.overrideAddress, slot: SLOT0_KEY }))!);
    const newSlot0 = (currentSlot0 & ~SLOT0_RATE_MASK) | (overrideValue & SLOT0_RATE_MASK);
    priceOverride = { address: resolution.overrideAddress, stateDiff: [{ slot: SLOT0_KEY, value: numberToHex(newSlot0, { size: 32 }) }] };
  }

  const slots = await probeTokenSlots(client, borrowToken, MULTICALL3_ADDRESS, vault);
  if (!slots) {
    return { status: "unable-to-estimate", reason: `Could not determine ${borrowToken}'s balance/allowance storage layout` };
  }

  const fundedAmount = debtAmt * 1000n + 10n ** 30n;
  const balanceSlot = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [MULTICALL3_ADDRESS, BigInt(slots.balanceSlotIndex)]),
  );
  const ownerSlot = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [MULTICALL3_ADDRESS, BigInt(slots.allowanceSlotIndex)]),
  );
  // Allowance granted to the VAULT itself, not ConstantViews.liquidity - the real, confirmed
  // funding recipe (see this function's own doc comment).
  const allowanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [vault, ownerSlot]));

  const tokenOverride = {
    address: borrowToken,
    stateDiff: [
      { slot: balanceSlot, value: numberToHex(fundedAmount, { size: 32 }) },
      { slot: allowanceSlot, value: numberToHex(fundedAmount, { size: 32 }) },
    ],
  };

  const liquidateCalldata = encodeFunctionData({
    abi: LIQUIDATE_ABI,
    functionName: "liquidate",
    args: [debtAmt, 0n, MULTICALL3_ADDRESS, false],
  });

  try {
    const gasUsed = await client.estimateGas({
      account: MULTICALL3_ADDRESS,
      to: vault,
      data: liquidateCalldata,
      stateOverride: [priceOverride, tokenOverride],
    });
    return { status: "estimated", gasUsed };
  } catch (err) {
    // Same real gap as aaveValidator.ts's identical fix - viem's estimateGas error hides
    // the actual revert reason behind a generic top-level message unless the raw bytes are
    // extracted and decoded, same as validateFluidLiquidation already does for `call`.
    const data = extractRevertData(err);
    if (!data) {
      return { status: "unable-to-estimate", reason: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
    }
    try {
      const decoded = decodeErrorResult({ abi: LIQUIDATE_ABI, data });
      if (decoded.errorName === "FluidVaultError") {
        const [errorId] = decoded.args as readonly [bigint];
        const name = VAULT_ERROR_NAMES[Number(errorId)] ?? `unrecognized errorId ${errorId}`;
        return { status: "unable-to-estimate", reason: `FluidVaultError: ${name}` };
      }
      return { status: "unable-to-estimate", reason: `${decoded.errorName}(${decoded.args?.join(", ") ?? ""})` };
    } catch {
      return { status: "unable-to-estimate", reason: data };
    }
  }
}

function extractRevertData(err: unknown): `0x${string}` | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  // viem nests the raw revert data at different depths depending on the error type -
  // walk .cause chains and check common shapes rather than assume one fixed structure.
  let current: unknown = err;
  for (let i = 0; i < 5 && current; i++) {
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
