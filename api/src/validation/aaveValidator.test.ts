import { describe, it, expect } from "vitest";
import { computeExpectedMaxLiquidatableDebt } from "./aaveValidator.js";
import type { Position, PriceVector } from "../engine/types.js";

const COLLATERAL_ASSET = "0xCollateral";
const DEBT_ASSET = "0xDebt";
const BONUS_5PCT = 10_500n; // raw Aave form: 105% = 5% bonus

function makePosition(collateralAmount: bigint, debtAmount: bigint, liquidationThresholdBps = 8000n): Position {
  return {
    id: "test",
    protocol: "aave",
    user: "0xUser",
    collateral: [
      { asset: COLLATERAL_ASSET, amount: collateralAmount, decimals: 18, liquidationThresholdBps },
    ],
    debt: [{ asset: DEBT_ASSET, amount: debtAmount, decimals: 6 }],
    liquidationIncentiveBps: 500n,
  };
}

describe("computeExpectedMaxLiquidatableDebt", () => {
  it("returns null when the position isn't liquidatable (HF >= 1)", () => {
    // 10 collateral @ $2000 = $20,000, threshold 80% -> $16,000 available vs $1,000 debt: healthy.
    const position = makePosition(10n * 10n ** 18n, 1_000n * 10n ** 6n);
    const prices: PriceVector = { [COLLATERAL_ASSET]: 2000n * 10n ** 8n, [DEBT_ASSET]: 1n * 10n ** 8n };
    expect(computeExpectedMaxLiquidatableDebt(position, prices, COLLATERAL_ASSET, DEBT_ASSET, BONUS_5PCT)).toBeNull();
  });

  it("caps at 50% of total debt when both legs are large and HF is above the close-factor threshold", () => {
    // Large position ($100k debt, $60k collateral value at threshold 80% -> HF < 1 but
    // still plausible to land above 0.95 with the right numbers), both legs well above
    // the real $2,000 MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD.
    const position = makePosition(60n * 10n ** 18n, 100_000n * 10n ** 6n);
    const prices: PriceVector = { [COLLATERAL_ASSET]: 2000n * 10n ** 8n, [DEBT_ASSET]: 1n * 10n ** 8n };
    // collateral value = $120,000, threshold 80% -> $96,000 vs $100,000 debt -> HF = 0.96 (> 0.95)
    const result = computeExpectedMaxLiquidatableDebt(position, prices, COLLATERAL_ASSET, DEBT_ASSET, BONUS_5PCT);
    // 50% of $100,000 debt = $50,000 = 50,000e6 in debt-asset units - well under the
    // collateral-availability cap ($120,000 of real collateral, easily covers $50k+5%).
    expect(result).toBe(50_000n * 10n ** 6n);
  });

  it("allows full reserve debt when the position is small, even if HF is above the close-factor threshold", () => {
    // Both legs under the real $2,000 threshold - close factor never applies regardless of
    // HF. Collateral value ($600) comfortably covers debt+bonus ($500 * 1.05 = $525), so
    // the collateral-availability cap doesn't bite either - full debt should be liquidatable.
    const position = makePosition(3n * 10n ** 17n, 500n * 10n ** 6n); // 0.3 collateral ($600), $500 debt
    const prices: PriceVector = { [COLLATERAL_ASSET]: 2000n * 10n ** 8n, [DEBT_ASSET]: 1n * 10n ** 8n };
    const result = computeExpectedMaxLiquidatableDebt(position, prices, COLLATERAL_ASSET, DEBT_ASSET, BONUS_5PCT);
    expect(result).toBe(500n * 10n ** 6n); // full debt, not close-factor-limited, not collateral-limited
  });

  it("is further capped by real collateral availability, independent of the close factor", () => {
    // A real case this session actually hit: close factor says up to 50% ($50,000) is
    // liquidatable, but the borrower's real collateral in THIS reserve can't cover that
    // much once converted through price + bonus - Aave clamps to what's actually there.
    // 1 collateral unit @ $2000, 5% bonus: max debt collateral can back = 2000 / 1.05 ≈ 1904.76
    const position = makePosition(1n * 10n ** 18n, 100_000n * 10n ** 6n);
    const prices: PriceVector = { [COLLATERAL_ASSET]: 2000n * 10n ** 8n, [DEBT_ASSET]: 1n * 10n ** 8n };
    const result = computeExpectedMaxLiquidatableDebt(position, prices, COLLATERAL_ASSET, DEBT_ASSET, BONUS_5PCT);
    // Should be MUCH less than the $50,000 close-factor cap - collateral-availability bites first.
    expect(result).not.toBeNull();
    expect(result!).toBeLessThan(50_000n * 10n ** 6n);
    // 1e18 collateral / 1.05 bonus, converted back to debt terms: ~1904.76 debt-asset units.
    expect(result!).toBeGreaterThan(1_900n * 10n ** 6n);
    expect(result!).toBeLessThan(1_910n * 10n ** 6n);
  });
});
