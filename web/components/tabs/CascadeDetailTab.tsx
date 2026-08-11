import { ComingSoonPanel } from "@/components/shared/ComingSoonPanel";

/**
 * Milestone 2 stub. Per docs/FRONTEND_STRATEGY.md's rollout table, this tab is
 * `<ComingSoonPanel />` for Milestone 1, unconditionally - the real content is only ever
 * built once the mainnet-fork tier (lib/api/cascade.ts, components/cascade/*) is real.
 * Lighting this up later is a one-line swap inside this file (replace the panel with the
 * real components) - the tab, the nav, and page.tsx do not change (FRONTEND_STRATEGY.md's
 * "rule of thumb").
 */
export function CascadeDetailTab() {
  return (
    <div className="card">
      <ComingSoonPanel
        title="Cascade detail - Milestone 2"
        description="Per-round replay of a toxic-liquidation-spiral cascade on a real mainnet fork, including second-order price impact and profitability checks. Not built yet - see docs/FRONTEND_STRATEGY.md."
        reservedComponents={[
          "components/cascade/CascadeRoundChart.tsx",
          "components/cascade/PriceImpactChart.tsx",
          "components/cascade/ProfitabilityIndicator.tsx",
          "components/cascade/CappedRateEffectChart.tsx",
        ]}
      />
    </div>
  );
}
