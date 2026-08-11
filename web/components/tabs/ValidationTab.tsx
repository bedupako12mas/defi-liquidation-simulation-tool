import { ComingSoonPanel } from "@/components/shared/ComingSoonPanel";

/**
 * Milestone 2 stub, same reasoning as CascadeDetailTab.tsx. FRONTEND_STRATEGY.md's table
 * notes an alternative for this tab specifically ("Tier1-vs-Tier2 status only, since that's
 * RPC-tier") - not built here either, since Milestone 1's own scope (per the task that
 * produced this build) is OverviewTab + MethodologyTab fully real, both other tabs as plain
 * stubs. Left as a comment, not implemented, so a future session doesn't have to rediscover
 * that this alternative was considered and deliberately deferred, not missed.
 */
export function ValidationTab() {
  return (
    <div className="card">
      <ComingSoonPanel
        title="Validation - Milestone 2"
        description="Fork-replay-based validation of the RPC-tier sweep against real on-chain liquidation outcomes. Not built yet - see docs/FRONTEND_STRATEGY.md."
      />
    </div>
  );
}
