"use client";

/**
 * Thin shell: tab nav + active tab content, nothing else (docs/FRONTEND_STRATEGY.md's rule
 * of thumb - "if adding something requires touching page.tsx or the tab nav, the design has
 * leaked"). Do not add per-feature logic here; it belongs in the relevant tab/component.
 */

import { useState } from "react";
import { CapabilitiesProvider, useCapabilities } from "@/lib/hooks/useCapabilities";
import { USE_MOCK } from "@/lib/api/meta";
import { OverviewTab } from "@/components/tabs/OverviewTab";
import { MethodologyTab } from "@/components/tabs/MethodologyTab";
import { CascadeDetailTab } from "@/components/tabs/CascadeDetailTab";
import { ValidationTab } from "@/components/tabs/ValidationTab";

type TabId = "overview" | "methodology" | "cascade" | "validation";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "methodology", label: "Methodology" },
  { id: "cascade", label: "Cascade detail" },
  { id: "validation", label: "Validation" },
];

function TabContent({ active }: { active: TabId }) {
  switch (active) {
    case "overview":
      return <OverviewTab />;
    case "methodology":
      return <MethodologyTab />;
    case "cascade":
      return <CascadeDetailTab />;
    case "validation":
      return <ValidationTab />;
  }
}

function AppShell() {
  const [active, setActive] = useState<TabId>("overview");
  const { capabilities, meta } = useCapabilities();

  return (
    <div className="container">
      <header>
        <h1>Aave V3 vs. Fluid T1 - Liquidation Simulator (v2)</h1>
        <p className="subtitle">
          As a named price shock deepens, how much collateral becomes liquidatable on each
          protocol, and where does bad debt start? RPC-tier sweep today; mainnet-fork-tier
          cascade replay lights up automatically once it ships.
        </p>
      </header>

      {USE_MOCK ? (
        <div className="banner banner-info">
          <strong>MOCK API MODE.</strong> <code>NEXT_PUBLIC_USE_MOCK_API</code> is not set to{" "}
          <code>false</code> - every number on this page comes from{" "}
          <code>scripts/generate-mock-fixtures.ts</code>, which runs the real, tested{" "}
          <code>api/src/engine</code> against illustrative fixture positions, not from chain
          and not from a live API. See <code>lib/api/meta.ts</code> for the swap point.
        </div>
      ) : (
        <div className="banner banner-info">
          <strong>LIVE DATA.</strong> Real Aave V3 positions from the connected backend
          {meta?.pinnedBlock ? (
            <>
              , pinned at block <code>{meta.pinnedBlock}</code>
            </>
          ) : null}
          . Fluid T1 is not wired up yet - see the Methodology tab for the full,
          current list of limitations.
        </div>
      )}

      <nav className="tab-nav">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            data-active={active === tab.id}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
            {tab.id === "cascade" && capabilities && !capabilities.fork ? " (soon)" : ""}
          </button>
        ))}
      </nav>

      <TabContent active={active} />
    </div>
  );
}

export default function Page() {
  return (
    <CapabilitiesProvider>
      <AppShell />
    </CapabilitiesProvider>
  );
}
