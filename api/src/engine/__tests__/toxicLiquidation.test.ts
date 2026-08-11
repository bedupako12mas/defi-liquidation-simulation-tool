import { describe, it, expect } from "vitest";
import { undercollateralizationFrontier, currentLtv, isToxicLiquidation, badDebtUsd8 } from "../toxicLiquidation.js";
import { WAD } from "../healthFactor.js";
import type { Position, PriceVector } from "../types.js";

describe("undercollateralizationFrontier", () => {
  it("reproduces the paper's own worked example: i=4.5% -> LTV_UC ~= 0.9569 (arXiv:2212.07306 Eq. 5)", () => {
    const frontier = undercollateralizationFrontier(450n); // 4.5% in bps
    // Paper states LTV_UC = 1/1.045 ~= 0.9569. Bigint division truncates, so check a tight bound
    // rather than an exact float comparison.
    expect(frontier).toBeGreaterThan(956_900_000_000_000_000n);
    expect(frontier).toBeLessThan(957_000_000_000_000_000n);
  });

  it("a smaller incentive produces a higher (safer) frontier - Fluid's 0.1% case", () => {
    const fluidFrontier = undercollateralizationFrontier(10n); // 0.1% in bps
    const aaveFrontier = undercollateralizationFrontier(450n);
    expect(fluidFrontier).toBeGreaterThan(aaveFrontier);
    // 1/1.001 ~= 0.9990
    expect(fluidFrontier).toBeGreaterThan(998_900_000_000_000_000n);
  });
});

// $100 collateral (USDC), CRV debt priced so LTV lands exactly where we want to test.
function makePosition(debtUsd: number, incentiveBps: bigint): Position {
  return {
    id: "test",
    protocol: "aave",
    user: "0xavi",
    collateral: [{ asset: "USDC", amount: 100_000_000n, decimals: 6, liquidationThresholdBps: 8900n }],
    debt: [{ asset: "CRV", amount: BigInt(Math.round(debtUsd * 1e18)), decimals: 18 }],
    liquidationIncentiveBps: incentiveBps,
  };
}

const prices: PriceVector = { USDC: 100_000_000n, CRV: 100_000_000n }; // both $1 for clean arithmetic

describe("currentLtv", () => {
  it("is a plain debt/collateral ratio, unweighted by liquidation threshold", () => {
    const position = makePosition(96, 450n); // $96 debt / $100 collateral
    expect(currentLtv(position, prices)).toBe((96n * WAD) / 100n);
  });
});

describe("isToxicLiquidation - reproduces the paper's Avi/CRV case (i=4.5%, frontier ~=0.9569)", () => {
  it("is toxic once LTV crosses the 0.9569 frontier", () => {
    const position = makePosition(96, 450n); // LTV 0.96 > 0.9569
    expect(isToxicLiquidation(position, prices)).toBe(true);
  });

  it("is not toxic below the frontier", () => {
    const position = makePosition(90, 450n); // LTV 0.90 < 0.9569
    expect(isToxicLiquidation(position, prices)).toBe(false);
  });

  it("Fluid's near-zero incentive keeps far more of the LTV range non-toxic", () => {
    const position = makePosition(96, 10n); // same LTV 0.96, but i=0.1%
    // frontier is ~0.999, so 0.96 is comfortably below it - not toxic
    expect(isToxicLiquidation(position, prices)).toBe(false);
  });
});

describe("badDebtUsd8", () => {
  it("is zero while collateral still covers debt", () => {
    const position = makePosition(90, 450n);
    expect(badDebtUsd8(position, prices)).toBe(0n);
  });

  it("equals the shortfall once debt exceeds collateral", () => {
    const position = makePosition(120, 450n); // $120 debt vs $100 collateral -> $20 shortfall
    expect(badDebtUsd8(position, prices)).toBe(2_000_000_000n); // $20 in 8-decimal USD (20 * 1e8)
  });
});
