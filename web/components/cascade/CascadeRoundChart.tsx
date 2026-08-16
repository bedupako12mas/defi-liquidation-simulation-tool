// Full multi-round toxic-liquidation-spiral replay - NOT implemented, and explicitly OUT OF
// SCOPE per docs/SCOPE.md §3 and the locked #37/#38 decision ("only fork requiring items,
// nothing more or extra" - docs/decisions.md). CascadeDetailTab.tsx now has REAL content
// (chained liquidation + CappedRate cap-breach, lib/api/{chainedLiquidation,
// cappedRateBreach}.ts) - a narrower, deliberately-scoped pair of fork-requiring checks, not
// this file's original per-round replay vision. Reserved in case a future, separately-scoped
// task revisits the full multi-round replay - do not build ahead of that decision.

export {};
