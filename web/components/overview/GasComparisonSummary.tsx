"use client";

/**
 * Compact cross-protocol gas-cost-of-liquidation summary for the Overview tab, so "is it worth
 * a liquidator's gas" is visible right after the protocol comparison chart, not only buried in
 * the Validation tab's full per-position tables. Reuses the same fetchLiquidationProfitability()
 * call ValidationTab.tsx already makes (web/lib/api/profitability.ts) - no new endpoint.
 *
 * Aave V4 has no gas/profitability pipeline yet (ProfitabilityProtocol is "aave" | "fluid" -
 * see profitability.ts) - this only ever shows Aave V3 and Fluid T1, and says so explicitly
 * rather than silently omitting V4.
 */

import { useEffect, useState } from "react";
import {
  fetchLiquidationProfitability,
  type LiquidationProfitability,
  type ProfitabilityProtocol,
} from "@/lib/api/profitability";
import { formatUsd8 } from "@/lib/format";
import { InfoTooltip } from "@/components/shared/InfoTooltip";
import { useNavigation } from "@/lib/hooks/useNavigation";
import type { ShockPreset } from "@/lib/api/meta";

const PROTOCOL_LABEL: Record<ProfitabilityProtocol, string> = {
  aave: "Aave V3",
  fluid: "Fluid T1",
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function summarize(rows: LiquidationProfitability[]) {
  // Only rows with a real computed economic outcome carry signal - "unable-to-validate"/
  // "unable-to-estimate-gas" are disclosed scope limits (see ValidationTab.tsx's own
  // handling of the same statuses), not a real gas/profit number to average in.
  const signalRows = rows.filter((r) => r.status === "profitable" || r.status === "unprofitable");
  const gasCosts = signalRows.map((r) => Number(r.gasCostUsd8)).filter((n) => Number.isFinite(n));
  const netProfits = signalRows.map((r) => Number(r.netProfitUsd8)).filter((n) => Number.isFinite(n));
  const profitableCount = signalRows.filter((r) => r.status === "profitable").length;
  return {
    testedCount: rows.length,
    signalCount: signalRows.length,
    medianGasCostUsd8: median(gasCosts),
    medianNetProfitUsd8: median(netProfits),
    profitablePct: signalRows.length > 0 ? (profitableCount / signalRows.length) * 100 : null,
  };
}

export function GasComparisonSummary({ presetId }: { presetId: ShockPreset["id"] }) {
  const [rows, setRows] = useState<LiquidationProfitability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { goTo } = useNavigation();

  useEffect(() => {
    let cancelled = false;
    fetchLiquidationProfitability()
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="banner">Error talking to the API: {error}.</div>;
  if (!rows) return <p className="loading">Loading gas/profitability data...</p>;

  const rowsForPreset = rows.filter((r) => r.presetId === presetId);

  return (
    <div>
      <p className="preset-note" style={{ marginTop: 0 }}>
        A liquidation only really happens if a real liquidator profits after paying real gas.
        Aave V4 gas estimates aren&apos;t wired up yet, so this compares Aave V3 and Fluid T1
        only - see every tested position in the Validation tab.
        <InfoTooltip label="How gas cost and net profit are computed" glossaryId="gas-cost">
          Real <code>eth_estimateGas</code> against both protocols&apos; actual deployed
          contracts, converted to USD via the real current gas price and real ETH/USD,
          compared against the real bonus a liquidator would receive - all under the currently
          selected shock preset.
        </InfoTooltip>
      </p>
      <div className="gas-summary-grid">
        {(["aave", "fluid"] as const).map((protocol) => {
          const summary = summarize(rowsForPreset.filter((r) => r.protocol === protocol));
          return (
            <div key={protocol} className="gas-summary-cell">
              <div className="gas-summary-protocol">{PROTOCOL_LABEL[protocol]}</div>
              {summary.signalCount === 0 ? (
                <p className="preset-note" style={{ margin: 0 }}>
                  No real economic signal yet at this shock preset.
                </p>
              ) : (
                <>
                  <div className="gas-summary-row">
                    <span>Median gas cost</span>
                    <strong>{formatUsd8(summary.medianGasCostUsd8?.toString() ?? null)}</strong>
                  </div>
                  <div className="gas-summary-row">
                    <span>Median net profit</span>
                    <strong>{formatUsd8(summary.medianNetProfitUsd8?.toString() ?? null)}</strong>
                  </div>
                  <div className="gas-summary-row">
                    <span>Profitable at this shock</span>
                    <strong>{summary.profitablePct === null ? "—" : `${summary.profitablePct.toFixed(0)}%`}</strong>
                  </div>
                </>
              )}
              <p className="preset-note" style={{ marginBottom: 0 }}>
                {summary.signalCount} of {summary.testedCount} tested (position, magnitude) pairs gave a real signal.
              </p>
            </div>
          );
        })}
      </div>
      <p className="preset-note">
        <button type="button" className="link-button" onClick={() => goTo("validation")}>
          See every position → Validation tab
        </button>
      </p>
    </div>
  );
}
