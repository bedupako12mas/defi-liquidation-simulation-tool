import { sql, type Kysely } from "kysely";
import type { DB } from "../db/types.js";
import type { BorrowCandidate } from "./aaveBorrowDiscovery.js";

/**
 * Idempotent AND order-independent: ON CONFLICT keeps the LEAST discovered_at_block
 * rather than DO NOTHING. Plain DO NOTHING would make correctness depend on insert
 * order - if a later backfill of an earlier block range runs after a forward scan already
 * wrote a later discovered_at_block for the same address, DO NOTHING would permanently
 * lock in the wrong (too-late) value with no way to correct it. LEAST is correct
 * regardless of which run happens to insert first.
 */
export async function syncBorrowCandidates(
  db: Kysely<DB>,
  candidates: BorrowCandidate[],
): Promise<void> {
  if (candidates.length === 0) return;

  await db
    .insertInto("aave_borrow_candidates")
    .values(
      candidates.map((c) => ({
        address: c.address,
        discovered_at_block: c.discoveredAtBlock.toString(),
      })),
    )
    .onConflict((oc) =>
      oc.column("address").doUpdateSet({
        discovered_at_block: sql`LEAST(excluded.discovered_at_block, aave_borrow_candidates.discovered_at_block)`,
      }),
    )
    .execute();
}
