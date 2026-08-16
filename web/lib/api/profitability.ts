/**
 * `/api/liquidation-profitability` client - real gas-vs-bonus liquidation profitability
 * (api/src/validation/{aaveValidator,fluidValidator}.ts's estimateAaveLiquidationGas/
 * estimateFluidLiquidationGas, #43), synced by api/scripts/sync-liquidation-profitability.ts
 * and served here as the latest stored rows - same "sync writes, route reads" split as
 * validation.ts. Same USE_MOCK swap point - see meta.ts's top comment.
 */

import { API_BASE, USE_MOCK } from "./meta";

export type ProfitabilityProtocol = "aave" | "fluid";

/** Real, disclosed statuses - "profitable"/"unprofitable" are genuine real outcomes (a real
 *  liquidator's gas cost vs. the real bonus they'd receive), not a pass/fail on correctness
 *  the way validation.ts's statuses are. "unable-to-validate"/"unable-to-estimate-gas" are
 *  disclosed scope limits (e.g. the real MustNotLeaveDust rule, or a position that never
 *  became liquidatable within the tested magnitude range), not hidden failures. */
export type ProfitabilityStatus = "profitable" | "unprofitable" | "unable-to-validate" | "unable-to-estimate-gas";

export interface LiquidationProfitability {
  protocol: ProfitabilityProtocol;
  positionId: string;
  presetId: string;
  magnitudePct: string;
  /** Raw EVM gas units - lib/format.ts's formatGas. */
  gasUsed: string | null;
  /** All *Usd8 fields are this project's 8-decimal fixed-point USD convention throughout
   *  the API - lib/format.ts's formatUsd8, never display bare. */
  gasCostUsd8: string | null;
  debtClearedUsd8: string | null;
  bonusValueUsd8: string | null;
  netProfitUsd8: string | null;
  status: ProfitabilityStatus;
  detail: string | null;
  createdAt: string;
}

export async function fetchLiquidationProfitability(protocol?: ProfitabilityProtocol): Promise<LiquidationProfitability[]> {
  if (USE_MOCK) {
    const { getMockLiquidationProfitability } = await import("./mock/mockClient");
    return getMockLiquidationProfitability(protocol);
  }
  const params = protocol ? `?protocol=${encodeURIComponent(protocol)}` : "";
  const res = await fetch(`${API_BASE}/api/liquidation-profitability${params}`);
  if (!res.ok) throw new Error(`GET /api/liquidation-profitability failed: ${res.status}`);
  return res.json();
}
