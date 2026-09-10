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

const SERIES_LABEL: Record<"aave" | "fluid" | "aaveV4", string> = {
  aave: "Aave V3",
  fluid: "Fluid T1",
  aaveV4: "Aave V4",
};

interface ChartRow {
  magnitudePct: number;
  aave: number | null;
  fluid: number | null;
  aaveV4: number | null;
}

function toChartRows(aave: SweepPoint[], fluid: SweepPoint[], aaveV4: SweepPoint[], metric: MetricKey): ChartRow[] {
  // Streamed data can have aave/fluid/aaveV4 arrays of different lengths mid-stream (points
  // arrive per-protocol independently) - key the merge by magnitude, not by array index, so
  // a partial chart never mismatches an aave point at one magnitude with a fluid or aave-v4
  // point at another while chunks are still arriving. aave drives the row set (always
  // populated first/fastest in practice - see simulate.ts's emission order) - a magnitude
  // fluid or aave-v4 hasn't reached yet renders as a real gap (null), not a fabricated 0.
  const fluidByMagnitude = new Map(fluid.map((p) => [p.magnitudePct, p]));
  const aaveV4ByMagnitude = new Map(aaveV4.map((p) => [p.magnitudePct, p]));
  const fallback = PCT_METRICS.has(metric) || RATIO_METRICS.has(metric) ? null : 0;
  return aave.map((point) => ({
    magnitudePct: point.magnitudePct,
    aave: point[metric] ?? fallback,
    fluid: fluidByMagnitude.get(point.magnitudePct)?.[metric] ?? fallback,
    aaveV4: aaveV4ByMagnitude.get(point.magnitudePct)?.[metric] ?? fallback,
  }));
}

export function StreamedChart({
  aave,
  fluid,
  aaveV4,
  metric,
  status,
  lastChunkLatencyMs,
  pointsReceived,
}: {
  aave: SweepPoint[];
  fluid: SweepPoint[];
  aaveV4: SweepPoint[];
  metric: MetricKey;
  status: StreamStatus;
  lastChunkLatencyMs: number | null;
  pointsReceived: number;
}) {
  const rows = toChartRows(aave, fluid, aaveV4, metric);

  return (
    <div>
      <div className="legend-row" aria-hidden>
        <span><span className="legend-swatch" style={{ background: "var(--series-aave)" }} />Aave V3</span>
        <span><span className="legend-swatch" style={{ background: "var(--series-fluid)" }} />Fluid T1</span>
        <span><span className="legend-swatch" style={{ background: "var(--series-aave-v4)" }} />Aave V4</span>
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
            formatter={(value: number, name: string) => [formatValue(metric, value), SERIES_LABEL[name as "aave" | "fluid" | "aaveV4"]]}
            labelFormatter={(label: number) => `${label}% shock`}
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13 }}
          />
          <Legend
            formatter={(value: string) => SERIES_LABEL[value as "aave" | "fluid" | "aaveV4"]}
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
          <Line
            type="monotone"
            dataKey="aaveV4"
            name="aaveV4"
            stroke="var(--series-aave-v4)"
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
