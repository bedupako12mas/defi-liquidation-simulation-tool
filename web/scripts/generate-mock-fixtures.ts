/**
 * Dev-time codegen: produces `lib/api/mock/fixtures.generated.json`, consumed by
 * `lib/api/mock/mockClient.ts` while `NEXT_PUBLIC_USE_MOCK_API` is on (the default - see
 * lib/api/meta.ts's top comment for the real/mock swap point).
 *
 * WHY GENERATE INSTEAD OF HAND-WRITE THE JSON: the whole point of the mock layer is that it
 * exercises the SAME contract shape the real API will return. The cheapest way to guarantee
 * that isn't "type it carefully by hand" (which drifts, silently, the moment sweep.ts's
 * output shape changes) - it's to literally run the real, tested engine
 * (`api/src/engine/`, 17 passing tests as of the commit that ported it - see
 * docs/decisions.md) against a small fixture position set and freeze its actual output. If
 * the engine's math or output shape changes, re-running this script is how the mock data
 * stays honest, not a second hand-maintained copy of the math.
 *
 * WHY A FRESH FIXTURE POSITION SET, NOT app/api's: web must not depend on the sibling
 * `Liquidation Mechanisms` repo/worktree at build or runtime - this script only reaches
 * into `../../api/src/engine` (same repo, api, a dev-time-only cross-import - nothing in
 * the shipped Next.js app imports across the package boundary; only this codegen script
 * does, and only at generation time). The position/param values below are a new, smaller,
 * clearly-labeled illustrative set, not copied from anywhere real.
 *
 * Run: `npm run generate:mocks` (from web). Re-run and re-commit the output whenever the
 * engine's math, this script's fixture set, or the sweep/position grid changes.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { sweep, type SweepPoint } from "../../api/src/engine/sweep.js";
import { SHOCK_PRESETS, applyShock, type AssetShockConfig } from "../../api/src/engine/shockModel.js";
import {
  healthFactor,
  totalCollateralValueUsd8,
  totalDebtValueUsd8,
  isLiquidatable,
} from "../../api/src/engine/healthFactor.js";
import {
  undercollateralizationFrontier,
  currentLtv,
  isToxicLiquidation,
  badDebtUsd8,
} from "../../api/src/engine/toxicLiquidation.js";
import type { Position, PriceVector, ShockPreset } from "../../api/src/engine/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USD8 = 100_000_000;

// ---------------------------------------------------------------------------------------
// Mock protocol params - illustrative, for frontend development only. Not on-chain data.
// ---------------------------------------------------------------------------------------

interface AssetParams {
  liquidationThresholdBps: bigint;
  liquidationIncentiveBps: bigint;
  provenance: "cited" | "illustrative";
  note: string;
}

const AAVE_PARAMS: Record<string, AssetParams> = {
  WETH: {
    liquidationThresholdBps: 8300n,
    liquidationIncentiveBps: 500n,
    provenance: "illustrative",
    note: "web mock fixture - generic Aave V3 mainnet WETH figures, not read from a deployed contract.",
  },
  WSTETH: {
    liquidationThresholdBps: 8000n,
    liquidationIncentiveBps: 750n,
    provenance: "cited",
    note: "web mock fixture, mirroring the cited Aave V3 stETH parameters used in docs/SCOPE.md's comparison table (80% LT, 7.5% incentive).",
  },
  USDC: {
    liquidationThresholdBps: 8900n,
    liquidationIncentiveBps: 450n,
    provenance: "cited",
    note: "Nov-2022 CRV-incident figures (89% LT, 4.5% incentive) as reported in Warmuz, Chaudhary & Pinna's unreviewed preprint, arXiv:2212.07306 - cited for the historical figures only, not as validation of the underlying math (which follows directly from the protocol's own threshold and bonus).",
  },
};

const FLUID_PARAMS: Record<string, AssetParams> = {
  WSTETH: {
    liquidationThresholdBps: 9500n,
    liquidationIncentiveBps: 10n,
    provenance: "illustrative",
    note: "web mock fixture - illustrative Fluid T1 correlated-pair figure, NOT on-chain verified. See docs/SCOPE.md limitation on this ceiling figure's provenance.",
  },
  WEETH: {
    liquidationThresholdBps: 9300n,
    liquidationIncentiveBps: 15n,
    provenance: "illustrative",
    note: "web mock fixture - same caveat as WSTETH above.",
  },
  WETH: {
    liquidationThresholdBps: 8500n,
    liquidationIncentiveBps: 100n,
    provenance: "illustrative",
    note: "web mock fixture - illustrative uncorrelated-pair Fluid T1 vault figure.",
  },
};

const BASE_PRICES: PriceVector = {
  WETH: 2_000n * 100_000_000n,
  WSTETH: 2_100n * 100_000_000n,
  WEETH: 2_080n * 100_000_000n,
  USDC: 1n * 100_000_000n,
};

const ASSET_SHOCK_CONFIG: Record<string, AssetShockConfig> = {
  WETH: { beta: 1, subjectToDepeg: false },
  WSTETH: { beta: 1, subjectToDepeg: true },
  WEETH: { beta: 1, subjectToDepeg: true },
  USDC: { beta: 0, subjectToDepeg: false },
};

// ---------------------------------------------------------------------------------------
// Mock positions - a small, deliberately clustered set (same illustrative spirit as
// app/api's fixtures, but a fresh/smaller set written for web, not copied).
// ---------------------------------------------------------------------------------------

function aavePosition(id: string, collateralUsd: number, ltv: number, asset: "WETH" | "WSTETH"): Position {
  const price = asset === "WETH" ? 2000 : 2100;
  const params = AAVE_PARAMS[asset]!;
  const debtUsd = collateralUsd * ltv;
  return {
    id,
    protocol: "aave",
    user: id,
    collateral: [
      {
        asset,
        amount: BigInt(Math.round((collateralUsd / price) * 1e18)),
        decimals: 18,
        liquidationThresholdBps: params.liquidationThresholdBps,
      },
    ],
    debt: [{ asset: "USDC", amount: BigInt(Math.round(debtUsd * 1e6)), decimals: 6 }],
    liquidationIncentiveBps: params.liquidationIncentiveBps,
  };
}

function fluidPosition(id: string, collateralUsd: number, ltv: number, asset: "WSTETH" | "WEETH" | "WETH"): Position {
  const price = asset === "WETH" ? 2000 : asset === "WSTETH" ? 2100 : 2080;
  const params = FLUID_PARAMS[asset]!;
  const debtUsd = collateralUsd * ltv;
  const debtAsset = asset === "WETH" ? "USDC" : "WETH";
  const debtDecimals = debtAsset === "USDC" ? 6 : 18;
  const debtPrice = debtAsset === "USDC" ? 1 : 2000;
  return {
    id,
    protocol: "fluid",
    user: id,
    collateral: [
      {
        asset,
        amount: BigInt(Math.round((collateralUsd / price) * 1e18)),
        decimals: 18,
        liquidationThresholdBps: params.liquidationThresholdBps,
      },
    ],
    debt: [{ asset: debtAsset, amount: BigInt(Math.round((debtUsd / debtPrice) * 10 ** debtDecimals)), decimals: debtDecimals }],
    liquidationIncentiveBps: params.liquidationIncentiveBps,
  };
}

function buildAavePositions(): Position[] {
  const positions: Position[] = [];
  const clusterA = [20_000, 40_000, 60_000, 80_000, 100_000];
  clusterA.forEach((size, i) => positions.push(aavePosition(`aave-clusterA-${i}`, size, 0.75, "WETH")));

  const clusterB = [15_000, 30_000, 50_000, 70_000, 90_000];
  clusterB.forEach((size, i) => positions.push(aavePosition(`aave-clusterB-${i}`, size, 0.79, "WETH")));

  for (let i = 0; i < 8; i++) {
    const ltv = 0.45 + i * 0.03;
    const size = i % 2 === 0 ? 10_000 : 25_000;
    positions.push(aavePosition(`aave-scatter-${i}`, size, ltv, "WETH"));
  }

  for (let i = 0; i < 5; i++) {
    const ltv = 0.6 + i * 0.03;
    positions.push(aavePosition(`aave-correlated-${i}`, 40_000 + i * 15_000, ltv, "WSTETH"));
  }

  return positions;
}

function buildFluidPositions(): Position[] {
  const positions: Position[] = [];
  for (let i = 0; i < 15; i++) {
    const ltv = 0.55 + i * 0.025; // up to ~0.90
    const size = 30_000 + (i % 5) * 15_000;
    positions.push(fluidPosition(`fluid-correlated-${i}`, size, ltv, i % 3 === 0 ? "WEETH" : "WSTETH"));
  }
  for (let i = 0; i < 5; i++) {
    const ltv = 0.55 + i * 0.04;
    positions.push(fluidPosition(`fluid-uncorrelated-${i}`, 30_000 + i * 20_000, ltv, "WETH"));
  }
  return positions;
}

const AAVE_POSITIONS = buildAavePositions();
const FLUID_POSITIONS = buildFluidPositions();

// ---------------------------------------------------------------------------------------
// Sweep grid - mirrors app/api/src/routes/simulate.ts's server-side-fixed grid (0 to -80%,
// 1% steps). Position-snapshot grid is coarser (5% steps) purely to keep the generated JSON
// small; mockClient.ts snaps a requested magnitudePct to the nearest available step, exactly
// as the real /api/positions endpoint would be expected to do for an out-of-grid request.
// ---------------------------------------------------------------------------------------

function sweepMagnitudes(stepPct: number): number[] {
  const out: number[] = [];
  for (let pct = 0; pct >= -80; pct -= stepPct) out.push(pct / 100);
  return out;
}

function positionState(position: Position, prices: PriceVector): "healthy" | "liquidatable" | "toxic" {
  if (isToxicLiquidation(position, prices)) return "toxic";
  if (isLiquidatable(position, prices)) return "liquidatable";
  return "healthy";
}

function toSnapshot(position: Position, prices: PriceVector) {
  const hf = healthFactor(position, prices);
  const ltv = currentLtv(position, prices);
  const frontier = undercollateralizationFrontier(position.liquidationIncentiveBps);
  return {
    id: position.id,
    protocol: position.protocol,
    collateralUsd: Number(totalCollateralValueUsd8(position, prices)) / USD8,
    debtUsd: Number(totalDebtValueUsd8(position, prices)) / USD8,
    healthFactor: hf === null ? null : Number(hf) / 1e18,
    ltvPct: ltv === null ? null : Math.round((Number(ltv) / 1e18) * 10000) / 100,
    ucFrontierPct: Math.round((Number(frontier) / 1e18) * 10000) / 100,
    state: positionState(position, prices),
    badDebtUsd: Number(badDebtUsd8(position, prices)) / USD8,
  };
}

function ucFrontierTable() {
  const rows: Array<{
    protocol: string;
    asset: string;
    incentivePct: number;
    ucFrontierPct: number;
    liquidationThresholdPct: number;
    provenance: string;
  }> = [];
  for (const [protocol, params] of [
    ["aave", AAVE_PARAMS],
    ["fluid", FLUID_PARAMS],
  ] as const) {
    for (const [asset, p] of Object.entries(params)) {
      const frontier = undercollateralizationFrontier(p.liquidationIncentiveBps);
      rows.push({
        protocol,
        asset,
        incentivePct: Number(p.liquidationIncentiveBps) / 100,
        ucFrontierPct: Math.round((Number(frontier) / 1e18) * 10000) / 100,
        liquidationThresholdPct: Number(p.liquidationThresholdBps) / 100,
        provenance: `${p.provenance}: ${p.note}`,
      });
    }
  }
  return rows;
}

const LIMITATIONS = [
  "No second-order price impact - a real liquidation dumping seized collateral into an AMM would push price down further and trigger the next tranche. This static sweep does not model that.",
  "Correlation/depeg betas are assumptions, not fitted from data (except severe-depeg's 7%, grounded in the real June 2022 stETH event).",
  "No routine oracle update lag modeled (Chainlink heartbeat/deviation delay) - prices are assumed to update instantaneously and fully. See docs/SCOPE.md's 3a/3b split for why this is distinct from designed staleness (CappedRate), which the fork tier targets.",
  "No gas-vs-bonus profitability check - the model does not ask whether a bot would bother liquidating a small position given gas cost vs. bonus.",
  "No liquidity/slippage-capacity check - the model does not ask whether the market can actually absorb the seized collateral at a profit.",
  "No toxic-liquidation-spiral / cascade dynamics simulated yet in this milestone - positions crossing the undercollateralization frontier are flagged, but the multi-round spiral itself is not replayed. That is Milestone 2 (CascadeDetailTab), gated on capabilities.fork.",
  "This comparison addresses liquidation-mechanism risk under genuine price shocks only, not collateral-integrity failures (bridge/oracle exploits) - see docs/SCOPE.md.",
  "MOCK MODE (web, Milestone 1): positions and protocol parameters below are synthetic fixtures baked by scripts/generate-mock-fixtures.ts for frontend development, computed with the real, tested engine (api/src/engine) but not sourced from chain and not the same fixture set app/api's demo uses. Swapped for a live api response once its routes exist - see lib/api/meta.ts.",
];

function buildMeta() {
  return {
    mode: "demo" as const,
    pinnedBlock: null,
    presets: Object.values(SHOCK_PRESETS),
    ucFrontier: ucFrontierTable(),
    limitations: LIMITATIONS,
    capabilities: { rpc: true, fork: false },
  };
}

function buildSweeps() {
  const magnitudes = sweepMagnitudes(1);
  const out: Record<string, { aave: SweepPoint[]; fluid: SweepPoint[] }> = {};
  for (const preset of Object.values(SHOCK_PRESETS) as ShockPreset[]) {
    out[preset.id] = {
      aave: sweep({ positions: AAVE_POSITIONS, basePrices: BASE_PRICES, assetConfig: ASSET_SHOCK_CONFIG, preset, magnitudes }),
      fluid: sweep({ positions: FLUID_POSITIONS, basePrices: BASE_PRICES, assetConfig: ASSET_SHOCK_CONFIG, preset, magnitudes }),
    };
  }
  return out;
}

function buildPositionSnapshots() {
  const magnitudes = sweepMagnitudes(5);
  const out: Record<string, { aave: Record<string, ReturnType<typeof toSnapshot>[]>; fluid: Record<string, ReturnType<typeof toSnapshot>[]> }> = {};

  for (const preset of Object.values(SHOCK_PRESETS) as ShockPreset[]) {
    const aaveByMagnitude: Record<string, ReturnType<typeof toSnapshot>[]> = {};
    const fluidByMagnitude: Record<string, ReturnType<typeof toSnapshot>[]> = {};

    for (const magnitude of magnitudes) {
      const prices = applyShock(BASE_PRICES, ASSET_SHOCK_CONFIG, magnitude, preset);
      const key = String(Math.round(magnitude * 1000) / 10); // matches SweepPoint.magnitudePct formatting
      aaveByMagnitude[key] = AAVE_POSITIONS.map((p) => toSnapshot(p, prices));
      fluidByMagnitude[key] = FLUID_POSITIONS.map((p) => toSnapshot(p, prices));
    }

    out[preset.id] = { aave: aaveByMagnitude, fluid: fluidByMagnitude };
  }

  return out;
}

const fixtures = {
  generatedAt: new Date().toISOString(),
  generatedBy: "web/scripts/generate-mock-fixtures.ts (real api/src/engine output, frozen)",
  meta: buildMeta(),
  sweeps: buildSweeps(),
  positionSnapshots: buildPositionSnapshots(),
};

const outPath = path.join(__dirname, "..", "lib", "api", "mock", "fixtures.generated.json");
writeFileSync(outPath, JSON.stringify(fixtures, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
