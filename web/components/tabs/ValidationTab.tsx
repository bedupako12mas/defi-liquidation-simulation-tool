"use client";

/**
 * The real Validation tier (#30/#36) - not a fork-replay tier (that's Milestone 2, still a
 * ComingSoonPanel stub in CascadeDetailTab). This is a genuinely real, RPC-tier check: for
 * a bounded real sample of positions, api/src/validation/{aaveValidator,fluidValidator}.ts
 * override each protocol's real on-chain oracle price via a state-override eth_call and
 * check the REAL liquidationCall()/liquidate() output - no fork, no mined tx, nothing
 * simulated beyond a read-only eth_call. Results are computed periodically by
 * scripts/sync-validation-results.ts (real, RPC-heavy state-override calls - too slow for a
 * request path) and served here as the latest stored rows, same "sync writes, route reads"
 * split as every other real-data tab in this app.
 *
 * Every real status a validator run can produce is shown here as a first-class result, not
 * just the happy path - "not-applicable"/"unable-to-validate" are disclosed scope limits
 * (see the two validators' own doc comments), not hidden failures, and get the same visible
 * treatment as a genuine match or a genuine problem.
 */

import { useEffect, useState } from "react";
import { fetchValidationResults, type ValidationResult, type ValidationStatus } from "@/lib/api/validation";

const STATUS_TAG: Record<ValidationStatus, { label: string; className: string }> = {
  matched: { label: "Matched", className: "tag-healthy" },
  "matched-within-drift": { label: "Matched (within drift)", className: "tag-healthy" },
  swept: { label: "Swept", className: "tag-healthy" },
  mismatched: { label: "Mismatched", className: "tag-toxic" },
  "unexpected-revert": { label: "Unexpected revert", className: "tag-toxic" },
  "not-applicable": { label: "Not applicable", className: "tag-na" },
  "unable-to-validate": { label: "Unable to validate", className: "tag-na" },
};

function StatusTag({ status }: { status: ValidationStatus }) {
  const tag = STATUS_TAG[status];
  return <span className={`tag ${tag.className}`}>{tag.label}</span>;
}

function shortenPositionId(id: string): string {
  // "aave-0xabc...123" / "fluid-0xabc...123-42" - keep the protocol prefix and a shortened
  // address, drop the middle. Long enough to distinguish real rows, short enough for a table.
  const parts = id.split("-");
  const addr = parts.find((p) => p.startsWith("0x"));
  if (!addr) return id;
  const shortAddr = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  return id.replace(addr, shortAddr);
}

function formatAmount(raw: string | null): string {
  if (raw === null) return "—";
  // Raw on-chain integer units (varies by token decimals per position) - shown as-is with
  // thousands separators rather than guessing a decimals value this table doesn't have,
  // which would risk silently misrepresenting the real magnitude.
  return BigInt(raw).toLocaleString("en-US");
}

function summarize(rows: ValidationResult[]): string {
  const counts = new Map<ValidationStatus, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, n]) => `${n} ${STATUS_TAG[status].label.toLowerCase()}`).join(", ");
}

function AaveTable({ rows }: { rows: ValidationResult[] }) {
  if (rows.length === 0) return <p className="loading">No Aave validation results yet.</p>;
  return (
    <>
      <p className="preset-note" style={{ marginTop: 0 }}>{rows.length} real positions checked - {summarize(rows)}.</p>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Position</th>
              <th>Shock</th>
              <th>Status</th>
              <th>Expected debt repaid</th>
              <th>Actual debt repaid</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.protocol}-${r.positionId}-${r.presetId}`}>
                <td><code>{shortenPositionId(r.positionId)}</code></td>
                <td className="num">{r.presetId} @ {r.magnitudePct}%</td>
                <td><StatusTag status={r.status} /></td>
                <td className="num">{formatAmount(r.expectedAmount)}</td>
                <td className="num">{formatAmount(r.actualAmount)}</td>
                <td className="provenance">{r.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FluidTable({ rows }: { rows: ValidationResult[] }) {
  if (rows.length === 0) return <p className="loading">No Fluid validation results yet.</p>;
  return (
    <>
      <p className="preset-note" style={{ marginTop: 0 }}>{rows.length} real positions checked - {summarize(rows)}.</p>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Position</th>
              <th>Shock</th>
              <th>Status</th>
              <th>Actual debt swept</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.protocol}-${r.positionId}-${r.presetId}`}>
                <td><code>{shortenPositionId(r.positionId)}</code></td>
                <td className="num">{r.presetId} @ {r.magnitudePct}%</td>
                <td><StatusTag status={r.status} /></td>
                <td className="num">{formatAmount(r.actualAmount)}</td>
                <td className="provenance">{r.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ValidationTab() {
  const [results, setResults] = useState<ValidationResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchValidationResults()
      .then((rows) => {
        if (!cancelled) setResults(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const aaveRows = results?.filter((r) => r.protocol === "aave") ?? [];
  const fluidRows = results?.filter((r) => r.protocol === "fluid") ?? [];

  return (
    <div>
      <div className="card">
        <h2>Real liquidation calls, not a simulation</h2>
        <p className="preset-note" style={{ marginTop: 0 }}>
          Every row below is a real <code>eth_call</code> against Aave&apos;s actual deployed{" "}
          <code>Pool</code> or Fluid&apos;s actual deployed vault, at a hypothetical shocked
          price injected via a state override on the real on-chain oracle - not a fork, not a
          mined transaction, nothing simulated beyond a read-only call. It checks whether the
          engine&apos;s own bad-debt math actually matches what the real contract would do.
        </p>
        <p className="preset-note">
          Aave: the collateral and debt asset&apos;s real oracle feeds are both overridden to
          the shocked price, then a real <code>liquidationCall()</code> is checked against an
          independently-computed expected debt amount (Aave&apos;s real close-factor and
          collateral-availability caps, not a simplified approximation). Fluid: the vault
          oracle&apos;s Chainlink/Redstone hop (market shocks) or CappedRate hop (LST-depeg
          shocks) is overridden, then a real <code>liquidate()</code> dry-run (
          <code>to = 0xdead</code>, reverts before any token movement either way) reports the
          real amount it would sweep. Both are read-only - no funds ever move.
        </p>
        <p className="preset-note">
          &ldquo;Not applicable&rdquo; and &ldquo;unable to validate&rdquo; are disclosed scope
          limits (e.g. a vault whose oracle isn&apos;t the supported hop pattern, or an{" "}
          <code>eth_call</code> too large for this deploy&apos;s RPC tier), not hidden
          failures - they&apos;re shown as real outcomes, not filtered out.
        </p>
      </div>

      {error && <div className="banner">Error talking to the API: {error}.</div>}

      <div className="card">
        <h2>Aave V3</h2>
        {results === null && !error ? <p className="loading">Loading...</p> : <AaveTable rows={aaveRows} />}
      </div>

      <div className="card">
        <h2>Fluid T1</h2>
        {results === null && !error ? <p className="loading">Loading...</p> : <FluidTable rows={fluidRows} />}
      </div>
    </div>
  );
}
