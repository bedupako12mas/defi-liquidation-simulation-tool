/**
 * `/api/validation-results` client - the real Aave/Fluid liquidation-validator results
 * (api/src/validation/{aaveValidator,fluidValidator}.ts, #30), synced into the DB
 * periodically by api/scripts/sync-validation-results.ts and served here as the latest
 * stored rows (RPC-heavy state-override eth_calls are too slow for a request path - same
 * "sync writes, route reads" split as meta.ts/simulate.ts's snapshot-backed routes).
 * Same USE_MOCK swap point as every other client in this folder - see meta.ts's top comment.
 */

import { API_BASE, USE_MOCK } from "./meta";

export type ValidationProtocol = "aave" | "fluid";

/** Real, disclosed statuses a validator run can produce - not all of them mean "failure".
 *  "matched"/"matched-within-drift" and "swept" are the real positive confirmations;
 *  "not-applicable"/"unable-to-validate" are disclosed scope limits, not silent gaps;
 *  "mismatched"/"unexpected-revert" are the only two that mean something is actually wrong. */
export type ValidationStatus =
  | "matched"
  | "matched-within-drift"
  | "mismatched"
  | "swept"
  | "not-applicable"
  | "unable-to-validate"
  | "unexpected-revert";

export interface ValidationResult {
  protocol: ValidationProtocol;
  positionId: string;
  presetId: string;
  magnitudePct: string;
  status: ValidationStatus;
  expectedAmount: string | null;
  actualAmount: string | null;
  detail: string | null;
  createdAt: string;
}

export async function fetchValidationResults(protocol?: ValidationProtocol): Promise<ValidationResult[]> {
  if (USE_MOCK) {
    const { getMockValidationResults } = await import("./mock/mockClient");
    return getMockValidationResults(protocol);
  }
  const params = protocol ? `?protocol=${encodeURIComponent(protocol)}` : "";
  const res = await fetch(`${API_BASE}/api/validation-results${params}`);
  if (!res.ok) throw new Error(`GET /api/validation-results failed: ${res.status}`);
  return res.json();
}
