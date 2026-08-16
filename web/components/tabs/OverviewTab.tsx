"use client";

import { useState } from "react";
import { useCapabilities } from "@/lib/hooks/useCapabilities";
import { useSimulationStream } from "@/lib/hooks/useSimulationStream";
import { PresetSelector } from "@/components/overview/PresetSelector";
import { StreamedChart, type MetricKey } from "@/components/overview/StreamedChart";
import { PositionDrilldown } from "@/components/overview/PositionDrilldown";
import { InfoTooltip } from "@/components/shared/InfoTooltip";
import type { ShockPreset } from "@/lib/api/meta";

// Normalized only - raw totals (liquidatableCollateralUsd, toxicPositionCount, badDebtUsd)
// are dropped from the selector entirely, not just deprioritized. They're still real,
// correct numbers (still in SweepPoint, still used elsewhere - e.g. formatValue/
// PCT_METRICS in StreamedChart.tsx), but as a *graph comparing two very differently-sized
// real samples* they were actively misleading (see docs/decisions.md's "5 rigorous
// comparison metrics" entry - this is what prompted the whole normalization work).
//
// Each metric carries two descriptions, not one: `plain` is always visible next to the
// pill row (no interaction required), `technical` is the same precise definition used in
// MethodologyTab's "Comparing Aave and Fluid fairly" card, surfaced via InfoTooltip rather
// than duplicated as separate prose that could drift out of sync.
const METRICS: { key: MetricKey; label: string; plain: string; technical: string }[] = [
  {
    key: "liquidatablePositionPct",
    label: "Liquidatable/eligible (%)",
    plain: "Share of positions that could be liquidated right now, at this shock size.",
    technical:
      "Liquidatable/eligible count as a percentage of each protocol's own sampled book, not an absolute number - so it stays comparable across Aave's small sample and Fluid's much larger one, without either being dominated by whichever position happens to be largest.",
  },
  {
    key: "toxicPositionPct",
    label: "Toxic (%)",
    plain: "Share of positions where liquidating them now would only make things worse - already past the point of no return.",
    technical:
      "Toxic count (current LTV past the undercollateralization frontier) as a percentage of the sampled book. Toxic is always a subset of liquidatable/eligible, never a separate condition reached on its own.",
  },
  {
    key: "liquidatableCollateralPct",
    label: "Liquidatable collateral (%)",
    plain: "Share of total collateral value sitting in at-risk positions, in dollar terms rather than headcount.",
    technical:
      "The same idea as the count-based metric above, applied to collateral value instead of position count. More sensitive to a single large position - which is exactly what concentration (below) exists to measure explicitly, rather than leave hidden inside a dollar total.",
  },
  {
    key: "concentrationPct",
    label: "Concentration",
    plain: "How much of the at-risk collateral sits in just one single position - high means one whale dominates the picture, low means risk is spread out.",
    technical:
      "The single largest at-risk position's share of all at-risk collateral, at a given shock. High concentration means a dollar swing is a single-position artifact, not a broad signal; low, stable concentration means it is.",
  },
  {
    key: "badDebtSeverityMedian",
    label: "Bad debt severity",
    plain: "How much of a position's debt could be wiped out if the liquidator gets it slightly wrong.",
    technical:
      "The median debt/collateral ratio among only the positions that are actually underwater, not the summed dollar total - separates \"many positions barely underwater\" from \"one position catastrophically underwater,\" which a single summed total conflates.",
  },
];

export function OverviewTab() {
  const { meta, loading, error } = useCapabilities();
  const [presetId, setPresetId] = useState<ShockPreset["id"]>("correlated");
  const [metric, setMetric] = useState<MetricKey>("liquidatablePositionPct");
  const stream = useSimulationStream(meta ? presetId : null);
  const activeMetric = METRICS.find((m) => m.key === metric) ?? METRICS[0]!;

  return (
    <div>
      <div className="card">
        <h2>Shock scenario</h2>
        {loading && <p className="loading">Loading presets...</p>}
        {error && <div className="banner">Error talking to the API: {error}.</div>}
        {meta && <PresetSelector presets={meta.presets} activeId={presetId} onChange={setPresetId} />}
      </div>

      <div className="card">
        <h2>Metric</h2>
        <div className="pill-group" style={{ marginBottom: "1rem" }}>
          {METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              className="pill"
              data-active={metric === m.key}
              onClick={() => setMetric(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="preset-note metric-explainer" style={{ marginTop: 0, marginBottom: "1rem" }}>
          <span>{activeMetric.plain}</span>
          <InfoTooltip label={`How "${activeMetric.label}" is defined`}>{activeMetric.technical}</InfoTooltip>
        </p>
        {meta ? (
          <StreamedChart
            aave={stream.aave}
            fluid={stream.fluid}
            metric={metric}
            status={stream.status}
            lastChunkLatencyMs={stream.lastChunkLatencyMs}
            pointsReceived={stream.pointsReceived}
          />
        ) : (
          <p className="loading">Waiting for scenario...</p>
        )}
        {stream.status === "error" && stream.error && (
          <div className="banner">Simulation stream error: {stream.error}</div>
        )}
      </div>

      <div className="card">
        <h2>Per-position drilldown</h2>
        <p className="preset-note" style={{ marginTop: 0, marginBottom: "1rem" }}>
          Every position&apos;s health factor, LTV, and undercollateralization-frontier state at one
          selected shock magnitude - not part of the streamed sweep above, a separate
          on-demand snapshot (<code>/api/positions</code>).
        </p>
        {meta && <PositionDrilldown presetId={presetId} />}
      </div>
    </div>
  );
}
