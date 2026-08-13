"use client";

/**
 * Per-position detail at one selected shock magnitude - the v2 extension `/api/positions`
 * exposes (see lib/api/simulate.ts's top comment) that v1's aggregate-only SweepPoint never
 * had. Independent request from the streamed sweep chart: this is "pick one point, get every
 * position's health/LTV/toxic state at it," not part of the sweep stream itself.
 */

import { useEffect, useState } from "react";
import {
  fetchPositionSnapshot,
  fetchKillPrices,
  fetchMarketConcentration,
  type PositionSnapshot,
  type KillPriceResult,
  type MarketConcentrationEntry,
  type Protocol,
} from "@/lib/api/simulate";
import type { ShockPreset } from "@/lib/api/meta";

const MAGNITUDE_MIN = 0;
const MAGNITUDE_MAX = -80;
const MAGNITUDE_STEP = 5;

const STATE_LABEL: Record<PositionSnapshot["state"], string> = {
  healthy: "Healthy",
  liquidatable: "Liquidatable",
  eligible: "Eligible",
  toxic: "Toxic",
};

/** Identifies which (preset, magnitude, protocol) combination a fetched result belongs to. */
function requestKey(presetId: ShockPreset["id"], magnitudePct: number, protocol: Protocol): string {
  return `${presetId}|${magnitudePct}|${protocol}`;
}

/** Identifies a (preset, protocol) result - kill-price is magnitude-independent (it scans
 *  the whole range itself), so it's keyed without magnitudePct, unlike requestKey above. */
function presetProtocolKey(presetId: ShockPreset["id"], protocol: Protocol): string {
  return `${presetId}|${protocol}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * Visualizes where a position's LTV sits relative to its two real thresholds: the
 * liquidation Threshold (crossing it -> "Liquidatable") and the UC Frontier (crossing it
 * -> "Toxic", a much higher bar - see docs/decisions.md / api's toxicLiquidation.ts). Built
 * to make the distinction between these two states visible at a glance, not just as two
 * disconnected numbers in adjacent columns.
 */
function LtvLadder({
  ltvPct,
  thresholdPct,
  ucFrontierPct,
  state,
}: {
  ltvPct: number | null;
  thresholdPct: number | null;
  ucFrontierPct: number;
  state: PositionSnapshot["state"];
}) {
  if (ltvPct === null || thresholdPct === null) {
    return <span className="ltv-ladder-na">—</span>;
  }
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const ltvPos = clamp(ltvPct);
  const thresholdPos = clamp(thresholdPct);
  const ucPos = clamp(ucFrontierPct);

  return (
    <div
      className="ltv-ladder"
      title={`LTV ${ltvPct.toFixed(1)}% / threshold ${thresholdPct.toFixed(1)}% / UC frontier ${ucFrontierPct.toFixed(1)}%`}
    >
      <div className="ltv-ladder-track">
        <div
          className="ltv-ladder-zone ltv-ladder-zone-liquidatable"
          style={{ left: `${thresholdPos}%`, width: `${Math.max(0, ucPos - thresholdPos)}%` }}
        />
        <div className="ltv-ladder-zone ltv-ladder-zone-toxic" style={{ left: `${ucPos}%`, width: `${Math.max(0, 100 - ucPos)}%` }} />
        <div className="ltv-ladder-tick" style={{ left: `${thresholdPos}%` }} />
        <div className="ltv-ladder-tick" style={{ left: `${ucPos}%` }} />
        <div className="ltv-ladder-marker" data-state={state} style={{ left: `${ltvPos}%` }} />
      </div>
    </div>
  );
}

export function PositionDrilldown({ presetId }: { presetId: ShockPreset["id"] }) {
  const [protocol, setProtocol] = useState<Protocol>("aave");
  const [magnitudePct, setMagnitudePct] = useState(-30);
  // Keyed result, not a bare array - see useSimulationStream.ts's comment for why setState
  // never runs synchronously at the top of the effect (react-hooks/set-state-in-effect):
  // every setState call below happens inside the fetch's .then()/.catch(), and "loading" is
  // derived at render time by comparing the result's key to the currently-requested one.
  const [result, setResult] = useState<{ key: string; rows: PositionSnapshot[] } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const currentKey = requestKey(presetId, magnitudePct, protocol);

  const [killPriceResult, setKillPriceResult] = useState<{ key: string; rows: KillPriceResult[] } | null>(null);
  const [marketResult, setMarketResult] = useState<{ key: string; rows: MarketConcentrationEntry[] } | null>(null);
  const currentPresetProtocolKey = presetProtocolKey(presetId, protocol);

  useEffect(() => {
    let cancelled = false;
    const key = requestKey(presetId, magnitudePct, protocol);
    fetchPositionSnapshot(presetId, magnitudePct, protocol)
      .then((rows) => {
        if (!cancelled) setResult({ key, rows });
      })
      .catch((err) => {
        if (!cancelled) setError({ key, message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [presetId, magnitudePct, protocol]);

  // Kill-price scans the whole magnitude range server-side - fetched once per
  // (preset, protocol), not re-fetched on every slider move like the snapshot above.
  useEffect(() => {
    let cancelled = false;
    const key = presetProtocolKey(presetId, protocol);
    fetchKillPrices(presetId, protocol).then((rows) => {
      if (!cancelled) setKillPriceResult({ key, rows });
    });
    return () => {
      cancelled = true;
    };
  }, [presetId, protocol]);

  useEffect(() => {
    let cancelled = false;
    const key = requestKey(presetId, magnitudePct, protocol);
    fetchMarketConcentration(presetId, magnitudePct, protocol).then((rows) => {
      if (!cancelled) setMarketResult({ key, rows });
    });
    return () => {
      cancelled = true;
    };
  }, [presetId, magnitudePct, protocol]);

  const snapshot = result && result.key === currentKey ? result.rows : null;
  const currentError = error && error.key === currentKey ? error.message : null;
  const killPrices = killPriceResult && killPriceResult.key === currentPresetProtocolKey ? killPriceResult.rows : null;
  const markets = marketResult && marketResult.key === currentKey ? marketResult.rows : null;

  const counts = snapshot?.reduce(
    (acc, row) => {
      acc[row.state] += 1;
      return acc;
    },
    { healthy: 0, liquidatable: 0, eligible: 0, toxic: 0 }
  );
  // Only one of liquidatable/eligible is ever nonzero for a given protocol's rows (Aave
  // uses "liquidatable", Fluid uses "eligible" - see lib/api/simulate.ts's PositionState
  // comment) - summed for the single middle grid cell, labeled per the active protocol.
  const belowThresholdCount = counts ? counts.liquidatable + counts.eligible : 0;
  const belowThresholdLabel = protocol === "fluid" ? "Eligible (within sweep range)" : "Liquidatable (recoverable)";

  // Metric 1: count-based %, not a raw total - comparable across Aave's small sample and
  // Fluid's large one without either being dominated by absolute sample size. See
  // docs/decisions.md's "5 rigorous comparison metrics" entry for why count-based (not
  // dollar-based) is the more robust primary normalization.
  const totalCount = snapshot?.length ?? 0;
  const pct = (n: number) => (totalCount > 0 ? ((n / totalCount) * 100).toFixed(1) : "—");

  // Metric 3: concentration - what share of at-risk collateral sits in the single
  // largest at-risk position. High = lumpy/whale-dominated risk, low = broadly spread.
  const atRiskRows = snapshot?.filter((r) => r.state === "liquidatable" || r.state === "eligible" || r.state === "toxic") ?? [];
  const totalAtRiskUsd = atRiskRows.reduce((sum, r) => sum + r.collateralUsd, 0);
  const largestAtRiskUsd = atRiskRows.reduce((max, r) => Math.max(max, r.collateralUsd), 0);
  const concentrationPct = totalAtRiskUsd > 0 ? (largestAtRiskUsd / totalAtRiskUsd) * 100 : null;

  // Metric 4: bad-debt severity among only the underwater subset - median debt/collateral
  // ratio, not the summed dollar total, so one catastrophic position doesn't get
  // conflated with many barely-underwater ones.
  const underwaterRatios = (snapshot ?? [])
    .filter((r) => r.badDebtUsd > 0 && r.collateralUsd > 0)
    .map((r) => r.debtUsd / r.collateralUsd);
  const severityMedian = median(underwaterRatios);

  // Metric 2: headroom - median shock magnitude at which a position crosses its
  // threshold, across positions that ever cross within the -80% range.
  const crossingMagnitudes = (killPrices ?? [])
    .map((r) => r.killMagnitudePct)
    .filter((m): m is number => m !== null);
  const headroomMedian = median(crossingMagnitudes);
  const neverCrossesCount = killPrices ? killPrices.length - crossingMagnitudes.length : null;

  return (
    <div>
      <div className="controls-row">
        <div className="pill-group">
          {(["aave", "fluid"] as const).map((p) => (
            <button
              key={p}
              type="button"
              className="pill"
              data-active={protocol === p}
              onClick={() => setProtocol(p)}
            >
              {p === "aave" ? "Aave V3" : "Fluid T1"}
            </button>
          ))}
        </div>
      </div>

      <label htmlFor="magnitude-slider" style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
        Shock magnitude: {magnitudePct}%
      </label>
      <input
        id="magnitude-slider"
        className="magnitude-slider"
        type="range"
        min={MAGNITUDE_MAX}
        max={MAGNITUDE_MIN}
        step={MAGNITUDE_STEP}
        value={magnitudePct}
        onChange={(e) => setMagnitudePct(Number(e.target.value))}
      />

      {currentError && <div className="banner">Error fetching position snapshot: {currentError}</div>}

      {!currentError && !snapshot && <p className="loading">Loading position detail...</p>}

      {snapshot && counts && (
        <>
          <div className="three-state-grid">
            <div className="three-state-cell">
              <div className="count">
                {counts.healthy} <span className="count-pct">({pct(counts.healthy)}%)</span>
              </div>
              <div className="label">Healthy</div>
            </div>
            <div className="three-state-cell">
              <div className="count">
                {belowThresholdCount} <span className="count-pct">({pct(belowThresholdCount)}%)</span>
              </div>
              <div className="label">{belowThresholdLabel}</div>
            </div>
            <div className="three-state-cell">
              <div className="count">
                {counts.toxic} <span className="count-pct">({pct(counts.toxic)}%)</span>
              </div>
              <div className="label">Toxic (past UC frontier)</div>
            </div>
          </div>

          <p className="explainer">
            A position becomes <strong>Liquidatable</strong> once its LTV crosses the
            liquidation <strong>Threshold</strong> (first tick below) - the protocol&apos;s
            own eligibility bar. It only becomes <strong>Toxic</strong> past the{" "}
            <strong>UC Frontier</strong> (second tick) - a much higher bar past which any
            further liquidation under a fixed bonus mechanically worsens the position&apos;s
            LTV, not just an already-bad state. Toxic is always a subset of Liquidatable, not
            a separate condition. Percentages are of the sampled book (count-based, not
            dollar-based) - the fair way to compare Aave&apos;s and Fluid&apos;s very
            different sample sizes without either being distorted by a single large
            position.
          </p>

          <div className="three-state-grid" style={{ marginTop: "0.5rem" }}>
            <div className="three-state-cell">
              <div className="count">{concentrationPct === null ? "—" : `${concentrationPct.toFixed(1)}%`}</div>
              <div className="label">Largest at-risk position&apos;s share of at-risk collateral</div>
            </div>
            <div className="three-state-cell">
              <div className="count">{severityMedian === null ? "—" : `${(severityMedian * 100).toFixed(0)}%`}</div>
              <div className="label">Median debt/collateral ratio, underwater positions only</div>
            </div>
            <div className="three-state-cell">
              <div className="count">
                {headroomMedian === null ? "—" : `${headroomMedian.toFixed(0)}%`}
                {neverCrossesCount !== null && killPrices && (
                  <span className="count-pct"> ({neverCrossesCount} of {killPrices.length} never cross)</span>
                )}
              </div>
              <div className="label">Median shock magnitude at which a position first crosses its threshold</div>
            </div>
          </div>

          {markets && markets.length > 0 && (
            <div style={{ marginTop: "1rem" }}>
              <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "0.4rem" }}>
                At-risk debt by {protocol === "aave" ? "reserve" : "vault"} (top 5) - each
                protocol&apos;s own isolated-market unit, not a forced-common grouping.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>{protocol === "aave" ? "Reserve" : "Vault"}</th>
                    <th>At-risk debt (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {markets.slice(0, 5).map((m) => (
                    <tr key={m.market}>
                      <td>{protocol === "fluid" ? `${m.market.slice(0, 10)}...` : m.market}</td>
                      <td className="num">${Math.round(m.atRiskDebtUsd).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Collateral (USD)</th>
                  <th>Debt (USD)</th>
                  <th>Health factor</th>
                  <th>LTV vs. Threshold vs. UC frontier</th>
                  <th>State</th>
                  <th>Bad debt (USD)</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.map((row) => (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    <td className="num">${Math.round(row.collateralUsd).toLocaleString()}</td>
                    <td className="num">${Math.round(row.debtUsd).toLocaleString()}</td>
                    <td className="num">{row.healthFactor === null ? "—" : row.healthFactor.toFixed(3)}</td>
                    <td>
                      <LtvLadder
                        ltvPct={row.ltvPct}
                        thresholdPct={row.effectiveThresholdPct}
                        ucFrontierPct={row.ucFrontierPct}
                        state={row.state}
                      />
                      <div className="ltv-ladder-values">
                        {row.ltvPct === null || row.effectiveThresholdPct === null
                          ? "—"
                          : `${row.ltvPct.toFixed(1)}% / ${row.effectiveThresholdPct.toFixed(1)}% / ${row.ucFrontierPct.toFixed(1)}%`}
                      </div>
                    </td>
                    <td>
                      <span className={`tag tag-${row.state}`}>{STATE_LABEL[row.state]}</span>
                    </td>
                    <td className="num">{row.badDebtUsd > 0 ? `$${Math.round(row.badDebtUsd).toLocaleString()}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
