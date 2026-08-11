import { describe, it, expect } from "vitest";
import { healthFactor, isLiquidatable, WAD } from "../healthFactor.js";
import type { Position, PriceVector } from "../types.js";

/**
 * Hand-computed fixture: 10 WETH collateral @ $2000, 80% liquidation threshold;
 * 10,000 USDC debt @ $1.
 *
 * adjustedCollateral = 10 * 2000 * 0.80 = $16,000
 * HF = 16,000 / 10,000 = 1.6
 */
const basePosition: Position = {
  id: "p1",
  protocol: "aave",
  user: "0xabc",
  collateral: [
    { asset: "WETH", amount: 10n * 10n ** 18n, decimals: 18, liquidationThresholdBps: 8000n },
  ],
  debt: [{ asset: "USDC", amount: 10_000n * 10n ** 6n, decimals: 6 }],
  liquidationIncentiveBps: 500n,
};

const prices: PriceVector = {
  WETH: 2000n * 100_000_000n, // $2000, 8 decimals
  USDC: 100_000_000n, // $1, 8 decimals
};

describe("healthFactor", () => {
  it("matches hand-computed value: 1.6", () => {
    const hf = healthFactor(basePosition, prices);
    expect(hf).toBe((16n * WAD) / 10n); // 1.6e18
  });

  it("is not liquidatable at HF 1.6", () => {
    expect(isLiquidatable(basePosition, prices)).toBe(false);
  });

  it("becomes liquidatable once debt rises enough to push HF below 1", () => {
    // debt now $20,000 against $16,000 adjusted collateral -> HF = 0.8
    const underwater: Position = {
      ...basePosition,
      debt: [{ asset: "USDC", amount: 20_000n * 10n ** 6n, decimals: 6 }],
    };
    const hf = healthFactor(underwater, prices);
    expect(hf).toBe((8n * WAD) / 10n); // 0.8e18
    expect(isLiquidatable(underwater, prices)).toBe(true);
  });

  it("returns null for a position with zero debt (undefined HF, not liquidatable)", () => {
    const noDebt: Position = { ...basePosition, debt: [] };
    expect(healthFactor(noDebt, prices)).toBeNull();
    expect(isLiquidatable(noDebt, prices)).toBe(false);
  });

  it("is exactly at the liquidation boundary when HF == 1 (not liquidatable - condition is strict <)", () => {
    // debt $16,000 against $16,000 adjusted collateral -> HF exactly 1.0
    const atBoundary: Position = {
      ...basePosition,
      debt: [{ asset: "USDC", amount: 16_000n * 10n ** 6n, decimals: 6 }],
    };
    expect(healthFactor(atBoundary, prices)).toBe(WAD);
    expect(isLiquidatable(atBoundary, prices)).toBe(false);
  });
});
