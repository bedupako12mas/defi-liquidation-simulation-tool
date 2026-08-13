"use client";

import { useState } from "react";
import { useCapabilities } from "@/lib/hooks/useCapabilities";
import { useSimulationStream } from "@/lib/hooks/useSimulationStream";
import { PresetSelector } from "@/components/overview/PresetSelector";
import { StreamedChart, type MetricKey } from "@/components/overview/StreamedChart";
import { PositionDrilldown } from "@/components/overview/PositionDrilldown";
import type { ShockPreset } from "@/lib/api/meta";

// Normalized metrics first, deliberately - they're the fair comparison across Aave's and
// Fluid's very differently-sized real samples (see docs/decisions.md's "5 rigorous
// comparison metrics" entry). Raw totals are still available (real numbers, not wrong),
// just no longer the default first thing shown.
const METRICS: { key: MetricKey; label: string }[] = [
  { key: "liquidatablePositionPct", label: "Liquidatable/eligible (%)" },
  { key: "toxicPositionPct", label: "Toxic (%)" },
  { key: "liquidatableCollateralPct", label: "Liquidatable collateral (%)" },
  { key: "concentrationPct", label: "Concentration" },
  { key: "badDebtSeverityMedian", label: "Bad debt severity" },
  { key: "liquidatableCollateralUsd", label: "Liquidatable collateral (raw $)" },
  { key: "toxicPositionCount", label: "Toxic positions (raw count)" },
  { key: "badDebtUsd", label: "Bad debt (raw $)" },
];

export function OverviewTab() {
  const { meta, loading, error } = useCapabilities();
  const [presetId, setPresetId] = useState<ShockPreset["id"]>("correlated");
  const [metric, setMetric] = useState<MetricKey>("liquidatablePositionPct");
  const stream = useSimulationStream(meta ? presetId : null);

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
