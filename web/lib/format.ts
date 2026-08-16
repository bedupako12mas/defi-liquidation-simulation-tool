/**
 * Shared money/unit formatting - one place so every table/graph that shows a real amount
 * uses the same rules, rather than each component inventing its own (a real gap found by
 * looking at the deployed Validation tab: raw on-chain integers with no unit at all - not
 * dollars, not wei, not a token amount, just a bare number).
 */

/** A raw 8-decimal fixed-point USD value (this project's own convention throughout the API
 *  - see api/src/db/types.ts's Numeric/price_usd8 comment) as a string or bigint, formatted
 *  as a real dollar figure. Null-safe - returns an em dash, never "$NaN" or "$null". */
export function formatUsd8(raw: string | bigint | null | undefined, opts?: { decimals?: number }): string {
  if (raw === null || raw === undefined) return "—";
  const value = Number(raw) / 1e8;
  const decimals = opts?.decimals ?? (Math.abs(value) < 1 ? 4 : 2);
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/** A raw on-chain token amount (a string or bigint, in the token's own smallest unit) plus
 *  its real decimals and symbol - decimal-adjusted and labeled, e.g. "17,240.59 USDC".
 *  Null-safe (returns an em dash) and decimals/symbol-safe (falls back to a raw-units
 *  label rather than silently mis-scaling by guessing 18 decimals). */
export function formatTokenAmount(
  raw: string | bigint | null | undefined,
  decimals: number | null | undefined,
  symbol: string | null | undefined,
): string {
  if (raw === null || raw === undefined) return "—";
  if (decimals === null || decimals === undefined) {
    // Real, disclosed fallback - never guess a decimals value, since a wrong guess would
    // silently misrepresent the real magnitude by orders of magnitude.
    return `${BigInt(raw).toLocaleString("en-US")} raw units`;
  }
  const value = Number(raw) / 10 ** decimals;
  const label = symbol && symbol !== "UNKNOWN" ? symbol : "tokens";
  const displayDecimals = value !== 0 && Math.abs(value) < 1 ? 6 : 2;
  return `${value.toLocaleString("en-US", { minimumFractionDigits: displayDecimals, maximumFractionDigits: displayDecimals })} ${label}`;
}

/** Raw EVM gas units (a string or bigint) - e.g. "539,463 gas". */
export function formatGas(raw: string | bigint | null | undefined): string {
  if (raw === null || raw === undefined) return "—";
  return `${BigInt(raw).toLocaleString("en-US")} gas`;
}

/** A shock magnitude percentage, already signed (e.g. "-30.00") - shown consistently with
 *  a trailing % and no re-signing, since the stored value's sign is the real one. */
export function formatMagnitudePct(raw: string | number): string {
  const value = typeof raw === "string" ? Number(raw) : raw;
  return `${value.toFixed(2)}%`;
}

/** A general-purpose, already-computed percentage (e.g. a real measured diff-as-%-of-
 *  baseline) - unlike formatMagnitudePct's fixed 2 decimals (fine for a shock input, which
 *  is never sub-0.01%), this needs adaptive precision: a real chained-liquidation effect can
 *  be genuinely as small as ~0.000001%, and .toFixed(2) would silently round it to "0.00%",
 *  erasing the exact real, nonzero result the whole check exists to report. Null-safe. */
export function formatPct(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return "—";
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (value === 0) return "0%";
  const decimals = Math.abs(value) < 0.01 ? 6 : 2;
  return `${value.toFixed(decimals)}%`;
}
