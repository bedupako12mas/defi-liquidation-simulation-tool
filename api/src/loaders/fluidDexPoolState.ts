import type { Address, PublicClient } from "viem";
import { parseAbi } from "viem";
import { FLUID_DEX_RESERVES_RESOLVER, FLUID_DEX_RESOLVER } from "./fluidAddresses.js";

// Real per-vault-share fix (docs/decisions.md's 2026-09-03 T3 entry): a smart leg's real DEX
// pool is often shared across multiple vaults (confirmed real: one T2 pool shared by 18
// vaults), so attributing the WHOLE pool's value to every vault sharing it is wrong, not
// just imprecise - confirmed live for T3, where it produced a real, active, healthy vault's
// debt as ~38x its real collateral (comparing its own real vault-scoped collateral against
// the entire shared pool's debt total). Fix: divide this vault's own totalSupply/BorrowVault
// (denominated in the pool's own SHARE units for a smart leg, not underlying tokens) by the
// pool's real total shares outstanding (getTotalSupplySharesRaw/getTotalBorrowSharesRaw on
// the real, general Dex Resolver - periphery/resolvers/dex/main.sol, distinct from
// FLUID_DEX_RESERVES_RESOLVER) to get this vault's real fractional share.
const DEX_SHARES_ABI = parseAbi([
  "function getTotalSupplySharesRaw(address dex) view returns (uint256)",
  "function getTotalBorrowSharesRaw(address dex) view returns (uint256)",
]);
const SHARES_MASK = (1n << 128n) - 1n; // low 128 bits - the rest of the packed slot holds unrelated fields

// Real, dedicated resolver (verified live 2026-08-25 against active T2/T3/T4 pools - see
// docs/decisions.md's T2-T4 base-layer entry). getDexCollateralReserves()/getDexDebtReserves()
// correctly return all-zero for a pool whose corresponding role isn't enabled on that pool (e.g.
// a debt-only pool's collateral reserves) - confirmed real, not a bug, against a live T3
// debt-side pool that showed real nonzero debt reserves alongside all-zero collateral reserves.
const DEX_RESERVES_ABI = parseAbi([
  "struct CollateralReserves { uint256 token0RealReserves; uint256 token1RealReserves; uint256 token0ImaginaryReserves; uint256 token1ImaginaryReserves; }",
  "struct DebtReserves { uint256 token0Debt; uint256 token1Debt; uint256 token0RealReserves; uint256 token1RealReserves; uint256 token0ImaginaryReserves; uint256 token1ImaginaryReserves; }",
  "function getDexCollateralReserves(address dex) returns (CollateralReserves)",
  "function getDexDebtReserves(address dex) returns (DebtReserves)",
  "function getPoolTokens(address pool) view returns (address token0, address token1)",
]);

export interface DexCollateralReserves {
  token0: Address;
  token1: Address;
  /** Actual tokens held by the pool right now - what a liquidator would really receive. */
  token0RealReserves: bigint;
  token1RealReserves: bigint;
  /** Virtual reserves under Uniswap V3-style concentrated liquidity - determines price
   *  impact/slippage for a trade, NOT the real payout amount. Observed live: ~6700x larger
   *  than real reserves on a real, active pool (heavy concentration is the point of the design). */
  token0ImaginaryReserves: bigint;
  token1ImaginaryReserves: bigint;
}

export interface DexDebtReserves {
  token0: Address;
  token1: Address;
  token0Debt: bigint;
  token1Debt: bigint;
  token0RealReserves: bigint;
  token1RealReserves: bigint;
  token0ImaginaryReserves: bigint;
  token1ImaginaryReserves: bigint;
}

export async function loadDexCollateralReserves(client: PublicClient, dex: Address): Promise<DexCollateralReserves> {
  const [tokens, reserves] = await Promise.all([
    client.readContract({
      address: FLUID_DEX_RESERVES_RESOLVER,
      abi: DEX_RESERVES_ABI,
      functionName: "getPoolTokens",
      args: [dex],
    }),
    client.simulateContract({
      address: FLUID_DEX_RESERVES_RESOLVER,
      abi: DEX_RESERVES_ABI,
      functionName: "getDexCollateralReserves",
      args: [dex],
    }),
  ]);

  return { token0: tokens[0], token1: tokens[1], ...reserves.result };
}

/** This vault's real fraction of the collateral DEX pool's total supply shares - see this
 *  file's top comment for why the pool's aggregate value can't be attributed to every
 *  sharing vault directly. Returns a plain JS number (a ratio, always in [0, 1] for a real,
 *  correctly-functioning pool) - precision loss from bigint->number is immaterial here since
 *  this is a USD-value weighting factor, not an exact token amount. */
export async function loadVaultSupplyShareFraction(client: PublicClient, dex: Address, vaultOwnShares: bigint): Promise<number> {
  const rawTotal = await client.readContract({ address: FLUID_DEX_RESOLVER, abi: DEX_SHARES_ABI, functionName: "getTotalSupplySharesRaw", args: [dex] });
  const totalShares = rawTotal & SHARES_MASK;
  if (totalShares === 0n) return 0;
  return Number(vaultOwnShares) / Number(totalShares);
}

/** This vault's real fraction of the debt DEX pool's total borrow shares - the debt-leg
 *  mirror of loadVaultSupplyShareFraction. */
export async function loadVaultBorrowShareFraction(client: PublicClient, dex: Address, vaultOwnShares: bigint): Promise<number> {
  const rawTotal = await client.readContract({ address: FLUID_DEX_RESOLVER, abi: DEX_SHARES_ABI, functionName: "getTotalBorrowSharesRaw", args: [dex] });
  const totalShares = rawTotal & SHARES_MASK;
  if (totalShares === 0n) return 0;
  return Number(vaultOwnShares) / Number(totalShares);
}

export async function loadDexDebtReserves(client: PublicClient, dex: Address): Promise<DexDebtReserves> {
  const [tokens, reserves] = await Promise.all([
    client.readContract({
      address: FLUID_DEX_RESERVES_RESOLVER,
      abi: DEX_RESERVES_ABI,
      functionName: "getPoolTokens",
      args: [dex],
    }),
    client.simulateContract({
      address: FLUID_DEX_RESERVES_RESOLVER,
      abi: DEX_RESERVES_ABI,
      functionName: "getDexDebtReserves",
      args: [dex],
    }),
  ]);

  return { token0: tokens[0], token1: tokens[1], ...reserves.result };
}
