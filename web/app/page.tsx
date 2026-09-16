"use client";

/**
 * Thin shell: tab nav + active tab content, nothing else (docs/FRONTEND_STRATEGY.md's rule
 * of thumb - "if adding something requires touching page.tsx or the tab nav, the design has
 * leaked"). Do not add per-feature logic here; it belongs in the relevant tab/component.
 */

import { CapabilitiesProvider, useCapabilities } from "@/lib/hooks/useCapabilities";
import { NavigationProvider, useNavigation, type TabId } from "@/lib/hooks/useNavigation";
import { USE_MOCK } from "@/lib/api/meta";
import { OverviewTab } from "@/components/tabs/OverviewTab";
import { GlossaryTab } from "@/components/tabs/GlossaryTab";
import { MethodologyTab } from "@/components/tabs/MethodologyTab";
import { CascadeDetailTab } from "@/components/tabs/CascadeDetailTab";
import { ValidationTab } from "@/components/tabs/ValidationTab";
import { SmartVaultsTab } from "@/components/tabs/SmartVaultsTab";
import { SmartDebtVaultsTab } from "@/components/tabs/SmartDebtVaultsTab";
import { FullySmartVaultsTab } from "@/components/tabs/FullySmartVaultsTab";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "glossary", label: "Glossary" },
  { id: "methodology", label: "Methodology" },
  { id: "cascade", label: "Cascade detail" },
  { id: "validation", label: "Validation" },
  { id: "smart-vaults", label: "Smart vaults (T2)" },
  { id: "smart-debt-vaults", label: "Smart debt vaults (T3)" },
  { id: "fully-smart-vaults", label: "Fully smart vaults (T4)" },
];

function TabContent({ active }: { active: TabId }) {
  switch (active) {
    case "overview":
      return <OverviewTab />;
    case "glossary":
      return <GlossaryTab />;
    case "methodology":
      return <MethodologyTab />;
    case "cascade":
      return <CascadeDetailTab />;
    case "validation":
      return <ValidationTab />;
    case "smart-vaults":
      return <SmartVaultsTab />;
    case "smart-debt-vaults":
      return <SmartDebtVaultsTab />;
    case "fully-smart-vaults":
      return <FullySmartVaultsTab />;
  }
}

function AppShell() {
  const { active, goTo } = useNavigation();
  const { capabilities, meta } = useCapabilities();

  return (
    <div className="container">
      <header>
        <h1>Aave V3, Aave V4 &amp; Fluid - Liquidation Simulator</h1>
        <p className="subtitle">
          See how much collateral becomes liquidatable as a price shock deepens across Aave V3,
          Aave V4, and Fluid T1 vaults, whether it&apos;s worth a liquidator&apos;s gas to act,
          and this tool&apos;s own modeling limitations - the Glossary and Methodology tabs have
          the details.
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
          <strong>LIVE DATA.</strong> Real Aave V3 positions
          {meta?.pinnedBlock ? (
            <>
              {" "}(pinned at block <code>{meta.pinnedBlock}</code>)
            </>
          ) : null}{" "}
          and real Fluid T1 positions across all 101 real vaults
          {meta?.fluidPinnedBlock ? (
            <>
              {" "}(pinned at block <code>{meta.fluidPinnedBlock}</code>)
            </>
          ) : null}
          , both from the connected backend - see the Methodology tab for the full,
          current list of limitations.
        </div>
      )}

      <p className="preset-note" style={{ marginTop: "-0.75rem", marginBottom: "1.25rem" }}>
        This tool simulates, it doesn&apos;t predict -{" "}
        <button type="button" className="link-button" onClick={() => goTo("methodology")}>
          see every modeling limitation and approximation
        </button>
        .
      </p>

      <nav className="tab-nav">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            data-active={active === tab.id}
            onClick={() => goTo(tab.id)}
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
    <NavigationProvider>
      <CapabilitiesProvider>
        <AppShell />
      </CapabilitiesProvider>
    </NavigationProvider>
  );
}
