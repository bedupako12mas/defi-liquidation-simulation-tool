"use client";

import { useCapabilities } from "@/lib/hooks/useCapabilities";
import { UcFrontierTable } from "@/components/overview/UcFrontierTable";
import { LimitationsPanel } from "@/components/shared/LimitationsPanel";

export function MethodologyTab() {
  const { meta, loading, error } = useCapabilities();

  return (
    <div>
      <div className="card">
        <h2>The three position states</h2>
        <p className="preset-note" style={{ marginTop: 0, marginBottom: "1rem" }}>
          At any shocked price, every position is in exactly one of three states (Warmuz,
          Chaudhary &amp; Pinna, <em>Toxic Liquidation Spirals</em>, arXiv:2212.07306):
        </p>
        <div className="three-state-grid">
          <div className="three-state-cell">
            <div className="label" style={{ marginBottom: "0.4rem" }}>
              <span className="tag tag-healthy">Healthy</span>
            </div>
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
              Health factor &ge; 1. No liquidation is possible.
            </div>
          </div>
          <div className="three-state-cell">
            <div className="label" style={{ marginBottom: "0.4rem" }}>
              <span className="tag tag-liquidatable">Liquidatable</span>
            </div>
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
              Health factor &lt; 1, but current LTV is still under the undercollateralization
              (UC) frontier, 1/(1+i). A liquidation here can restore health.
            </div>
          </div>
          <div className="three-state-cell">
            <div className="label" style={{ marginBottom: "0.4rem" }}>
              <span className="tag tag-toxic">Toxic</span>
            </div>
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
              Current LTV has crossed the UC frontier. Under the paper&apos;s Eq. 4, any
              liquidation at the current fixed incentive is guaranteed to make LTV worse, not
              better - the mechanism that produces bad debt, not merely a risk of it.
            </div>
          </div>
        </div>
        <p className="preset-note">
          The Overview tab&apos;s per-position drilldown classifies every position into one of
          these three states, live, at whatever shock magnitude is selected.
        </p>
      </div>

      <div className="card">
        <h2>The undercollateralization frontier - LTV_UC = 1 / (1 + i)</h2>
        <p className="preset-note" style={{ marginTop: 0, marginBottom: "1rem" }}>
          A liquidation above this frontier is mathematically guaranteed to make the position
          worse, not better (Warmuz, Chaudhary &amp; Pinna, arXiv:2212.07306). Low incentive
          &rarr; high frontier &rarr; real headroom for a high liquidation threshold.
        </p>
        {loading && <p className="loading">Loading...</p>}
        {error && <div className="banner">Error talking to the API: {error}.</div>}
        {meta && <UcFrontierTable rows={meta.ucFrontier} />}
      </div>

      <div className="card">
        <h2>Known limitations</h2>
        {loading && <p className="loading">Loading...</p>}
        {meta && <LimitationsPanel limitations={meta.limitations} />}
      </div>
    </div>
  );
}
