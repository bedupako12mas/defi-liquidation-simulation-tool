"use client";

/**
 * Per-position detail at one selected shock magnitude - the v2 extension `/api/positions`
 * exposes (see lib/api/simulate.ts's top comment) that v1's aggregate-only SweepPoint never
 * had. Independent request from the streamed sweep chart: this is "pick one point, get every
 * position's health/LTV/toxic state at it," not part of the sweep stream itself.
 */

import { useEffect, useState } from "react";
import { fetchPositionSnapshot, type PositionSnapshot, type Protocol } from "@/lib/api/simulate";
import type { ShockPreset } from "@/lib/api/meta";

const MAGNITUDE_MIN = 0;
const MAGNITUDE_MAX = -80;
const MAGNITUDE_STEP = 5;

const STATE_LABEL: Record<PositionSnapshot["state"], string> = {
  healthy: "Healthy",
  liquidatable: "Liquidatable",
  toxic: "Toxic",
};

/** Identifies which (preset, magnitude, protocol) combination a fetched result belongs to. */
function requestKey(presetId: ShockPreset["id"], magnitudePct: number, protocol: Protocol): string {
  return `${presetId}|${magnitudePct}|${protocol}`;
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

  const snapshot = result && result.key === currentKey ? result.rows : null;
  const currentError = error && error.key === currentKey ? error.message : null;

  const counts = snapshot?.reduce(
    (acc, row) => {
      acc[row.state] += 1;
      return acc;
    },
    { healthy: 0, liquidatable: 0, toxic: 0 }
  );

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
              <div className="count">{counts.healthy}</div>
              <div className="label">Healthy</div>
            </div>
            <div className="three-state-cell">
              <div className="count">{counts.liquidatable}</div>
              <div className="label">Liquidatable (recoverable)</div>
            </div>
            <div className="three-state-cell">
              <div className="count">{counts.toxic}</div>
              <div className="label">Toxic (past UC frontier)</div>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Collateral (USD)</th>
                  <th>Debt (USD)</th>
                  <th>Health factor</th>
                  <th>LTV</th>
                  <th>UC frontier</th>
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
                    <td className="num">{row.ltvPct === null ? "—" : `${row.ltvPct.toFixed(1)}%`}</td>
                    <td className="num">{row.ucFrontierPct.toFixed(1)}%</td>
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
