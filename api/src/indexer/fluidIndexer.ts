import type { Kysely } from "kysely";
import type { PublicClient } from "viem";
import type { DB } from "../db/types.js";
import { loadFluidVaultConfigs } from "../loaders/fluidVaultConfig.js";
import { loadFluidPositions } from "../loaders/fluidPositions.js";
import { resolveFluidPrices } from "../loaders/fluidPriceResolution.js";
import { syncFluidSnapshot } from "../loaders/syncFluidSnapshot.js";
import { loadReserveConfigs } from "../loaders/aaveReserveConfig.js";

export interface FluidIndexSyncResult {
  vaultsScanned: number;
  positionsWritten: number;
  supplyOnlyExcluded: number;
  skippedForPrice: number;
  fallbackTokens: string[];
  unresolvedTokens: string[];
  snapshotId: number;
  pinnedBlock: bigint;
}

/**
 * No indexer_progress checkpoint, unlike Aave's - resolver-based enumeration
 * (fluidVaultConfig.ts/fluidPositions.ts) is a full, fresh, idempotent read of current
 * state every run, not an incremental block-range scan. There's nothing to resume from
 * and nothing that needs bounding to a lookback window (decision #5, reversed: all 101
 * real vaults, every run).
 */
export async function runFluidIndexSync(client: PublicClient, db: Kysely<DB>): Promise<FluidIndexSyncResult> {
  const pinnedBlock = (await client.getBlock({ blockTag: "finalized" })).number;

  const vaults = await loadFluidVaultConfigs(client);

  // Aave's real, already-loaded prices are the fallback anchor only (docs/decisions.md's
  // "support both" entry) - Fluid's own oracle graph (resolveFluidPrices) is tried first
  // for every token; this is loaded fresh in the same run, not reused across processes.
  const aaveReserves = await loadReserveConfigs(client, pinnedBlock);
  const priceResolution = resolveFluidPrices(vaults, aaveReserves);

  if (priceResolution.fallbackTokens.size > 0) {
    console.warn(
      `[fluidIndexer] ${priceResolution.fallbackTokens.size} token(s) priced via Aave fallback (Fluid's own oracle graph could not reach a stablecoin anchor):`,
      [...priceResolution.fallbackTokens],
    );
  }
  if (priceResolution.unresolvedTokens.size > 0) {
    console.warn(
      `[fluidIndexer] ${priceResolution.unresolvedTokens.size} token(s) unresolvable by either source - positions using them excluded entirely:`,
      [...priceResolution.unresolvedTokens],
    );
  }

  const { positions, supplyOnlyCount, skippedForPrice } = await loadFluidPositions(client, vaults, priceResolution);
  const snapshotId = await syncFluidSnapshot(db, pinnedBlock, priceResolution, positions);

  return {
    vaultsScanned: vaults.length,
    positionsWritten: positions.length,
    supplyOnlyExcluded: supplyOnlyCount,
    skippedForPrice,
    fallbackTokens: [...priceResolution.fallbackTokens],
    unresolvedTokens: [...priceResolution.unresolvedTokens],
    snapshotId,
    pinnedBlock,
  };
}
