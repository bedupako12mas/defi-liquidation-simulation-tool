"use client";

/**
 * Deploy 5/6 - Fluid T4 (smart collateral AND smart debt). Combines SmartVaultsTab.tsx's
 * (T2) collateral-leg display and SmartDebtVaultsTab.tsx's (T3) debt-leg display - both legs
 * are real DEX pools here, unlike T2/T3 where one leg is a single plain token.
 *
 * Every real T4 vault is exactly one of two architectures (confirmed live, full 26-vault
 * census - see docs/decisions.md's 2026-09-03 T4 entries): 13/26 share ONE pool for both
 * legs, 13/26 use TWO separate pools. This tab doesn't branch on that distinction - the same
 * collateralDex/debtDex fields and the same two independent per-vault share fractions (supply
 * vs borrow) apply either way, so a same-pool vault just happens to show the same pool
 * address twice.
 */

import { useEffect, useMemo, useState } from "react";
import { fetchFluidT4Shock, type FluidT4ShockResult } from "@/lib/api/fluidT4Shock";
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
  colToken0: string;
  colToken1: string;
  debtToken0: string;
  debtToken1: string;
  samePool: boolean;
}

export function FullySmartVaultsTab() {
  const [rows, setRows] = useState<FluidT4ShockResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Same two-state debounce as SmartVaultsTab/SmartDebtVaultsTab - see those files' comments
  // for why wiring the slider directly to render-driving state caused flickering.
  const [sliderValue, setSliderValue] = useState(-30);
  const [magnitude, setMagnitude] = useState(-30);
  const [presetId, setPresetId] = useState<(typeof PRESETS)[number]["id"]>("correlated");

  useEffect(() => {
    const timer = setTimeout(() => setMagnitude(sliderValue), 150);
    return () => clearTimeout(timer);
  }, [sliderValue]);

  useEffect(() => {
    let cancelled = false;
    fetchFluidT4Shock()
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
      if (!map.has(r.vault)) {
        map.set(r.vault, {
          vault: r.vault,
          colToken0: r.colToken0,
          colToken1: r.colToken1,
          debtToken0: r.debtToken0,
          debtToken1: r.debtToken1,
          samePool: r.collateralDex.toLowerCase() === r.debtDex.toLowerCase(),
        });
      }
    }
    return map;
  }, [rows]);

  if (error) {
    return <div className="banner banner-warning">Failed to load Fluid T4 vault data: {error}</div>;
  }

  if (!rows) {
    return <p>Loading Fluid T4 vault data…</p>;
  }

  const liquidatableCount = vaultsAtSelection.filter((r) => r.liquidatable).length;
  const samePoolCount = [...baselineByVault.values()].filter((b) => b.samePool).length;
  const samePairCount = [...baselineByVault.values()].filter(
    (b) => b.samePool && b.colToken0 === b.debtToken0 && b.colToken1 === b.debtToken1,
  ).length;

  return (
    <div>
      <h2>Fluid T4 vaults - smart collateral AND smart debt</h2>
      <p>
        Each of these real vaults holds BOTH legs as DEX liquidity positions - a real Fluid
        pool on the collateral side and a real Fluid pool on the debt side, combining T2 and
        T3&apos;s mechanisms in one vault.{" "}
        <InfoTooltip label="Same-pool vs two-pool architecture">
          {samePoolCount} of {baselineByVault.size} vaults use ONE pool for both legs; the
          rest use two separate pools. Either way, this vault&apos;s own share of each pool is
          computed precisely (its own supply/borrow shares divided by that pool&apos;s total
          shares) - a same-pool vault simply has two independent fractions into one pool, not
          a shared one.
        </InfoTooltip>
      </p>

      <p className="preset-note">
        Real finding from this exact dataset, not a general claim about T4 vaults: at every
        preset and every magnitude up to -80%, none of these 21 real vaults cross into
        liquidation. Two distinct, disclosed reasons why - not one:
      </p>
      <ul className="limitations">
        <li>
          <strong>{samePairCount} of {baselineByVault.size} vaults hold the identical token
          pair on both legs</strong> (same pool, same two tokens) - for these, collateral
          value and debt value are computed from the exact same reserves formula under the
          exact same prices, so any uniform price shock scales both sides by the same
          multiplier. Their collateral/debt ratio is fixed by today&apos;s real supply-share
          vs. borrow-share fraction alone; no price shock, at any severity, can move it. This
          is a structural limit of what a price-only shock can test, not evidence these
          vaults are safe from bad debt.
        </li>
        <li>
          <strong>The remaining two-pool vaults are genuinely testable</strong> by a price
          shock (their two legs hold different assets), but none of today&apos;s real
          positions are levered close enough to the edge for these five historically-
          calibrated presets to push them over, even at -80% magnitude.
        </li>
        <li>
          <strong>This is a point-in-time price sweep, not a time simulation</strong> - it
          does not model interest-rate/exchange-price drift between a vault&apos;s supply and
          borrow sides accruing over weeks or months, which is a real, common path to Fluid
          bad debt independent of any price shock. Not represented here at all.
        </li>
      </ul>

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
          <label htmlFor="t4-magnitude-slider" style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
            Shock magnitude: {sliderValue}%
          </label>
          <input
            id="t4-magnitude-slider"
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
        preset: <strong>{liquidatableCount}</strong> of <strong>{vaultsAtSelection.length}</strong> real T4 vaults
        would be liquidatable.
      </p>

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Vault</th>
              <th>Collateral pair</th>
              <th>Debt pair</th>
              <th>Pools</th>
              <th>
                Collateral value
                <InfoTooltip label="What collateral value means here">
                  This vault&apos;s real, precise share of the collateral DEX pool&apos;s value
                  (its own supply shares divided by the pool&apos;s total shares) at the
                  selected shock.
                </InfoTooltip>
              </th>
              <th>
                Debt value
                <InfoTooltip label="What debt value means here">
                  This vault&apos;s real, precise share of the debt DEX pool&apos;s value (its
                  own debt shares divided by the pool&apos;s total shares) at the selected
                  shock.
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
                    {baseline ? `${shortenAddress(baseline.colToken0)} / ${shortenAddress(baseline.colToken1)}` : "—"}
                  </td>
                  <td className="provenance">
                    {baseline ? `${shortenAddress(baseline.debtToken0)} / ${shortenAddress(baseline.debtToken1)}` : "—"}
                  </td>
                  <td>
                    {baseline?.samePool ? (
                      <span className="tag tag-na">Same pool</span>
                    ) : (
                      <span className="tag tag-na">Two pools</span>
                    )}
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
        {vaultsAtSelection.length} real, active T4 vaults - drag the slider or switch presets
        to see how each one&apos;s smart-collateral and smart-debt values move together
        ({rows.length} total rows fetched once, covering every vault across all 5 presets and
        all 81 swept magnitudes).
      </p>
    </div>
  );
}
