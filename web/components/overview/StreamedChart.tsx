"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import type { SweepPoint } from "@/lib/api/simulate";
import type { StreamStatus } from "@/lib/hooks/useSimulationStream";

export type MetricKey =
  | "liquidatableCollateralUsd"
  | "toxicPositionCount"
  | "badDebtUsd"
  | "liquidatablePositionPct"
  | "toxicPositionPct"
  | "liquidatableCollateralPct"
  | "concentrationPct"
  | "badDebtSeverityMedian";

const METRIC_LABEL: Record<MetricKey, string> = {
  liquidatableCollateralUsd: "Cumulative liquidatable collateral (USD, raw)",
  toxicPositionCount: "Positions past the toxic frontier (raw count)",
  badDebtUsd: "Cumulative bad debt (USD, raw)",
  liquidatablePositionPct: "Liquidatable/eligible - % of sampled positions",
  toxicPositionPct: "Toxic - % of sampled positions",
  liquidatableCollateralPct: "Liquidatable collateral - % of sampled collateral",
  concentrationPct: "Concentration - largest at-risk position's share",
  badDebtSeverityMedian: "Bad debt severity - median debt/collateral ratio, underwater positions only",
};

// Percentage/ratio metrics can be genuinely null (no at-risk or underwater positions yet
// at this magnitude) - kept as null through the chart, not coerced to 0, so recharts
// leaves a real gap instead of implying "zero" where the true answer is "not applicable
// yet". Raw count/dollar metrics stay at their existing 0-fallback behavior.
const PCT_METRICS = new Set<MetricKey>([
  "liquidatablePositionPct",
  "toxicPositionPct",
  "liquidatableCollateralPct",
  "concentrationPct",
]);
const RATIO_METRICS = new Set<MetricKey>(["badDebtSeverityMedian"]);

function formatValue(metric: MetricKey, value: number | null): string {
  if (value === null) return "—";
  if (metric === "toxicPositionCount") return String(Math.round(value));
  if (PCT_METRICS.has(metric)) return `${value.toFixed(1)}%`;
  if (RATIO_METRICS.has(metric)) return `${(value * 100).toFixed(0)}%`;
  return `$${Math.round(value).toLocaleString()}`;
}

interface ChartRow {
  magnitudePct: number;
  aave: number | null;
  fluid: number | null;
}

function toChartRows(aave: SweepPoint[], fluid: SweepPoint[], metric: MetricKey): ChartRow[] {
  // Streamed data can have aave/fluid arrays of different lengths mid-stream (points arrive
  // per-protocol independently) - key the merge by magnitude, not by array index, so a
  // partial chart never mismatches an aave point at one magnitude with a fluid point at
  // another while chunks are still arriving.
  const fluidByMagnitude = new Map(fluid.map((p) => [p.magnitudePct, p]));
  return aave.map((point) => ({
    magnitudePct: point.magnitudePct,
    aave: point[metric] ?? (PCT_METRICS.has(metric) || RATIO_METRICS.has(metric) ? null : 0),
    fluid: fluidByMagnitude.get(point.magnitudePct)?.[metric] ?? (PCT_METRICS.has(metric) || RATIO_METRICS.has(metric) ? null : 0),
  }));
}

export function StreamedChart({
  aave,
  fluid,
  metric,
  status,
  lastChunkLatencyMs,
  pointsReceived,
}: {
  aave: SweepPoint[];
  fluid: SweepPoint[];
  metric: MetricKey;
  status: StreamStatus;
  lastChunkLatencyMs: number | null;
  pointsReceived: number;
}) {
  const rows = toChartRows(aave, fluid, metric);

  return (
    <div>
      <div className="legend-row" aria-hidden>
        <span><span className="legend-swatch" style={{ background: "var(--series-aave)" }} />Aave V3</span>
        <span><span className="legend-swatch" style={{ background: "var(--series-fluid)" }} />Fluid T1</span>
      </div>
      <ResponsiveContainer width="100%" height={340}>
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="var(--gridline)" vertical={false} />
          <XAxis
            dataKey="magnitudePct"
            tickFormatter={(v: number) => `${v}%`}
            stroke="var(--baseline)"
            tick={{ fill: "var(--text-muted)", fontSize: 12 }}
            label={{ value: "ETH shock magnitude", position: "insideBottom", offset: -4, fill: "var(--text-muted)", fontSize: 12 }}
            type="number"
            domain={[-80, 0]}
          />
          <YAxis
            tickFormatter={(v: number) => formatValue(metric, v)}
            stroke="var(--baseline)"
            tick={{ fill: "var(--text-muted)", fontSize: 12 }}
            width={90}
          />
          <Tooltip
            formatter={(value: number, name: string) => [formatValue(metric, value), name === "aave" ? "Aave V3" : "Fluid T1"]}
            labelFormatter={(label: number) => `${label}% shock`}
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13 }}
          />
          <Legend
            formatter={(value: string) => (value === "aave" ? "Aave V3" : "Fluid T1")}
            wrapperStyle={{ display: "none" }}
          />
          <Line
            type="monotone"
            dataKey="aave"
            name="aave"
            stroke="var(--series-aave)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="fluid"
            name="fluid"
            stroke="var(--series-fluid)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="preset-note">{METRIC_LABEL[metric]} vs. shock magnitude. Hover the chart for exact values at any shock level.</p>
      <div className="stream-status">
        <span className={status === "streaming" ? "stream-live" : undefined}>
          {status === "streaming" && "Streaming..."}
          {status === "done" && "Stream complete."}
          {status === "error" && "Stream error."}
          {status === "idle" && "Idle."}
        </span>
        <span>{pointsReceived} chunk{pointsReceived === 1 ? "" : "s"} received</span>
        {lastChunkLatencyMs !== null && <span>last chunk: {lastChunkLatencyMs}ms</span>}
      </div>
    </div>
  );
}
