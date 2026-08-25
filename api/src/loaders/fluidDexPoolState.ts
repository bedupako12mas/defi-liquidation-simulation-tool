import type { Address, PublicClient } from "viem";
import { parseAbi } from "viem";
import { FLUID_DEX_RESERVES_RESOLVER } from "./fluidAddresses.js";

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
