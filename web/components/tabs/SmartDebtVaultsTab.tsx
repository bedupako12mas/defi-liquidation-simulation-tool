"use client";

/**
 * Deploy 3/6 - Fluid T3 (normal collateral, smart debt). The mirror image of
 * SmartVaultsTab.tsx (T2) - same oracle-override repricing mechanism, same interactive
 * slider/preset pattern, applied to the debt leg's real DEX reserves instead of the
 * collateral leg's.
 *
 * One real difference from T2 worth surfacing here rather than hiding: vaultDebtValueUsd8 is
 * the REAL, precise per-vault share of the debt pool (this vault's own debt shares divided
 * by the pool's total shares - both real on-chain values), not a rough pool-level
 * approximation. An earlier version used the pool's raw total directly, which made a real,
 * healthy, active vault look ~38x over-indebted - found and fixed live (see
 * api/src/db/migrations/0009_fluid_t3_shock_results.ts's top comment) before this tab ever
 * shipped, unlike T2's still-open pool-share approximation.
 */

import { useEffect, useMemo, useState } from "react";
import { fetchFluidT3Shock, type FluidT3ShockResult } from "@/lib/api/fluidT3Shock";
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

export function SmartDebtVaultsTab() {
  const [rows, setRows] = useState<FluidT3ShockResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Same two-state debounce as SmartVaultsTab (T2) - see that file's comment for why wiring
  // the slider directly to render-driving state caused flickering.
  const [sliderValue, setSliderValue] = useState(-30);
  const [magnitude, setMagnitude] = useState(-30);
  const [presetId, setPresetId] = useState<(typeof PRESETS)[number]["id"]>("correlated");

  useEffect(() => {
    const timer = setTimeout(() => setMagnitude(sliderValue), 150);
    return () => clearTimeout(timer);
  }, [sliderValue]);

  useEffect(() => {
    let cancelled = false;
    fetchFluidT3Shock()
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
    return <div className="banner banner-warning">Failed to load Fluid T3 vault data: {error}</div>;
  }

  if (!rows) {
    return <p>Loading Fluid T3 vault data…</p>;
  }

  const liquidatableCount = vaultsAtSelection.filter((r) => r.liquidatable).length;

  return (
    <div>
      <h2>Fluid T3 vaults - normal collateral, smart debt</h2>
      <p>
        Each of these real vaults borrows through a DEX liquidity position (a real Fluid
        pool) rather than owing a plain token balance - the mirror image of T2&apos;s smart
        collateral. Collateral here is a single, plain token.{" "}
        <InfoTooltip label="How smart-debt value is computed">
          Value is computed the same way as T2&apos;s smart-collateral leg: reprice the debt
          leg&apos;s two underlying tokens under the shock, then value the pool&apos;s real
          current reserves at those shocked prices. This vault&apos;s own share of that pool
          value is computed precisely (its own debt shares divided by the pool&apos;s total
          debt shares), not approximated at the pool level.
        </InfoTooltip>
      </p>

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
          <label htmlFor="t3-magnitude-slider" style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
            Shock magnitude: {sliderValue}%
          </label>
          <input
            id="t3-magnitude-slider"
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
        preset: <strong>{liquidatableCount}</strong> of <strong>{vaultsAtSelection.length}</strong> real T3 vaults
        would be liquidatable.
      </p>

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Vault</th>
              <th>Debt pair</th>
              <th>
                Collateral value
                <InfoTooltip label="What collateral value means here">
                  This vault&apos;s real normal-collateral balance, priced at the shocked
                  price for its preset.
                </InfoTooltip>
              </th>
              <th>
                Debt value
                <InfoTooltip label="What debt value means here">
                  This vault&apos;s real, precise share of the debt DEX pool&apos;s value at
                  the selected shock - its own debt shares divided by the pool&apos;s total
                  shares, not the whole pool&apos;s value.
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
        {vaultsAtSelection.length} real, active T3 vaults - drag the slider or switch presets
        to see how each one&apos;s smart-debt value moves ({rows.length} total rows fetched
        once, covering every vault across all 5 presets and all 81 swept magnitudes).
      </p>
    </div>
  );
}
