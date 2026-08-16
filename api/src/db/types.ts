import type { ColumnType, Generated } from "kysely";

/**
 * Kysely maps NUMERIC -> string by default only if we tell it to; the `pg` driver
 * itself returns NUMERIC as a JS string already (it never parses to `number`, precisely
 * to avoid float rounding on large/precise values). This alias just makes that explicit
 * at the type level instead of relying on driver behavior nobody's told to expect.
 */
type Numeric = ColumnType<string, string | bigint, string | bigint>;

export interface SnapshotsTable {
  id: Generated<number>;
  protocol: "aave" | "fluid";
  pinned_block: Numeric;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface IndexerProgressTable {
  protocol: "aave" | "fluid";
  last_indexed_block: Numeric;
}

export interface AaveBorrowCandidatesTable {
  address: string;
  discovered_at_block: Numeric;
}

export interface PositionsTable {
  id: Generated<number>;
  snapshot_id: number;
  user_address: string;
  /** JSON-serialized engine/types.ts CollateralLeg[] (asset, amount, decimals,
   *  liquidationThresholdBps), bigints as strings. Written by syncAaveSnapshot.ts - a
   *  previous version of this comment hand-described a different, wrong shape
   *  (amountRaw, no liquidationThresholdBps) that had already drifted from what's
   *  actually written; pointing at the real type here instead, since that's the thing
   *  that can't silently drift out of sync with itself. */
  collateral: ColumnType<unknown, unknown, unknown>;
  /** JSON-serialized engine/types.ts DebtLeg[] (asset, amount, decimals), bigints as strings. */
  debt: ColumnType<unknown, unknown, unknown>;
  liquidation_incentive_bps: Numeric;
  /** Fluid-only identity - (snapshot_id, fluid_vault_address, fluid_nft_id) is Fluid's
   *  natural key (one wallet can own multiple Fluid positions). Null for Aave rows -
   *  enforced by a CHECK constraint (migration 0002), both null or both set together.
   *  Insert type includes `undefined` deliberately - syncAaveSnapshot.ts's existing
   *  insert omits these columns entirely and relies on the column's NULL default. */
  fluid_vault_address: ColumnType<string | null, string | null | undefined, string | null>;
  fluid_nft_id: ColumnType<string | null, string | bigint | null | undefined, string | bigint | null>;
}

export interface ProtocolParamsTable {
  snapshot_id: number;
  asset: string;
  liquidation_threshold_bps: Numeric;
  price_usd8: Numeric;
}

/** Written by scripts/sync-validation-results.ts (#30/#36) - real, state-override eth_call
 *  results against real positions, too slow/costly to compute live per page load, so
 *  persisted here and served from the latest sync (same pattern as snapshots/positions). */
export interface ValidationResultsTable {
  id: Generated<number>;
  protocol: "aave" | "fluid";
  position_id: string;
  preset_id: string;
  magnitude_pct: Numeric;
  /** "matched" | "mismatched" | "not-applicable" | "unable-to-validate" | "unexpected-revert" -
   *  kept as plain text (not a DB enum) so a newly-discovered real status doesn't need a migration. */
  status: string;
  expected_amount: ColumnType<string | null, string | bigint | null | undefined, string | null>;
  actual_amount: ColumnType<string | null, string | bigint | null | undefined, string | null>;
  /** Real on-chain symbol/decimals for the asset expected_amount/actual_amount are
   *  denominated in (the debt asset - both protocols) - added so the raw integer amounts
   *  above are actually labeled, not bare numbers with no unit. */
  debt_asset_symbol: string | null;
  debt_asset_decimals: number | null;
  /** Only populated for Fluid rows (the collateral seized) - Aave's equivalent
   *  (actualCollateralSeized) isn't captured by this validator's return shape. */
  collateral_asset_symbol: string | null;
  collateral_asset_decimals: number | null;
  actual_collateral_amount: ColumnType<string | null, string | bigint | null | undefined, string | null>;
  detail: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** Written by scripts/sync-liquidation-profitability.ts (#43) - one row per (position,
 *  magnitude tested), same granularity as validation_results, so the real breakeven
 *  magnitude (first magnitude where a real liquidator's gas cost is actually covered by
 *  the real bonus) can be derived from stored rows rather than collapsed to one number. */
export interface LiquidationProfitabilityTable {
  id: Generated<number>;
  protocol: "aave" | "fluid";
  position_id: string;
  preset_id: string;
  magnitude_pct: Numeric;
  gas_used: ColumnType<string | null, string | bigint | null | undefined, string | null>;
  /** 8-decimal fixed-point USD, same convention as protocol_params.price_usd8 - exact
   *  integer math throughout, not floats. */
  gas_cost_usd8: ColumnType<string | null, string | bigint | null | undefined, string | null>;
  debt_cleared_usd8: ColumnType<string | null, string | bigint | null | undefined, string | null>;
  bonus_value_usd8: ColumnType<string | null, string | bigint | null | undefined, string | null>;
  net_profit_usd8: ColumnType<string | null, string | bigint | null | undefined, string | null>;
  /** "profitable" | "unprofitable" | "unable-to-estimate-gas" | "unable-to-validate" - its
   *  own vocabulary, deliberately distinct from validation_results.status. */
  status: string;
  detail: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface DB {
  snapshots: SnapshotsTable;
  indexer_progress: IndexerProgressTable;
  aave_borrow_candidates: AaveBorrowCandidatesTable;
  positions: PositionsTable;
  protocol_params: ProtocolParamsTable;
  validation_results: ValidationResultsTable;
  liquidation_profitability: LiquidationProfitabilityTable;
}
