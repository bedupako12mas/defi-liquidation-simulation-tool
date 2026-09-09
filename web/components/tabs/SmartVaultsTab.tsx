"use client";

/**
 * Deploy 1/6 - Fluid T2 (smart collateral, normal debt). Real T2 vaults valued under the
 * full shock sweep via oracle-override repricing of the smart-collateral leg's real DEX
 * reserves (api/src/db/syncFluidT2Shock.ts) - see docs/decisions.md's 2026-08-25 entry for
 * why a swap-simulation approach was tried first and abandoned: Fluid's own single-swap
 * price-impact cap makes it structurally incapable of reaching realistic depeg magnitudes on
 * a well-capitalized pool.
 *
 * Interactive, same pattern as Overview/PositionDrilldown's magnitude slider - the sweep is
 * already fully computed and fetched once (all 81 magnitudes x 5 presets x every vault), so
 * dragging the slider just filters the already-in-memory data, no refetch per drag tick. An
 * earlier version of this tab showed one static row per vault fixed at -50% with no way to
 * move it - a real product gap, caught by the user pointing out there was nothing to
 * actually simulate.
 */

import { useEffect, useMemo, useState } from "react";
import { fetchFluidT2Shock, type FluidT2ShockResult } from "@/lib/api/fluidT2Shock";
import { formatUsd8 } from "@/lib/format";
import { InfoTooltip } from "@/components/shared/InfoTooltip";

const MAGNITUDE_MIN = 0;
const MAGNITUDE_MAX = -80;
const MAGNITUDE_STEP = 1;

const PRESETS = [
  { id: "correlated", label: "Correlated (no depeg)" },
  { id: "mild-depeg", label: "Mild depeg" },
  { id: "severe-depeg", label: "Severe depeg" },
  { id: "stablecoin-depeg", label: "Stablecoin depeg" },
  { id: "lst-slashing-hypothetical", label: "LST slashing (hypothetical)" },
] as const;

function shortenAddress(addr: string): string {
  if (!addr.startsWith("0x") || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

interface VaultBaseline {
  vault: string;
  token0: string;
  token1: string;
}

export function SmartVaultsTab() {
  const [rows, setRows] = useState<FluidT2ShockResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Two-state debounce, same pattern as PositionDrilldown's slider: sliderValue updates on
  // every drag event (immediate label feedback), magnitude - the one that actually drives
  // the table re-render - only updates 150ms after dragging stops. Wiring the slider
  // directly to the render-driving state (the original version of this file) forced a full
  // table re-render on every single drag tick, visible as flickering.
  const [sliderValue, setSliderValue] = useState(-30);
  const [magnitude, setMagnitude] = useState(-30);
  const [presetId, setPresetId] = useState<(typeof PRESETS)[number]["id"]>("correlated");

  useEffect(() => {
    const timer = setTimeout(() => setMagnitude(sliderValue), 150);
    return () => clearTimeout(timer);
  }, [sliderValue]);

  useEffect(() => {
    let cancelled = false;
    fetchFluidT2Shock()
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const vaultsAtSelection = useMemo(() => {
    if (!rows) return [];
    const wanted = rows.filter((r) => r.presetId === presetId && Number(r.magnitudePct) === magnitude);
    return wanted.sort((a, b) => a.vault.localeCompare(b.vault));
  }, [rows, presetId, magnitude]);

  const baselineByVault = useMemo(() => {
    if (!rows) return new Map<string, VaultBaseline>();
    const map = new Map<string, VaultBaseline>();
    for (const r of rows) {
      if (!map.has(r.vault)) map.set(r.vault, { vault: r.vault, token0: r.token0, token1: r.token1 });
    }
    return map;
  }, [rows]);

  if (error) {
    return <div className="banner banner-warning">Failed to load Fluid T2 vault data: {error}</div>;
  }

  if (!rows) {
    return <p>Loading Fluid T2 vault data…</p>;
  }

  const liquidatableCount = vaultsAtSelection.filter((r) => r.liquidatable).length;

  return (
    <div>
      <h2>Fluid T2 vaults - smart collateral, normal debt</h2>
      <p>
        Each of these real vaults holds its collateral as a DEX liquidity position (a real
        Fluid pool, e.g. a WBTC-cbBTC pair) rather than a plain token balance - it earns
        trading fees, but its value shifts with the pool&apos;s own reserve composition, not
        just the underlying tokens&apos; prices.{" "}
        <InfoTooltip label="How smart-collateral value is computed">
          Value here is computed by directly repricing the leg&apos;s two underlying tokens
          (same shock model as every other tab), then valuing the DEX pool&apos;s real current
          reserves at those shocked prices - not by simulating a real swap against the pool. A
          swap-based approach was tried first and abandoned: Fluid&apos;s own single-transaction
          price-impact limit turned out to be far too small to reach a realistic depeg
          magnitude on a well-capitalized pool.
        </InfoTooltip>
      </p>

      <div className="banner banner-info">
        <strong>Real per-vault share, not the whole pool.</strong> Some of these DEX pools are
        shared across multiple vaults (one real pool found shared by 18 distinct vaults) -
        &quot;Collateral value&quot; below is this specific vault&apos;s real fraction of the
        pool&apos;s value (its own supply shares divided by the pool&apos;s total shares,
        both real on-chain values), not the whole shared pool&apos;s total. An earlier version
        used the raw pool total directly - fixed after the same approximation was found to be
        actively wrong (not just imprecise) on T3&apos;s debt leg.
      </div>

      <div className="control-row" style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", margin: "1rem 0" }}>
        <div>
          <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "0.4rem" }}>
            Shock preset
          </div>
          <div className="button-group">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" data-active={presetId === p.id} onClick={() => setPresetId(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ flex: "1 1 240px", minWidth: "240px" }}>
          <label htmlFor="t2-magnitude-slider" style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
            Shock magnitude: {sliderValue}%
          </label>
          <input
            id="t2-magnitude-slider"
            className="magnitude-slider"
            type="range"
            min={MAGNITUDE_MAX}
            max={MAGNITUDE_MIN}
            step={MAGNITUDE_STEP}
            value={sliderValue}
            onChange={(e) => setSliderValue(Number(e.target.value))}
          />
        </div>
      </div>

      <p>
        At <strong>{magnitude}%</strong> under the <strong>{PRESETS.find((p) => p.id === presetId)?.label}</strong>{" "}
        preset: <strong>{liquidatableCount}</strong> of <strong>{vaultsAtSelection.length}</strong> real T2 vaults
        would be liquidatable.
      </p>

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Vault</th>
              <th>Collateral pair</th>
              <th>
                Collateral value
                <InfoTooltip label="What collateral value means here">
                  The DEX pool&apos;s real reserves at the selected shock, priced at the
                  shocked prices.
                </InfoTooltip>
              </th>
              <th>
                Debt value
                <InfoTooltip label="What debt value means here">
                  This vault&apos;s real aggregate borrow balance, priced at today&apos;s real
                  market price (unaffected by the collateral-side shock preset). Normal leg - a
                  plain balance, same as T1.
                </InfoTooltip>
              </th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {vaultsAtSelection.map((row) => {
              const baseline = baselineByVault.get(row.vault);
              return (
                <tr key={row.vault}>
                  <td className="provenance">{shortenAddress(row.vault)}</td>
                  <td className="provenance">
                    {baseline ? `${shortenAddress(baseline.token0)} / ${shortenAddress(baseline.token1)}` : "—"}
                  </td>
                  <td>{formatUsd8(row.vaultCollateralValueUsd8)}</td>
                  <td>{formatUsd8(row.vaultDebtValueUsd8)}</td>
                  <td>
                    {row.liquidatable ? (
                      <span className="tag tag-toxic">Liquidatable</span>
                    ) : (
                      <span className="tag tag-healthy">Healthy</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="provenance" style={{ marginTop: "0.75rem" }}>
        {vaultsAtSelection.length} real, active T2 vaults - drag the slider or switch presets
        to see how each one&apos;s smart-collateral value moves ({rows.length} total rows
        fetched once, covering every vault across all 5 presets and all 81 swept magnitudes).
      </p>
    </div>
  );
}
