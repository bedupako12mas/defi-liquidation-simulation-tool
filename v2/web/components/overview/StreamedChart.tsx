"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import type { SweepPoint } from "@/lib/api/simulate";
import type { StreamStatus } from "@/lib/hooks/useSimulationStream";

export type MetricKey = "liquidatableCollateralUsd" | "toxicPositionCount" | "badDebtUsd";

const METRIC_LABEL: Record<MetricKey, string> = {
  liquidatableCollateralUsd: "Cumulative liquidatable collateral (USD)",
  toxicPositionCount: "Positions past the toxic frontier (count)",
  badDebtUsd: "Cumulative bad debt (USD)",
};

function formatValue(metric: MetricKey, value: number): string {
  if (metric === "toxicPositionCount") return String(Math.round(value));
  return `$${Math.round(value).toLocaleString()}`;
}

interface ChartRow {
  magnitudePct: number;
  aave: number;
  fluid: number;
}

function toChartRows(aave: SweepPoint[], fluid: SweepPoint[], metric: MetricKey): ChartRow[] {
  // Streamed data can have aave/fluid arrays of different lengths mid-stream (points arrive
  // per-protocol independently) - key the merge by magnitude, not by array index, so a
  // partial chart never mismatches an aave point at one magnitude with a fluid point at
  // another while chunks are still arriving.
  const fluidByMagnitude = new Map(fluid.map((p) => [p.magnitudePct, p]));
  return aave.map((point) => ({
    magnitudePct: point.magnitudePct,
    aave: point[metric],
    fluid: fluidByMagnitude.get(point.magnitudePct)?.[metric] ?? 0,
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
