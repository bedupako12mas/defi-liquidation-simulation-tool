import type { Address as ViemAddress, PublicClient } from "viem";
import { parseAbi } from "viem";

// Deploy 2/6 (#66) - T2 fork tier, later generalized for T3 (#68 - see the
// dexSmartDebtOracleData branch below, added when T3's real census found a variant this
// resolver hadn't seen against T2). File name is now slightly historical - what's exported
// resolves either a smart-collateral OR smart-debt leg's oracle, since Fluid's Peg-oracle
// interface generations turned out to be identical in shape across both (only the function
// name differs: dexSmartColOracleData vs dexSmartDebtOracleData - same field order,
// confirmed live via Sourcify for both).
//
// Real, on-chain census of all 34 live T2 vaults' Configs.oracle (docs/decisions.md's
// 2026-09-03 entry) found T1's existing resolveFluidOverrideTarget (which assumes a
// FluidGenericOracle hop-chain directly on the vault oracle) does not apply to any real T2
// vault - none expose getOracleHopSources(). Instead, a smart leg's price wraps the DEX
// pool's real reserves via one of two real, verified Peg-oracle interface generations (new:
// split RESERVES_PEG_BUFFER_PERCENT/getDexConversionPriceFluidOracleData/
// getDexColDebtOracleData getters; old: one bundled dexSmartCol/DebtOracleData() getter with
// a different field order, verified against real Sourcify-hosted source after a raw eth_call
// decode caught a guessed field order being wrong - see docs/decisions.md's correction
// entry) - each delegating the ACTUAL live price to a separately-deployed nested
// IFluidOracle (or address zero = a fixed peg, genuinely not overridable).
//
// REVISED APPROACH (found live, after a first version wrongly assumed every nested oracle
// would itself be a FluidGenericOracle hop-chain resolveFluidOverrideTarget could peel back
// to a Chainlink/CappedRate leaf): probing real nested oracle addresses found only a
// minority expose getOracleHopSources() at all. Most are either a FluidCappedRate instance
// directly (confirmed via configData() succeeding directly on the nested address - e.g.
// reUSD's real getExchangeRate() = 1.098..., matching the RPC tier's independently-derived
// price almost exactly) or some other real, custom leaf IFluidOracle (e.g. a raw
// wstETH<>stETH rate contract - configData() fails but getExchangeRate() succeeds). Rather
// than keep chasing each leaf's exact internal implementation, buildFixedReturnBytecode's
// own design point applies directly here: it is selector-agnostic (ignores calldata, always
// returns the same fixed word), so it can override ANY nested IFluidOracle's entire
// bytecode in one step - hop-chain, CappedRate, or an unrecognized custom leaf alike -
// without first identifying which one it is. This is simpler AND strictly more general than
// hop-peeling. A nested oracle is only reported unresolved if it doesn't even respond to
// getExchangeRate() (a dead/broken address), never based on its internal shape.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const LEAF_ORACLE_ABI = parseAbi(["function getExchangeRate() view returns (uint256)"]);

const NEW_PEG_ABI = parseAbi([
  "function RESERVES_PEG_BUFFER_PERCENT() view returns (uint256)",
  "function getDexConversionPriceFluidOracleData() view returns (address reservesConversionOracle_, bool reservesConversionInvert_, uint256 reservesConversionPriceMultiplier_, uint256 reservesConversionPriceDivisor_)",
  "function getDexColDebtOracleData() view returns (address colDebtOracle_, bool colDebtInvert_)",
]);

// Field order verified against Sourcify's real verified source for
// 0x79ad9500CA248D263553d2447b134a4A2c7934b9 this session (see docs/decisions.md) - NOT the
// same order as the newer interface's separate getters, confirmed live via a raw,
// ABI-agnostic word-by-word decode after a first guess (matching a different real deployment
// JSON's field order) silently decoded wrong. Same field order confirmed for the debt-side
// equivalent (dexSmartDebtOracleData, 0xe09A0b13a2C5bfcF792c1BD68994F4BbC24d48cD) when T3's
// census found this same older interface generation on the debt leg too.
const OLD_PEG_ABI = parseAbi([
  "function dexSmartColOracleData() view returns (address dexPool_, uint256 reservesPegBufferPercent_, address liquidity_, uint256 token0NumeratorPrecision_, uint256 token0DenominatorPrecision_, uint256 token1NumeratorPrecision_, uint256 token1DenominatorPrecision_, address reservesConversionOracle_, bool reservesConversionInvert_, bool quoteInToken0_)",
  "function dexSmartDebtOracleData() view returns (address dexPool_, uint256 reservesPegBufferPercent_, address liquidity_, uint256 token0NumeratorPrecision_, uint256 token0DenominatorPrecision_, uint256 token1NumeratorPrecision_, uint256 token1DenominatorPrecision_, address reservesConversionOracle_, bool reservesConversionInvert_, bool quoteInToken0_)",
]);

export type SmartLegOracleShape = "new-peg" | "old-peg" | "unresolved";

export interface SmartLegOracleOverrideTarget {
  /** Which independent price component this target shocks - a vault's real smart-leg value
   *  depends on BOTH (reserves-conversion combines the pool's two real reserve legs;
   *  col-debt converts that combined value into the vault's other, normal leg's token) -
   *  see docs/decisions.md's 2026-09-03 entries. */
  leg: "reserves-conversion" | "col-debt";
  /** The nested IFluidOracle's own address - override THIS contract's entire bytecode
   *  (buildFixedReturnBytecode) to shock this leg, regardless of its internal shape. */
  overrideAddress: ViemAddress;
  /** Real current unshocked rate (1e27-scaled, IFluidOracle's own native convention) -
   *  the baseline a shock magnitude is applied relative to, not an arbitrary reference. */
  currentRate: bigint;
}

export interface SmartLegOracleResolution {
  shape: SmartLegOracleShape;
  /** RESERVES_PEG_BUFFER_PERCENT is 1e6-scaled (10000 = 1%) on-chain - reported here in bps
   *  (1e4-scaled) to match this codebase's existing liquidationThresholdBps/
   *  liquidationIncentiveBps convention, not left in Fluid's raw 1e6 units. */
  pegBufferBps?: number;
  overridable: SmartLegOracleOverrideTarget[];
  /** Real, disclosed reasons a lever could not be resolved - e.g. "fixed peg, no live
   *  oracle" or "hardcoded static-rate oracle, no live price source at all". Never silently
   *  dropped - a vault with zero overridable legs still reports WHY. */
  unresolvedReasons: string[];
}

async function tryResolveLeaf(
  client: PublicClient,
  address: ViemAddress,
  leg: "reserves-conversion" | "col-debt",
  overridable: SmartLegOracleOverrideTarget[],
  unresolvedReasons: string[],
): Promise<void> {
  const currentRate = await client
    .readContract({ address, abi: LEAF_ORACLE_ABI, functionName: "getExchangeRate" })
    .catch(() => null);
  if (currentRate === null) {
    unresolvedReasons.push(`${leg} oracle ${address} does not respond to getExchangeRate() - dead or unrecognized address`);
    return;
  }
  overridable.push({ leg, overrideAddress: address, currentRate });
}

export async function resolveSmartLegOracle(client: PublicClient, vaultOracle: ViemAddress): Promise<SmartLegOracleResolution> {
  const overridable: SmartLegOracleOverrideTarget[] = [];
  const unresolvedReasons: string[] = [];

  const newPegBuffer = await client
    .readContract({ address: vaultOracle, abi: NEW_PEG_ABI, functionName: "RESERVES_PEG_BUFFER_PERCENT" })
    .catch(() => null);

  if (newPegBuffer !== null) {
    const conv = await client
      .readContract({ address: vaultOracle, abi: NEW_PEG_ABI, functionName: "getDexConversionPriceFluidOracleData" })
      .catch(() => null);
    if (conv && conv[0].toLowerCase() !== ZERO_ADDRESS) {
      await tryResolveLeaf(client, conv[0], "reserves-conversion", overridable, unresolvedReasons);
    } else {
      unresolvedReasons.push("reserves-conversion price is a fixed peg (no separately-deployed oracle) - not overridable");
    }

    const colDebt = await client
      .readContract({ address: vaultOracle, abi: NEW_PEG_ABI, functionName: "getDexColDebtOracleData" })
      .catch(() => null);
    if (colDebt && colDebt[0].toLowerCase() !== ZERO_ADDRESS) {
      await tryResolveLeaf(client, colDebt[0], "col-debt", overridable, unresolvedReasons);
    }

    return { shape: "new-peg", pegBufferBps: Number(newPegBuffer) / 100, overridable, unresolvedReasons };
  }

  // Try both bundled old-interface function names - dexSmartColOracleData (T2) and
  // dexSmartDebtOracleData (T3), identical field order, confirmed live for both.
  for (const fnName of ["dexSmartColOracleData", "dexSmartDebtOracleData"] as const) {
    const oldPeg = await client
      .readContract({ address: vaultOracle, abi: OLD_PEG_ABI, functionName: fnName })
      .catch(() => null);
    if (oldPeg === null) continue;

    const reservesConversionOracle = oldPeg[7];
    if (reservesConversionOracle.toLowerCase() !== ZERO_ADDRESS) {
      await tryResolveLeaf(client, reservesConversionOracle, "reserves-conversion", overridable, unresolvedReasons);
    } else {
      unresolvedReasons.push("reserves-conversion price is a fixed peg (no separately-deployed oracle) - not overridable");
    }
    // This older interface generation has no public colDebtOracle getter at all (confirmed
    // live: getDexColDebtOracleData() reverts) - genuinely unknown whether a col-debt lever
    // exists for these vaults, not confirmed absent. Disclosed, not silently skipped.
    unresolvedReasons.push("this oracle version exposes no public colDebtOracle getter - that lever's presence is unconfirmed, not ruled out");

    return { shape: "old-peg", pegBufferBps: Number(oldPeg[1]) / 100, overridable, unresolvedReasons };
  }

  unresolvedReasons.push(
    "oracle matches no known Peg-oracle interface generation - likely a hardcoded-constant oracle (confirmed real example: infoName() = \"Static rate: 1e24\") or an unrecognized shape; not simulable via any known override",
  );
  return { shape: "unresolved", overridable, unresolvedReasons };
}
