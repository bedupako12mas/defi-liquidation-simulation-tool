import type { PublicClient, Address as ViemAddress } from "viem";
import { parseAbi } from "viem";
import type { CollateralLeg, DebtLeg, Position } from "../engine/types.js";
import type { AaveReserveConfig } from "./aaveReserveConfig.js";
import { AAVE_V4_SPOKES, type AaveV4SpokeName } from "./aaveV4Addresses.js";
import { multicallWithRateLimitRetry } from "../rpc/rateLimitRetry.js";

const TOKEN_ABI = parseAbi(["function symbol() view returns (string)"]);

const SPOKE_ABI = parseAbi([
  "function getReserveCount() view returns (uint256)",
  "function getReserve(uint256 reserveId) view returns (address underlying, address hub, uint16 assetId, uint8 decimals, uint24 collateralRisk, uint8 flags, uint32 dynamicConfigKey)",
  "function getUserReserveStatus(uint256 reserveId, address user) view returns (bool usedAsCollateral, bool isBorrowed)",
  "function getUserSuppliedAssets(uint256 reserveId, address user) view returns (uint256)",
  "function getUserTotalDebt(uint256 reserveId, address user) view returns (uint256)",
  "function getDynamicReserveConfig(uint256 reserveId, uint32 dynamicConfigKey) view returns (uint16 collateralFactor, uint32 maxLiquidationBonus, uint16 liquidationFee)",
  "function getUserAccountData(address user) view returns (uint256 riskPremium, uint256 avgCollateralFactor, uint256 healthFactor, uint256 totalCollateralValue, uint256 totalDebtValueRay, uint256 activeCollateralCount, uint256 borrowCount)",
  "function getLiquidationBonus(uint256 reserveId, address user, uint256 healthFactor) view returns (uint256)",
  "function ORACLE() view returns (address)",
]);

const ORACLE_ABI = parseAbi(["function getReservePrice(uint256 reserveId) view returns (uint256)"]);

export interface AaveV4PositionRecord {
  position: Position;
  spoke: AaveV4SpokeName;
}

export interface EnrichAaveV4PositionsResult {
  positionRecords: AaveV4PositionRecord[];
  /** One real entry per unique underlying asset seen across every enriched position, for
   *  syncAaveV4Snapshot.ts's protocol_params (basePrices for the shock sweep - without this,
   *  applyShock() would have nothing to shock for V4 at all). De-duplicated by asset
   *  address, first-seen wins - a real, disclosed simplification: the SAME underlying asset
   *  can carry slightly different real collateralFactor/price across different Spokes (each
   *  Spoke sets its own risk config), and this collapses that to one representative value
   *  rather than modeling per-Spoke price/config divergence. */
  reserveConfigs: AaveReserveConfig[];
  /** (candidate, spoke) pairs where the cheap getUserAccountData pre-filter itself failed -
   *  same disclosure discipline as aaveUserEnrichment.ts's failedCallCount. */
  failedCallCount: number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_INTER_BATCH_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds one real Position per (candidate, Spoke) pair that has a real, current position with
 * open debt - reusing the SAME engine/types.ts Position/CollateralLeg/DebtLeg shape and
 * healthFactor() formula already used for Aave V3 and Fluid, not a bespoke V4 type. Verified
 * live before building this (docs/decisions.md's 2026-09-08 entry): independently
 * recomputing a real user's health factor via Σ(collateral*price*collateralFactor)/
 * Σ(debt*price) matched the real on-chain getUserAccountData().healthFactor to 9+ significant
 * digits - collateralFactor (DynamicReserveConfig) is the real liquidation-threshold
 * equivalent this formula needs.
 *
 * Real efficiency lesson applied from the start, not discovered the hard way: a V3 indexer
 * backfill run at full scale (5,757 candidates x 67 reserves) hit a 74% HTTP failure rate on
 * a single flat (candidates x reserves) multicall per batch. Every V4 Spoke has far fewer
 * reserves (2-14, see verify-spokes.ts), but the real fix applied here regardless: a CHEAP
 * getUserAccountData(user) pre-filter (one call per candidate per Spoke) runs first to find
 * which (candidate, Spoke) pairs have ANY real position at all (activeCollateralCount +
 * borrowCount > 0) - the expensive per-reserve enumeration only ever runs for those pairs,
 * not the full cross product.
 */
export async function enrichAaveV4Positions(
  client: PublicClient,
  candidates: string[],
  batchSize: number = DEFAULT_BATCH_SIZE,
  interBatchDelayMs: number = DEFAULT_INTER_BATCH_DELAY_MS,
): Promise<EnrichAaveV4PositionsResult> {
  const spokeEntries = Object.entries(AAVE_V4_SPOKES) as [AaveV4SpokeName, ViemAddress][];

  // Stage 1: cheap pre-filter - one getUserAccountData call per (candidate, spoke).
  type AccountDataResult =
    | { status: "success"; result: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint] }
    | { status: "failure"; error: Error; result?: undefined };

  const accountDataResults: AccountDataResult[] = [];
  let failedCallCount = 0;

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batchCandidates = candidates.slice(i, i + batchSize);
    const contracts = batchCandidates.flatMap((user) =>
      spokeEntries.map(
        ([, spoke]) =>
          ({ address: spoke, abi: SPOKE_ABI, functionName: "getUserAccountData", args: [user as ViemAddress] }) as const,
      ),
    );
    if (contracts.length === 0) continue;
    const batchResults = await multicallWithRateLimitRetry<AccountDataResult>(client, contracts, undefined, "aaveV4UserEnrichment");
    accountDataResults.push(...batchResults);

    if (interBatchDelayMs > 0 && i + batchSize < candidates.length) {
      await sleep(interBatchDelayMs);
    }
  }

  // Real (candidate, spoke) pairs worth the expensive per-reserve enumeration.
  const realPairs: { user: string; spoke: AaveV4SpokeName; healthFactor: bigint }[] = [];
  for (let ci = 0; ci < candidates.length; ci++) {
    for (let si = 0; si < spokeEntries.length; si++) {
      const result = accountDataResults[ci * spokeEntries.length + si];
      const [, spoke] = spokeEntries[si]!;
      if (!result) continue;
      if (result.status !== "success") {
        failedCallCount++;
        continue;
      }
      const [, , healthFactor, , , activeCollateralCount, borrowCount] = result.result;
      if (borrowCount === 0n) continue; // no open debt - not a real candidate in this spoke
      realPairs.push({ user: candidates[ci]!, spoke: spokeEntries[si]![0], healthFactor });
      void activeCollateralCount;
      void spoke;
    }
  }

  const positionRecords: AaveV4PositionRecord[] = [];
  const reserveConfigByAsset = new Map<string, AaveReserveConfig>();
  for (const pair of realPairs) {
    const position = await buildPosition(client, pair.user, pair.spoke, pair.healthFactor, reserveConfigByAsset);
    if (position) positionRecords.push({ position, spoke: pair.spoke });
  }

  return { positionRecords, reserveConfigs: [...reserveConfigByAsset.values()], failedCallCount };
}

async function buildPosition(
  client: PublicClient,
  user: string,
  spokeName: AaveV4SpokeName,
  healthFactor: bigint,
  reserveConfigByAsset: Map<string, AaveReserveConfig>,
): Promise<Position | null> {
  const spoke = AAVE_V4_SPOKES[spokeName];
  const [reserveCount, oracle] = await Promise.all([
    client.readContract({ address: spoke, abi: SPOKE_ABI, functionName: "getReserveCount" }),
    client.readContract({ address: spoke, abi: SPOKE_ABI, functionName: "ORACLE" }),
  ]);

  const collateral: CollateralLeg[] = [];
  const debt: DebtLeg[] = [];
  let primaryCollateralReserveId: bigint | null = null;
  let primaryCollateralValue = -1n;
  let primaryCollateralMaxBonusBps = 0n;

  for (let reserveId = 0n; reserveId < reserveCount; reserveId++) {
    const [usedAsCollateral, isBorrowed] = await client.readContract({
      address: spoke,
      abi: SPOKE_ABI,
      functionName: "getUserReserveStatus",
      args: [reserveId, user as ViemAddress],
    });
    if (!usedAsCollateral && !isBorrowed) continue;

    const reserve = await client.readContract({ address: spoke, abi: SPOKE_ABI, functionName: "getReserve", args: [reserveId] });
    const price = await client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "getReservePrice", args: [reserveId] });
    const underlying = reserve[0];
    const decimals = reserve[3];
    const dynamicConfigKey = reserve[6];

    if (usedAsCollateral) {
      const supplied = await client.readContract({ address: spoke, abi: SPOKE_ABI, functionName: "getUserSuppliedAssets", args: [reserveId, user as ViemAddress] });
      if (supplied > 0n) {
        const [collateralFactor, maxLiquidationBonus] = await client.readContract({
          address: spoke,
          abi: SPOKE_ABI,
          functionName: "getDynamicReserveConfig",
          args: [reserveId, dynamicConfigKey],
        });
        collateral.push({ asset: underlying, amount: supplied, decimals, liquidationThresholdBps: BigInt(collateralFactor) });

        if (!reserveConfigByAsset.has(underlying.toLowerCase())) {
          const symbol = await client.readContract({ address: underlying, abi: TOKEN_ABI, functionName: "symbol" }).catch(() => "UNKNOWN");
          reserveConfigByAsset.set(underlying.toLowerCase(), {
            asset: underlying,
            symbol,
            decimals,
            liquidationBonusRaw: BigInt(maxLiquidationBonus),
            liquidationThresholdBps: BigInt(collateralFactor),
            isActive: true,
            isFrozen: false,
            priceUsd8: price,
          });
        }

        const valueUsd8 = (supplied * price) / 10n ** BigInt(decimals);
        if (valueUsd8 > primaryCollateralValue) {
          primaryCollateralValue = valueUsd8;
          primaryCollateralReserveId = reserveId;
          // maxLiquidationBonus is already in the "10000 = 0% bonus" total-multiplier
          // convention (DynamicReserveConfig's own NatSpec: "100_00 represents 0.00%
          // bonus") - same convention as getLiquidationBonus's return, so the same -10000n
          // normalization applies uniformly below regardless of which source won.
          primaryCollateralMaxBonusBps = BigInt(maxLiquidationBonus);
        }
      }
    }
    if (isBorrowed) {
      const totalDebt = await client.readContract({ address: spoke, abi: SPOKE_ABI, functionName: "getUserTotalDebt", args: [reserveId, user as ViemAddress] });
      if (totalDebt > 0n) {
        debt.push({ asset: underlying, amount: totalDebt, decimals });

        // A debt-only asset (never supplied as collateral by any position seen so far)
        // still needs a real price in basePrices for applyShock() to have anything to
        // shock - collateralFactor/liquidationBonus are meaningless for a pure debt asset
        // (0n placeholders, never read as a debt leg's own threshold).
        if (!reserveConfigByAsset.has(underlying.toLowerCase())) {
          const symbol = await client.readContract({ address: underlying, abi: TOKEN_ABI, functionName: "symbol" }).catch(() => "UNKNOWN");
          reserveConfigByAsset.set(underlying.toLowerCase(), {
            asset: underlying,
            symbol,
            decimals,
            liquidationBonusRaw: 10_000n,
            liquidationThresholdBps: 0n,
            isActive: true,
            isFrozen: false,
            priceUsd8: price,
          });
        }
      }
    }
  }

  if (debt.length === 0) return null; // fully repaid since discovery - not a current position

  // Real, disclosed wrinkle found live (not assumed): ISpoke.getLiquidationBonus() reverts
  // outright whenever the given health factor is >= 1.0 - confirmed directly (a real call at
  // a real position's actual current HF=1.029 reverted; the SAME call at a hypothetical
  // HF=0.9 succeeded, returning 10300). This makes real sense - there's no bonus for
  // liquidating a position that isn't liquidatable - but it means the live-bonus call is
  // only ever meaningful for the rare, already-distressed real position (HF<1.0), not the
  // overwhelming majority of healthy ones. For a healthy position, fall back to
  // maxLiquidationBonus (DynamicReserveConfig, always real and available) - the real
  // documented CEILING this reserve's bonus would reach under maximum distress, not a live
  // current-conditions snapshot. Disclosed as such, not silently conflated with the live
  // value - see engine/types.ts's liquidationIncentiveBps comment.
  let liquidationIncentiveBps = primaryCollateralMaxBonusBps > 10_000n ? primaryCollateralMaxBonusBps - 10_000n : 0n;
  if (primaryCollateralReserveId !== null && healthFactor < 10n ** 18n) {
    try {
      const liveBonusBps = await client.readContract({
        address: spoke,
        abi: SPOKE_ABI,
        functionName: "getLiquidationBonus",
        args: [primaryCollateralReserveId, user as ViemAddress, healthFactor],
      });
      liquidationIncentiveBps = BigInt(liveBonusBps) - 10_000n; // same total-multiplier
      // convention as Aave V3's own equivalent (10500 = 105% = 500bps bonus) - see
      // aaveUserEnrichment.ts's dominantCollateralIncentiveBps for the same subtraction.
    } catch {
      // Genuinely already liquidatable per our own HF<1.0 check, yet the real contract
      // still reverted - an edge case worth falling back safely for, not silently
      // pretending succeeded. maxLiquidationBonus (set above) remains the reported value.
    }
  }

  return {
    id: `aave-v4-${spokeName}-${user.toLowerCase()}`,
    protocol: "aave-v4",
    user,
    collateral,
    debt,
    liquidationIncentiveBps,
  };
}
