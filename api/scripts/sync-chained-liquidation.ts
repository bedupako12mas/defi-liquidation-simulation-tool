import { publicClient, assertAllowedChain } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { resolveAaveAddresses } from "../src/loaders/aaveAddresses.js";
import { loadReserveConfigs } from "../src/loaders/aaveReserveConfig.js";
import { enrichPositions } from "../src/loaders/aaveUserEnrichment.js";
import { classifySymbolForShock } from "../src/routes/aaveShockClassification.js";
import { applyShock, SHOCK_PRESETS } from "../src/engine/shockModel.js";
import { healthFactor } from "../src/engine/healthFactor.js";
import { validateAaveLiquidation } from "../src/validation/aaveValidator.js";
import { startAnvilFork, type AnvilFork } from "../src/fork/anvilFork.js";
import { buildFixedReturnBytecode } from "../src/validation/stateOverride.js";
import { probeTokenSlots } from "../src/validation/slotProbe.js";
import { redactError } from "../src/rpc/redact.js";
import { parseAbi, encodeFunctionData, keccak256, encodeAbiParameters, numberToHex, getAddress } from "viem";
import type { AssetShockConfig } from "../src/engine/shockModel.js";
import type { PriceVector, Position } from "../src/engine/types.js";
import type { AaveReserveConfig } from "../src/loaders/aaveReserveConfig.js";
import type { Insertable } from "kysely";
import type { ChainedLiquidationResultsTable } from "../src/db/types.js";

/**
 * #37: the real, fork-requiring capability locked in per docs/decisions.md - does liquidating
 * position A FOR REAL change position B's REAL liquidation outcome, compared to testing B in
 * isolation (validation_results' eth_call method, stateless by construction)? For every real
 * group of currently-liquidatable positions sharing the same (collateral, debt) reserve pair,
 * spins up ONE fresh ephemeral anvil fork, mines A's real liquidationCall(), and compares B's
 * validateAaveLiquidation result before vs. after on that same fork. One fresh fork per group -
 * not one shared across all groups - so "isolated" always means "before ANY real liquidation
 * has been mined on this fork," not contaminated by an earlier group's A.
 *
 * Live-verified design: see the two real bugs this methodology caught before this script was
 * written (docs/decisions.md's #37 entry) - a case-mismatch that silently dropped every price
 * override, and a liquidator-identity collision that let A's real collateral contaminate B's
 * balance reading. Both are fixed here from the start, not rediscovered.
 */
const PRESET_ID = "correlated";
const MAGNITUDE = -0.3;
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
// A's real mined liquidation MUST use a different identity than Multicall3 (which
// validateAaveLiquidation always checks internally, hardcoded) - reusing it left A's real
// collateral sitting in the same balance B's checks read from, an inflation artifact caught live.
const A_LIQUIDATOR_IDENTITY = getAddress(`0x${"a1".repeat(20)}`);
const CANDIDATE_LIMIT = 300;
const PREFILTER_ATTEMPTS = 10;

const ORACLE_SOURCE_ABI = parseAbi(["function getSourceOfAsset(address asset) view returns (address)"]);
const POOL_ABI = parseAbi([
  "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)",
]);

async function findChainedResult(
  pool: `0x${string}`,
  oracle: `0x${string}`,
  dataProvider: `0x${string}`,
  positionB: Position,
  candidatesForA: Position[],
  shockedPrices: PriceVector,
  configByAsset: Map<string, AaveReserveConfig>,
  forkPort: number,
): Promise<Insertable<ChainedLiquidationResultsTable> | null> {
  const collateralB = positionB.collateral[0]!.asset as `0x${string}`;
  const debtB = positionB.debt[0]!.asset as `0x${string}`;
  const collateralConfigB = configByAsset.get(collateralB.toLowerCase());
  if (!collateralConfigB) return null;

  // Prefilter via the same cheap eth_call validateAaveLiquidation uses (no fork, no
  // mutation) - real Aave has caps beyond HF<1 (e.g. the disclosed MustNotLeaveDust gap)
  // a naive filter can't predict, so the real mined tx below isn't a coin flip.
  let positionA: Position | undefined;
  for (const candidate of candidatesForA.slice(0, PREFILTER_ATTEMPTS)) {
    const collateralAsset = candidate.collateral[0]!.asset as `0x${string}`;
    const debtAsset = candidate.debt[0]!.asset as `0x${string}`;
    const collateralConfig = configByAsset.get(collateralAsset.toLowerCase());
    if (!collateralConfig) continue;
    const probe = await validateAaveLiquidation(publicClient, pool, {
      position: candidate,
      shockedPrices,
      oracleOverridePrices: { [collateralAsset]: shockedPrices[collateralAsset]!, [debtAsset]: shockedPrices[debtAsset]! },
      collateralAsset,
      debtAsset,
      collateralLiquidationBonusRaw: collateralConfig.liquidationBonusRaw,
      dataProvider,
      oracle,
    });
    if (probe.status === "liquidated") {
      positionA = candidate;
      break;
    }
  }
  if (!positionA) {
    console.log(`[sync-chained] ${positionB.id}: no candidate A simulated successfully - skipping this group.`);
    return null;
  }

  const collateralA = positionA.collateral[0]!.asset as `0x${string}`;
  const debtA = positionA.debt[0]!.asset as `0x${string}`;

  let fork: AnvilFork | undefined;
  try {
    // A distinct port per group, not the shared default - SIGKILL doesn't guarantee the OS
    // releases the previous group's port before the next spawn, and reusing one port raced
    // live (a real WaitForTransactionReceiptTimeoutError on the second group in a run).
    fork = await startAnvilFork(undefined, forkPort);

    // NOT lowercased: shockedPrices is keyed by the exact checksummed casing
    // reserveConfigs/position legs already share - lowercasing here silently drops every
    // lookup (caught live: see this file's top comment).
    const assetsToShock = new Set([collateralA, debtA, collateralB, debtB]);
    for (const asset of assetsToShock) {
      const price = shockedPrices[asset];
      if (price === undefined) continue;
      const source = await fork.publicClient.readContract({ address: oracle, abi: ORACLE_SOURCE_ABI, functionName: "getSourceOfAsset", args: [asset] });
      await fork.setCode(source, buildFixedReturnBytecode(price));
    }

    // Persistent debt-token funding for A_LIQUIDATOR_IDENTITY only - B's own funding is
    // handled entirely by validateAaveLiquidation's existing per-call override.
    const debtLegA = positionA.debt.find((d) => d.asset === debtA)!;
    const slots = await probeTokenSlots(fork.publicClient, debtA, A_LIQUIDATOR_IDENTITY, pool);
    if (!slots) {
      console.log(`[sync-chained] ${positionB.id}: could not probe slots for ${debtA} - skipping.`);
      return null;
    }
    const fundedAmount = debtLegA.amount * 1000n + 10n ** 30n;
    const balanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [A_LIQUIDATOR_IDENTITY, BigInt(slots.balanceSlotIndex)]));
    const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [A_LIQUIDATOR_IDENTITY, BigInt(slots.allowanceSlotIndex)]));
    const allowanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [pool, ownerSlot]));
    await fork.setStorageAt(debtA, balanceSlot, numberToHex(fundedAmount, { size: 32 }));
    await fork.setStorageAt(debtA, allowanceSlot, numberToHex(fundedAmount, { size: 32 }));

    const isolatedB = await validateAaveLiquidation(fork.publicClient, pool, {
      position: positionB,
      shockedPrices,
      oracleOverridePrices: { [collateralB]: shockedPrices[collateralB]!, [debtB]: shockedPrices[debtB]! },
      collateralAsset: collateralB,
      debtAsset: debtB,
      collateralLiquidationBonusRaw: collateralConfigB.liquidationBonusRaw,
      dataProvider,
      oracle,
    });

    const wallet = await fork.impersonate(A_LIQUIDATOR_IDENTITY);
    const liquidationCalldataA = encodeFunctionData({
      abi: POOL_ABI,
      functionName: "liquidationCall",
      args: [collateralA, debtA, positionA.user as `0x${string}`, debtLegA.amount, false],
    });
    const txHashA = await wallet.sendTransaction({ account: A_LIQUIDATOR_IDENTITY, to: pool, data: liquidationCalldataA, chain: null });
    const receiptA = await fork.publicClient.waitForTransactionReceipt({ hash: txHashA });
    console.log(`[sync-chained] ${positionA.id} -> ${positionB.id}: A's real liquidation ${receiptA.status}, block ${receiptA.blockNumber}`);

    const debtConfig = configByAsset.get(debtB.toLowerCase());
    const base = {
      protocol: "aave" as const,
      preset_id: PRESET_ID,
      magnitude_pct: (MAGNITUDE * 100).toString(),
      position_a_id: positionA.id,
      position_b_id: positionB.id,
      debt_asset_symbol: debtConfig?.symbol ?? null,
      debt_asset_decimals: debtConfig?.decimals ?? null,
      position_a_tx_status: receiptA.status,
    };

    if (receiptA.status !== "success") {
      return { ...base, isolated_status: isolatedB.status, isolated_debt_repaid: null, chained_status: null, chained_debt_repaid: null, debt_repaid_diff: null, detail: "A's real liquidation reverted on the fork - chaining not testable for this pair." };
    }

    const chainedB = await validateAaveLiquidation(fork.publicClient, pool, {
      position: positionB,
      shockedPrices,
      oracleOverridePrices: { [collateralB]: shockedPrices[collateralB]!, [debtB]: shockedPrices[debtB]! },
      collateralAsset: collateralB,
      debtAsset: debtB,
      collateralLiquidationBonusRaw: collateralConfigB.liquidationBonusRaw,
      dataProvider,
      oracle,
    });

    const isolatedRepaid = isolatedB.status === "liquidated" ? isolatedB.actualDebtRepaid : null;
    const chainedRepaid = chainedB.status === "liquidated" ? chainedB.actualDebtRepaid : null;
    const diff = isolatedRepaid !== null && chainedRepaid !== null ? chainedRepaid - isolatedRepaid : null;

    return {
      ...base,
      isolated_status: isolatedB.status,
      isolated_debt_repaid: isolatedRepaid,
      chained_status: chainedB.status,
      chained_debt_repaid: chainedRepaid,
      debt_repaid_diff: diff,
      detail: null,
    };
  } finally {
    fork?.stop();
  }
}

async function main() {
  await assertAllowedChain();

  const candidates = await db.selectFrom("aave_borrow_candidates").select("address").limit(CANDIDATE_LIMIT).execute();
  const { dataProvider, pool, oracle } = await resolveAaveAddresses(publicClient);
  const reserveConfigs = await loadReserveConfigs(publicClient);
  const { positions } = await enrichPositions(publicClient, dataProvider, candidates.map((c) => c.address), reserveConfigs, undefined, 8);

  const realPrices: PriceVector = Object.fromEntries(reserveConfigs.map((r) => [r.asset, r.priceUsd8]));
  const assetConfig: Record<string, AssetShockConfig> = Object.fromEntries(
    reserveConfigs.map((r) => [r.asset, classifySymbolForShock(r.symbol)]),
  );
  const configByAsset = new Map(reserveConfigs.map((r) => [r.asset.toLowerCase(), r]));
  const shockedPrices = applyShock(realPrices, assetConfig, MAGNITUDE, SHOCK_PRESETS[PRESET_ID]);

  const testable = positions.filter((p) => {
    if (p.collateral.length === 0 || p.debt.length === 0) return false;
    const hf = healthFactor(p, shockedPrices);
    return hf !== null && hf < 1_000_000_000_000_000_000n;
  });
  console.log(`[sync-chained] ${positions.length} positions loaded, ${testable.length} liquidatable at ${MAGNITUDE * 100}% correlated.`);

  const byPair = new Map<string, Position[]>();
  for (const p of testable) {
    const key = `${p.collateral[0]!.asset.toLowerCase()}-${p.debt[0]!.asset.toLowerCase()}`;
    (byPair.get(key) ?? byPair.set(key, []).get(key)!).push(p);
  }
  const groups = [...byPair.values()].filter((arr) => arr.length >= 2);
  console.log(`[sync-chained] ${groups.length} real shared-reserve-pair group(s) found among liquidatable positions.`);

  const rows: Insertable<ChainedLiquidationResultsTable>[] = [];
  for (let i = 0; i < groups.length; i++) {
    const [positionB, ...candidatesForA] = groups[i]!;
    const result = await findChainedResult(pool, oracle, dataProvider, positionB!, candidatesForA, shockedPrices, configByAsset, 8546 + i);
    if (result) rows.push(result);
  }

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("chained_liquidation_results").where("protocol", "=", "aave").execute();
    if (rows.length > 0) await trx.insertInto("chained_liquidation_results").values(rows).execute();
  });
  console.log(`[sync-chained] wrote ${rows.length} aave row(s).`);

  await db.destroy();
}

main().catch(async (err) => {
  console.error(redactError(err));
  await db.destroy();
  process.exitCode = 1;
});
