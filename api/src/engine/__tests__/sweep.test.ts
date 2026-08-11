import { describe, it, expect } from "vitest";
import { sweep } from "../sweep.js";
import { SHOCK_PRESETS } from "../shockModel.js";
import type { Position, PriceVector } from "../types.js";
import type { AssetShockConfig } from "../shockModel.js";

const basePrices: PriceVector = {
  WETH: 2000n * 100_000_000n,
  USDC: 100_000_000n,
};

const assetConfig: Record<string, AssetShockConfig> = {
  WETH: { beta: 1, subjectToDepeg: false },
  USDC: { beta: 0, subjectToDepeg: false },
};

function makePosition(id: string, ltv: number): Position {
  const collateralUsd = 50_000;
  const debtUsd = collateralUsd * ltv;
  return {
    id,
    protocol: "aave",
    user: id,
    collateral: [
      { asset: "WETH", amount: BigInt(Math.round((collateralUsd / 2000) * 1e18)), decimals: 18, liquidationThresholdBps: 8000n },
    ],
    debt: [{ asset: "USDC", amount: BigInt(Math.round(debtUsd * 1e6)), decimals: 6 }],
    liquidationIncentiveBps: 500n,
  };
}

describe("sweep", () => {
  const positions = [makePosition("p1", 0.5), makePosition("p2", 0.65), makePosition("p3", 0.78)];

  it("cumulative liquidatable collateral never decreases as the shock deepens (monotonicity)", () => {
    const magnitudes = Array.from({ length: 21 }, (_, i) => -i * 0.02); // 0% down to -40%
    const points = sweep({ positions, basePrices, assetConfig, preset: SHOCK_PRESETS.correlated, magnitudes });

    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.liquidatableCollateralUsd).toBeGreaterThanOrEqual(points[i - 1]!.liquidatableCollateralUsd);
      expect(points[i]!.liquidatablePositionCount).toBeGreaterThanOrEqual(points[i - 1]!.liquidatablePositionCount);
    }
  });

  it("nothing is liquidatable at zero shock (all positions well above their thresholds)", () => {
    const [point] = sweep({ positions, basePrices, assetConfig, preset: SHOCK_PRESETS.correlated, magnitudes: [0] });
    expect(point!.liquidatablePositionCount).toBe(0);
    expect(point!.liquidatableCollateralUsd).toBe(0);
  });

  it("everything is liquidatable once WETH has crashed far enough (sanity ceiling)", () => {
    const [point] = sweep({ positions, basePrices, assetConfig, preset: SHOCK_PRESETS.correlated, magnitudes: [-0.9] });
    expect(point!.liquidatablePositionCount).toBe(positions.length);
  });

  it("a position at 78% LTV against an 80% threshold flips to liquidatable at a specific, computable shock", () => {
    // HF = (0.80 * collateralUsd) / (0.78 * collateralUsd) at zero shock = 1.0256 (safe).
    // Shocking WETH by t moves collateral value by (1+t) while debt (USDC) is unaffected:
    // HF(t) = 1.0256 * (1+t) < 1  =>  t < 1/1.0256 - 1 ~= -0.025 (-2.5%)
    const magnitudes = [-0.02, -0.03];
    const points = sweep({ positions: [makePosition("edge", 0.78)], basePrices, assetConfig, preset: SHOCK_PRESETS.correlated, magnitudes });
    expect(points[0]!.liquidatablePositionCount).toBe(0); // -2% not enough yet
    expect(points[1]!.liquidatablePositionCount).toBe(1); // -3% tips it over
  });
});
