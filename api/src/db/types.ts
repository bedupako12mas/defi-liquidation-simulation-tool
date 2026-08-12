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
}

export interface ProtocolParamsTable {
  snapshot_id: number;
  asset: string;
  liquidation_threshold_bps: Numeric;
  price_usd8: Numeric;
}

export interface DB {
  snapshots: SnapshotsTable;
  indexer_progress: IndexerProgressTable;
  aave_borrow_candidates: AaveBorrowCandidatesTable;
  positions: PositionsTable;
  protocol_params: ProtocolParamsTable;
}
