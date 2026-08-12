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
  /** Array of { asset: string, amountRaw: string, decimals: number } - see docs/decisions.md. */
  collateral: ColumnType<unknown, unknown, unknown>;
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
