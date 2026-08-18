"use client";

/**
 * The real mainnet-fork tier (#37/#38) - the one tier that genuinely needs persistent,
 * mutable EVM state, not a per-call state-override eth_call (that's the Validation tab).
 * api/src/fork/anvilFork.ts spins up a real, ephemeral anvil fork per sync run, mines a
 * REAL transaction on it, then re-checks a second real call on the SAME fork afterward -
 * the one thing no isolated eth_call can ever observe, since every eth_call is stateless
 * relative to every other by construction.
 *
 * Two genuinely fork-requiring capabilities, both computed periodically by
 * scripts/{sync-chained-liquidation,sync-capped-rate-breach}.ts and served here as the
 * latest stored rows (same "sync writes, route reads" split as every other real-data tab):
 *  - Chained liquidation: does liquidating position/vault A for real change what a second,
 *    identical check on B reports, before vs. after A is mined?
 *  - CappedRate breach: does Fluid's real cap-enforcement logic correctly clamp an extreme
 *    raw-source move once its heartbeat genuinely elapses (real time progression, only
 *    possible on a fork)?
 */

import { useEffect, useState } from "react";
import { fetchChainedLiquidation, type ChainedLiquidationResult } from "@/lib/api/chainedLiquidation";
import { fetchCappedRateBreach, type CappedRateBreachResult } from "@/lib/api/cappedRateBreach";
import { formatTokenAmount, formatPct } from "@/lib/format";
import { InfoTooltip } from "@/components/shared/InfoTooltip";

const STATUS_TAG: Record<string, { label: string; className: string }> = {
  liquidated: { label: "Liquidated", className: "tag-healthy" },
  swept: { label: "Swept", className: "tag-healthy" },
  "unexpected-revert": { label: "Unexpected revert", className: "tag-toxic" },
  "not-applicable": { label: "Not applicable", className: "tag-na" },
  "unable-to-validate": { label: "Unable to validate", className: "tag-na" },
};

const TX_STATUS_TAG: Record<string, { label: string; className: string }> = {
  success: { label: "Success", className: "tag-healthy" },
  reverted: { label: "Reverted", className: "tag-toxic" },
  "not-attempted": { label: "Not attempted", className: "tag-na" },
};

const VERDICT_TAG: Record<string, { label: string; className: string }> = {
  // Real, team-confirmed correction: avoidForcedLiquidationsCol_=false is the deliberate,
  // protective DEFAULT (favors real liquidation over accumulating bad debt trusting a peg
  // recovery), not a gap - real vault deployments are constructed this way. Labeled/colored
  // to match: this is the expected, safe outcome for a false-flagged vault, not a warning.
  "protection-disabled": { label: "Liquidates on depeg (default)", className: "tag-healthy" },
  "clamped-as-designed": { label: "Clamped as designed", className: "tag-healthy" },
  "unclamped-beyond-bound": { label: "Unclamped beyond bound", className: "tag-toxic" },
};

function Tag({ status, map }: { status: string; map: Record<string, { label: string; className: string }> }) {
  const tag = map[status] ?? { label: status, className: "tag-na" };
  return <span className={`tag ${tag.className}`}>{tag.label}</span>;
}

function shortenAddress(addr: string): string {
  const match = addr.match(/0x[a-fA-F0-9]+/);
  if (!match) return addr;
  const full = match[0];
  const short = `${full.slice(0, 6)}…${full.slice(-4)}`;
  return addr.replace(full, short);
}

function formatHeartbeat(seconds: number): string {
  const hours = seconds / 3600;
  return hours >= 1 ? `${hours.toFixed(1)}h (${seconds.toLocaleString("en-US")}s)` : `${seconds.toLocaleString("en-US")}s`;
}

/** 1e6-scale percent (1000000 = 100%) - Fluid's own real source convention
 *  (_calcDownCappedRate's downPercent_), not this project's usual 8-decimal USD or basis
 *  points - kept as its own explicit conversion so it's never confused with either. */
function formatSixDecimalPct(raw: string): string {
  return formatPct(Number(raw) / 10_000);
}

function ChainedLiquidationTable({ rows }: { rows: ChainedLiquidationResult[] }) {
  if (rows.length === 0) return <p className="loading">No real candidates found in the last sync run.</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>A (mined for real)</th>
            <th>B (re-checked)</th>
            <th>Shock</th>
            <th>A&apos;s real tx</th>
            <th>B isolated</th>
            <th>B chained</th>
            <th>Real diff</th>
            <th>Real diff (%)</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.protocol}-${r.positionAId}-${r.positionBId}-${i}`}>
              <td><code>{shortenAddress(r.positionAId)}</code></td>
              <td><code>{shortenAddress(r.positionBId)}</code></td>
              <td className="num">{r.presetId} @ {Number(r.magnitudePct).toFixed(2)}%</td>
              <td><Tag status={r.positionATxStatus} map={TX_STATUS_TAG} /></td>
              <td>
                {r.isolatedStatus ? <Tag status={r.isolatedStatus} map={STATUS_TAG} /> : "—"}
                <br />
                <span className="num">{formatTokenAmount(r.isolatedDebtRepaid, r.debtAssetDecimals, r.debtAssetSymbol)}</span>
              </td>
              <td>
                {r.chainedStatus ? <Tag status={r.chainedStatus} map={STATUS_TAG} /> : "—"}
                <br />
                <span className="num">{formatTokenAmount(r.chainedDebtRepaid, r.debtAssetDecimals, r.debtAssetSymbol)}</span>
              </td>
              <td className="num">{formatTokenAmount(r.debtRepaidDiff, r.debtAssetDecimals, r.debtAssetSymbol)}</td>
              <td className="num">{formatPct(r.debtRepaidDiffPct)}</td>
              <td className="provenance">{r.detail ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CappedRateBreachTable({ rows }: { rows: CappedRateBreachResult[] }) {
  if (rows.length === 0) return <p className="loading">No real candidates found in the last sync run.</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>Vault</th>
            <th>Real heartbeat</th>
            <th>Peg-trust mode</th>
            <th>Configured max down</th>
            <th>Real measured drop</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.vault}-${i}`}>
              <td><code>{shortenAddress(r.vault)}</code></td>
              <td className="num">{formatHeartbeat(r.minHeartbeatSeconds)}</td>
              <td>
                {/* Neither state is inherently "good" or "bad" - a real, deliberate
                    per-asset risk configuration, not a pass/fail check - so both use the
                    same neutral, informational tag color. */}
                <span className="tag tag-cited">
                  {r.avoidForcedLiquidationsCol ? "Trust peg (accepts bad debt)" : "Liquidate on depeg (default)"}
                </span>
              </td>
              <td className="num">{formatSixDecimalPct(r.maxDownFromMaxReachedPctCol)}</td>
              <td className="num">{formatPct(r.realDropPct)}</td>
              <td><Tag status={r.verdict} map={VERDICT_TAG} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CascadeDetailTab() {
  const [chained, setChained] = useState<ChainedLiquidationResult[] | null>(null);
  const [chainedError, setChainedError] = useState<string | null>(null);
  const [breach, setBreach] = useState<CappedRateBreachResult[] | null>(null);
  const [breachError, setBreachError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchChainedLiquidation()
      .then((rows) => {
        if (!cancelled) setChained(rows);
      })
      .catch((err) => {
        if (!cancelled) setChainedError(err instanceof Error ? err.message : String(err));
      });
    fetchCappedRateBreach()
      .then((rows) => {
        if (!cancelled) setBreach(rows);
      })
      .catch((err) => {
        if (!cancelled) setBreachError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const aaveChained = chained?.filter((r) => r.protocol === "aave") ?? [];
  const fluidChained = chained?.filter((r) => r.protocol === "fluid") ?? [];

  return (
    <div>
      <div className="card">
        <h2>Real, mined transactions on a real ephemeral fork</h2>
        <p className="preset-note" style={{ marginTop: 0 }}>
          Everything on this tab requires state to genuinely persist across two separate
          real transactions - something a stateless <code>eth_call</code> (the Validation
          tab&apos;s technique) can never do by construction. Each sync run spins up a real,
          throwaway <code>anvil --fork-url</code> process, mines a real transaction on it,
          then re-checks a second real call on the exact same fork afterward. The fork is
          never deployed anywhere - it exists only for the duration of one sync run.
        </p>
      </div>

      <div className="card">
        <h2>
          Chained liquidation - does a real liquidation change what comes next?
          <InfoTooltip label="What this section checks">
            <strong>Plain language:</strong> if a real liquidator clears position/vault A
            right now, does that change what a second, identical check on B would report a
            moment later - something isolated testing can never see, since it never mines a
            real transaction at all?
            <br />
            <br />
            <strong>Technical:</strong> Aave: A&apos;s real <code>liquidationCall()</code> is
            mined, then B&apos;s <code>validateAaveLiquidation</code> result is compared
            before vs. after on the same fork - A and B are two independent real positions
            sharing the same (collateral, debt) reserve pair. Fluid: <code>liquidate()</code>{" "}
            is vault-level and tick-based, not per-user, so A and B are the SAME identical
            full-vault request, tested before vs. after A is mined - the real diff measures
            tick consumption, not per-position drift.
          </InfoTooltip>
        </h2>
        {chainedError && <div className="banner">Error talking to the API: {chainedError}.</div>}
        <h3 style={{ marginTop: "1.25rem" }}>Aave V3</h3>
        <p className="preset-note" style={{ marginTop: 0 }}>
          A real, small (~0.000001% of the isolated amount), but genuinely nonzero effect -
          reserve-index drift between A&apos;s real mined block and B&apos;s re-check.
        </p>
        {chained === null && !chainedError ? <p className="loading">Loading...</p> : <ChainedLiquidationTable rows={aaveChained} />}
        <h3 style={{ marginTop: "1.75rem" }}>Fluid T1</h3>
        <p className="preset-note" style={{ marginTop: 0 }}>
          A real, decisive effect - once A&apos;s real liquidation takes what&apos;s genuinely
          available right now, B&apos;s identical follow-up request finds exactly zero left
          (a full 100% diff), confirmed across every real candidate found. Qualitatively
          different from Aave&apos;s marginal drift: Fluid&apos;s real tick-based liquidation
          genuinely cannot be double-counted, which an isolated repeat <code>eth_call</code>{" "}
          would wrongly suggest is still available.
        </p>
        {chained === null && !chainedError ? <p className="loading">Loading...</p> : <ChainedLiquidationTable rows={fluidChained} />}
      </div>

      <div className="card">
        <h2>
          CappedRate cap-breach - does the real cap actually hold?
          <InfoTooltip label="What this section checks">
            <strong>Plain language:</strong> Fluid&apos;s LST-tracking price feeds are
            deliberately &ldquo;stale on purpose&rdquo; - they only re-check the real
            underlying rate periodically (a real &ldquo;heartbeat&rdquo;). On some assets the
            protocol chooses to hold the old rate through a depeg and trust it recovers
            (accepting temporary bad debt); on others it chooses to let the real crashed rate
            through immediately and liquidate for real instead. This checks which behavior a
            real, currently-fresh vault actually exhibits once its heartbeat genuinely
            elapses - the real mechanism behind the March 2026 Resolv exploit (~$21M bad
            debt), where that choice mattered.
            <br />
            <br />
            <strong>Technical:</strong> <code>getExchangeRateLiquidate()</code> only re-reads
            its raw source once real <code>block.timestamp</code> passes{" "}
            <code>lastUpdateTime + minHeartbeat</code> - a plain <code>eth_call</code> against
            a currently-fresh vault can never observe the AFTER state, since it can&apos;t
            move real time forward. The raw source&apos;s bytecode is persistently overridden
            to an extreme value, confirmed to have zero effect immediately after (proving the
            staleness is real), then <code>anvil_mine</code> genuinely advances{" "}
            <code>block.timestamp</code> past the real heartbeat before re-checking. Whether
            down-capping applies at all is gated by a separate, real, per-asset,
            guardian/governance-flippable flag (<code>avoidForcedLiquidationsCol_</code>) -
            true means the vault trusts the peg and holds the capped rate through a depeg
            (bad-debt-tolerant); false means it lets the real rate through and liquidates
            (bad-debt-avoidant) - confirmed against real Fluid source and team review that
            false is the deliberate default new vault deployments ship with, reserved for
            assets NOT considered safe to assume a temporary depeg on.
          </InfoTooltip>
        </h2>
        <p className="preset-note" style={{ marginTop: 0 }}>
          A real, decisive, protocol-wide finding, confirmed against real Fluid source and
          team review: every currently-fresh CappedRate vault checked has{" "}
          <code>avoidForcedLiquidationsCol_ = false</code> - the deliberate, protective
          default (real vault deployments are constructed this way), not a gap. It means an
          extreme raw-source crash propagates through{" "}
          <code>getExchangeRateLiquidate()</code> immediately and unclamped for these vaults -
          by design, so a real depeg triggers real liquidation rather than the protocol
          quietly accumulating bad debt trusting a recovery that might not come. Whether any
          specific asset&apos;s risk profile warrants flipping this to true is a real
          governance/risk decision, not something this check flags as broken. Raw before/after
          rate values are in each CappedRate&apos;s own native scale (not directly
          USD-convertible without additional context) - the real, verified drop is the %
          column.
        </p>
        {breachError && <div className="banner">Error talking to the API: {breachError}.</div>}
        {breach === null && !breachError ? <p className="loading">Loading...</p> : <CappedRateBreachTable rows={breach ?? []} />}
      </div>
    </div>
  );
}
