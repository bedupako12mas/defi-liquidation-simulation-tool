import type { PublicClient } from "viem";
import { parseAbi } from "viem";
import type { Position } from "../engine/types.js";
import { FLUID_VAULT_POSITIONS_RESOLVER } from "./fluidAddresses.js";
import type { FluidVaultConfig } from "./fluidVaultConfig.js";
import type { FluidPriceResolution } from "./fluidPriceResolution.js";

// VaultPositionsResolver's own Structs contract (periphery/resolvers/vaultPositions/
// structs.sol) - deliberately NOT the same UserPosition shape VaultT1Resolver's own
// Structs contract defines (which has tick/isLiquidated/dust fields). Confirmed live: this
// resolver's shape is exactly {nftId, owner, supply, borrow}, nothing more - a decode
// against the richer shape failed (bytes-to-bool error) before this was caught.
const POSITIONS_ABI = parseAbi([
  "struct UserPosition { uint nftId; address owner; uint supply; uint borrow; }",
  "function getAllVaultPositions(address vault_) view returns (UserPosition[] positions_)",
]);

export interface FluidPositionRecord {
  /** engine/types.ts's Position, unchanged - decision #3 reuses healthFactor()/
   *  currentLtv()/etc. as-is, fed real Fluid config instead of Aave's. */
  position: Position;
  /** Fluid-only identity (decision #1, migration 0002) - not part of the engine's
   *  Position type, carried alongside for syncFluidSnapshot.ts to write into the
   *  fluid_vault_address/fluid_nft_id columns. */
  vaultAddress: `0x${string}`;
  nftId: bigint;
}

export interface FluidPositionsResult {
  positions: FluidPositionRecord[];
  /** Supply-only positions (borrow=0) - not liquidation-relevant, filtered before
   *  counting toward skippedForPrice. */
  supplyOnlyCount: number;
  /** Positions whose collateral or debt token had no resolvable USD price (see
   *  fluidPriceResolution.ts's unresolvedTokens) - excluded entirely, not partially
   *  included, since healthFactor()/currentLtv() throw on any missing price. */
  skippedForPrice: number;
}

export async function loadFluidPositions(
  client: PublicClient,
  vaults: FluidVaultConfig[],
  priceResolution: FluidPriceResolution,
): Promise<FluidPositionsResult> {
  const perVaultPositions = await Promise.all(
    vaults.map((v) =>
      client.readContract({
        address: FLUID_VAULT_POSITIONS_RESOLVER,
        abi: POSITIONS_ABI,
        functionName: "getAllVaultPositions",
        args: [v.vault],
      }),
    ),
  );

  const records: FluidPositionRecord[] = [];
  let supplyOnlyCount = 0;
  let skippedForPrice = 0;

  vaults.forEach((vault, i) => {
    const supplyToken = vault.supplyToken.toLowerCase();
    const borrowToken = vault.borrowToken.toLowerCase();
    const priceResolvable =
      !priceResolution.unresolvedTokens.has(supplyToken) && !priceResolution.unresolvedTokens.has(borrowToken);

    for (const raw of perVaultPositions[i] ?? []) {
      if (raw.borrow === 0n) {
        supplyOnlyCount++;
        continue;
      }
      if (!priceResolvable) {
        skippedForPrice++;
        continue;
      }

      records.push({
        vaultAddress: vault.vault,
        nftId: raw.nftId,
        position: {
          id: `fluid-${vault.vault.toLowerCase()}-${raw.nftId}`,
          protocol: "fluid",
          user: raw.owner,
          collateral: [
            {
              // Lowercased - must match resolveFluidPrices's PriceVector keys exactly.
              // A real casing mismatch here (checksummed vs lowercased) was caught by a
              // live end-to-end test before this file was considered done: requirePrice()
              // failed to find a price that had, in fact, already been correctly resolved,
              // just stored under different casing.
              asset: supplyToken,
              amount: raw.supply,
              decimals: vault.supplyDecimals,
              liquidationThresholdBps: vault.liquidationThresholdBps,
            },
          ],
          debt: [{ asset: borrowToken, amount: raw.borrow, decimals: vault.borrowDecimals }],
          liquidationIncentiveBps: vault.liquidationIncentiveBps,
        },
      });
    }
  });

  return { positions: records, supplyOnlyCount, skippedForPrice };
}
