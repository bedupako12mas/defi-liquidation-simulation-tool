"use client";

/**
 * Fluid's three "smart" vault tiers (T2/T3/T4) - previously three separate top-level tabs
 * showing the same interaction pattern (shock preset + magnitude slider + liquidatability
 * table) three times over. Combined into one tab with a tier selector, the same pill-picker
 * pattern OverviewTab already uses for its metric selector, so the nav reflects "one real
 * concept (smart vaults) with three variants" instead of three separate nav entries for what
 * is, from a user's perspective, one question asked three ways.
 */

import { useState } from "react";
import { SmartCollateralVaultsPanel } from "@/components/tabs/SmartCollateralVaultsPanel";
import { SmartDebtVaultsPanel } from "@/components/tabs/SmartDebtVaultsPanel";
import { FullySmartVaultsPanel } from "@/components/tabs/FullySmartVaultsPanel";

const TIERS = [
  { id: "t2", label: "Smart collateral (T2)" },
  { id: "t3", label: "Smart debt (T3)" },
  { id: "t4", label: "Fully smart (T4)" },
] as const;

type TierId = (typeof TIERS)[number]["id"];

export function SmartVaultsTab() {
  const [tier, setTier] = useState<TierId>("t2");

  return (
    <div>
      <div className="card">
        <h2>Smart vaults</h2>
        <p className="preset-note" style={{ marginTop: 0, marginBottom: "1rem" }}>
          Fluid vaults where one or both legs are held as a DEX liquidity position instead of
          a plain token balance - three real variants, selected below.
        </p>
        <div className="pill-group">
          {TIERS.map((t) => (
            <button key={t.id} type="button" className="pill" data-active={tier === t.id} onClick={() => setTier(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        {tier === "t2" && <SmartCollateralVaultsPanel />}
        {tier === "t3" && <SmartDebtVaultsPanel />}
        {tier === "t4" && <FullySmartVaultsPanel />}
      </div>
    </div>
  );
}
