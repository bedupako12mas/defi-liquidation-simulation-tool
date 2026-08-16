/**
 * `/api/chained-liquidation` client - real chained-liquidation testing on an ephemeral
 * mainnet fork (api/scripts/sync-chained-liquidation.ts, #37/#38): for each real group of
 * currently-liquidatable positions sharing a (collateral, debt) reserve pair, position B's
 * real liquidation outcome measured before vs. after position A's real, mined liquidation on
 * the same fork. The one tier no eth_call state-override technique can answer, since every
 * eth_call is stateless relative to every other by construction. Same "sync writes, route
 * reads" split and USE_MOCK swap point as validation.ts/profitability.ts - see meta.ts's top
 * comment.
 */

import { API_BASE, USE_MOCK } from "./meta";

export type ChainedProtocol = "aave" | "fluid";

export interface ChainedLiquidationResult {
  protocol: ChainedProtocol;
  presetId: string;
  magnitudePct: string;
  positionAId: string;
  positionBId: string;
  /** Raw token amounts (isolatedDebtRepaid/chainedDebtRepaid/debtRepaidDiff) are in this
   *  asset's native decimals - lib/format.ts's formatTokenAmount, never display bare. */
  debtAssetSymbol: string | null;
  debtAssetDecimals: number | null;
  /** "success" | "reverted" - A's own real, mined liquidationCall() outcome. A "reverted" A
   *  means chaining wasn't testable for this pair (isolated/chained fields are null then). */
  positionATxStatus: string;
  isolatedStatus: string | null;
  isolatedDebtRepaid: string | null;
  chainedStatus: string | null;
  chainedDebtRepaid: string | null;
  /** Signed: chained - isolated. The real, fork-only-observable effect - zero is a genuine
   *  disclosed result (no measurable chaining effect for this pair), not a missing one. */
  debtRepaidDiff: string | null;
  detail: string | null;
  createdAt: string;
}

export async function fetchChainedLiquidation(protocol?: ChainedProtocol): Promise<ChainedLiquidationResult[]> {
  if (USE_MOCK) {
    const { getMockChainedLiquidation } = await import("./mock/mockClient");
    return getMockChainedLiquidation(protocol);
  }
  const params = protocol ? `?protocol=${encodeURIComponent(protocol)}` : "";
  const res = await fetch(`${API_BASE}/api/chained-liquidation${params}`);
  if (!res.ok) throw new Error(`GET /api/chained-liquidation failed: ${res.status}`);
  return res.json();
}
