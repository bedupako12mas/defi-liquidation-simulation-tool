"use client";

/**
 * The real Validation tier (#30/#36) plus gas-vs-bonus profitability (#43) - the RPC tier
 * (stateless eth_call, no fork, no mined transaction). CascadeDetailTab is the mainnet-fork
 * tier (#37/#38, genuinely mined transactions on a real ephemeral fork) - now also real, a
 * separate and complementary check, not a stub anymore either.
 * Both sections are genuinely real, RPC-tier checks: for a bounded real sample of
 * positions, api/src/validation/{aaveValidator,fluidValidator}.ts override each protocol's
 * real on-chain oracle price via a state-override eth_call and check the REAL
 * liquidationCall()/liquidate() output (Validation) or a real eth_estimateGas against the
 * real bonus a liquidator would receive (Profitability) - no fork, no mined tx, nothing
 * simulated beyond read-only calls. Both are computed periodically by
 * scripts/sync-{validation-results,liquidation-profitability}.ts (real, RPC-heavy calls -
 * too slow for a request path) and served here as the latest stored rows, same
 * "sync writes, route reads" split as every other real-data tab in this app.
 *
 * Every real status either check can produce is shown as a first-class result, not just the
 * happy path - "not-applicable"/"unable-to-validate"/"unable-to-estimate-gas" are disclosed
 * scope limits (see the validators' own doc comments), not hidden failures.
 */

import { useEffect, useState } from "react";
import { fetchValidationResults, type ValidationResult, type ValidationStatus } from "@/lib/api/validation";
import { fetchLiquidationProfitability, type LiquidationProfitability, type ProfitabilityStatus } from "@/lib/api/profitability";
import { formatTokenAmount, formatUsd8, formatGas, formatMagnitudePct } from "@/lib/format";
import { InfoTooltip } from "@/components/shared/InfoTooltip";

const VALIDATION_STATUS_TAG: Record<ValidationStatus, { label: string; className: string }> = {
  matched: { label: "Matched", className: "tag-healthy" },
  "matched-within-drift": { label: "Matched (within drift)", className: "tag-healthy" },
  swept: { label: "Swept", className: "tag-healthy" },
  mismatched: { label: "Mismatched", className: "tag-toxic" },
  "unexpected-revert": { label: "Unexpected revert", className: "tag-toxic" },
  "not-applicable": { label: "Not applicable", className: "tag-na" },
  "unable-to-validate": { label: "Unable to validate", className: "tag-na" },
};

const PROFITABILITY_STATUS_TAG: Record<ProfitabilityStatus, { label: string; className: string }> = {
  profitable: { label: "Profitable", className: "tag-healthy" },
  unprofitable: { label: "Unprofitable", className: "tag-toxic" },
  "unable-to-validate": { label: "Unable to validate", className: "tag-na" },
  "unable-to-estimate-gas": { label: "Unable to estimate gas", className: "tag-na" },
};

function StatusTag<S extends string>({ status, map }: { status: S; map: Record<S, { label: string; className: string }> }) {
  const tag = map[status];
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

function summarize<S extends string>(rows: { status: S }[], map: Record<S, { label: string; className: string }>): string {
  const counts = new Map<S, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, n]) => `${n} ${map[status].label.toLowerCase()}`).join(", ");
}

function AaveValidationTable({ rows }: { rows: ValidationResult[] }) {
  if (rows.length === 0) return <p className="loading">No Aave validation results yet.</p>;
  return (
    <>
      <p className="preset-note" style={{ marginTop: 0 }}>{rows.length} real positions checked - {summarize(rows, VALIDATION_STATUS_TAG)}.</p>
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
                <td className="num">{r.presetId} @ {formatMagnitudePct(r.magnitudePct)}</td>
                <td><StatusTag status={r.status} map={VALIDATION_STATUS_TAG} /></td>
                <td className="num">{formatTokenAmount(r.expectedAmount, r.debtAssetDecimals, r.debtAssetSymbol)}</td>
                <td className="num">{formatTokenAmount(r.actualAmount, r.debtAssetDecimals, r.debtAssetSymbol)}</td>
                <td className="provenance">{r.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FluidValidationTable({ rows }: { rows: ValidationResult[] }) {
  if (rows.length === 0) return <p className="loading">No Fluid validation results yet.</p>;
  return (
    <>
      <p className="preset-note" style={{ marginTop: 0 }}>{rows.length} real positions checked - {summarize(rows, VALIDATION_STATUS_TAG)}.</p>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Position</th>
              <th>Shock</th>
              <th>Status</th>
              <th>Actual debt swept</th>
              <th>Actual collateral seized</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.protocol}-${r.positionId}-${r.presetId}`}>
                <td><code>{shortenPositionId(r.positionId)}</code></td>
                <td className="num">{r.presetId} @ {formatMagnitudePct(r.magnitudePct)}</td>
                <td><StatusTag status={r.status} map={VALIDATION_STATUS_TAG} /></td>
                <td className="num">{formatTokenAmount(r.actualAmount, r.debtAssetDecimals, r.debtAssetSymbol)}</td>
                <td className="num">{formatTokenAmount(r.actualCollateralAmount, r.collateralAssetDecimals, r.collateralAssetSymbol)}</td>
                <td className="provenance">{r.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** "unable-to-validate" rows never produced a real economic result at all (the position
 *  never crossed threshold within the tested magnitude range, or its oracle isn't a
 *  supported hop pattern) - genuinely zero signal, unlike "unable-to-estimate-gas" (which
 *  DID become liquidatable and hit a real, specific constraint like MustNotLeaveDust) or
 *  profitable/unprofitable (a real computed outcome). A real, confirmed-live case: a
 *  sampled Fluid book where every single row landed here gave a reader zero actionable
 *  information from 25 near-identical dead rows - collapsed into a grouped summary instead,
 *  keeping every row with a real attempted outcome fully detailed. */
function normalizeReason(detail: string | null): string {
  if (!detail) return "no reason given";
  // Strip a trailing "(HF=1.2345)"-style parenthetical so e.g. 15 real HF values that are
  // otherwise the identical real reason group into one line, not 15 near-duplicate ones.
  return detail.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function ProfitabilityTable({ rows }: { rows: LiquidationProfitability[] }) {
  if (rows.length === 0) return <p className="loading">No profitability results yet.</p>;

  const signalRows = rows.filter((r) => r.status !== "unable-to-validate");
  const noSignalRows = rows.filter((r) => r.status === "unable-to-validate");

  const noSignalGroups = new Map<string, number>();
  for (const r of noSignalRows) {
    const key = normalizeReason(r.detail);
    noSignalGroups.set(key, (noSignalGroups.get(key) ?? 0) + 1);
  }

  return (
    <>
      <p className="preset-note" style={{ marginTop: 0 }}>{rows.length} real (position, shock magnitude) pairs checked - {summarize(rows, PROFITABILITY_STATUS_TAG)}.</p>
      {signalRows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Position</th>
                <th>Shock</th>
                <th>Status</th>
                <th>Gas used</th>
                <th>Gas cost</th>
                <th>Debt cleared</th>
                <th>Bonus received</th>
                <th>Net profit</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {signalRows.map((r, i) => (
                <tr key={`${r.protocol}-${r.positionId}-${r.presetId}-${r.magnitudePct}-${i}`}>
                  <td><code>{shortenPositionId(r.positionId)}</code></td>
                  <td className="num">{r.presetId} @ {formatMagnitudePct(r.magnitudePct)}</td>
                  <td><StatusTag status={r.status} map={PROFITABILITY_STATUS_TAG} /></td>
                  <td className="num">{formatGas(r.gasUsed)}</td>
                  <td className="num">{formatUsd8(r.gasCostUsd8)}</td>
                  <td className="num">{formatUsd8(r.debtClearedUsd8)}</td>
                  <td className="num">{formatUsd8(r.bonusValueUsd8)}</td>
                  <td className="num">{formatUsd8(r.netProfitUsd8)}</td>
                  <td className="provenance">{r.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {noSignalGroups.size > 0 && (
        <p className="preset-note">
          <strong>{noSignalRows.length} of {rows.length} positions gave no real economic
          signal</strong> (never became liquidatable within the tested magnitude range, or an
          unsupported oracle - a disclosed scope limit, not a hidden failure):{" "}
          {[...noSignalGroups.entries()].map(([reason, count], i) => (
            <span key={reason}>
              {i > 0 ? "; " : ""}
              {count} × {reason}
            </span>
          ))}
          .
        </p>
      )}
    </>
  );
}

export function ValidationTab() {
  const [results, setResults] = useState<ValidationResult[] | null>(null);
  const [resultsError, setResultsError] = useState<string | null>(null);
  const [profitability, setProfitability] = useState<LiquidationProfitability[] | null>(null);
  const [profitabilityError, setProfitabilityError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchValidationResults()
      .then((rows) => {
        if (!cancelled) setResults(rows);
      })
      .catch((err) => {
        if (!cancelled) setResultsError(err instanceof Error ? err.message : String(err));
      });
    fetchLiquidationProfitability()
      .then((rows) => {
        if (!cancelled) setProfitability(rows);
      })
      .catch((err) => {
        if (!cancelled) setProfitabilityError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const aaveRows = results?.filter((r) => r.protocol === "aave") ?? [];
  const fluidRows = results?.filter((r) => r.protocol === "fluid") ?? [];
  const aaveProfitability = profitability?.filter((r) => r.protocol === "aave") ?? [];
  const fluidProfitability = profitability?.filter((r) => r.protocol === "fluid") ?? [];

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
          failures - they&apos;re shown as real outcomes, not filtered out. All amounts below
          are the real asset&apos;s own units (e.g. USDC, wstETH), decimal-adjusted and
          labeled - never a bare, unlabeled number.
        </p>
      </div>

      {resultsError && <div className="banner">Error talking to the API: {resultsError}.</div>}

      <div className="card">
        <h2>Aave V3 - correctness check</h2>
        {results === null && !resultsError ? <p className="loading">Loading...</p> : <AaveValidationTable rows={aaveRows} />}
      </div>

      <div className="card">
        <h2>Fluid T1 - correctness check</h2>
        {results === null && !resultsError ? <p className="loading">Loading...</p> : <FluidValidationTable rows={fluidRows} />}
      </div>

      <div className="card">
        <h2>
          Gas vs. bonus - is it actually worth a liquidator&apos;s time?
          <InfoTooltip label="What this section checks">
            <strong>Plain language:</strong> a liquidation only really happens if a real
            liquidator profits from it after paying real gas. This checks that directly - a
            real gas estimate against a real bonus, at real (if currently very low) gas
            prices.
            <br />
            <br />
            <strong>Technical:</strong> real <code>eth_estimateGas</code> against both
            protocols&apos; actual deployed contracts, converted to USD via the real current
            gas price and real ETH/USD, compared against the real bonus a liquidator would
            receive. Both protocols are tested under the SAME &ldquo;correlated&rdquo; shock
            scenario specifically so the comparison is fair - see the Glossary
            (Methodology tab) for why that matters.
          </InfoTooltip>
        </h2>
        <p className="preset-note" style={{ marginTop: 0 }}>
          Each row is one real (position, shock magnitude) attempt - the magnitude ladder
          stops at the first magnitude where the position is genuinely profitable, so a
          position with several rows shows its real path from unprofitable to profitable as
          the shock deepens.
        </p>
        {profitabilityError && <div className="banner">Error talking to the API: {profitabilityError}.</div>}
        <h3 style={{ marginTop: "1.25rem" }}>Aave V3</h3>
        {profitability === null && !profitabilityError ? <p className="loading">Loading...</p> : <ProfitabilityTable rows={aaveProfitability} />}
        <h3 style={{ marginTop: "1.75rem" }}>Fluid T1</h3>
        {profitability === null && !profitabilityError ? <p className="loading">Loading...</p> : <ProfitabilityTable rows={fluidProfitability} />}
      </div>
    </div>
  );
}
