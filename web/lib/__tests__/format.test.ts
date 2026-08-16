import { describe, it, expect } from "vitest";
import { formatUsd8, formatTokenAmount, formatGas, formatMagnitudePct, formatPct } from "../format";

describe("formatUsd8", () => {
  it("formats a real 8-decimal USD value with $ and thousands separators", () => {
    expect(formatUsd8("300691278373")).toBe("$3,006.91");
  });
  it("uses more decimals for sub-$1 values, so small real gas costs aren't rounded to $0.00", () => {
    expect(formatUsd8("3731000")).toBe("$0.0373");
  });
  it("signs negative values correctly (a real unprofitable case)", () => {
    expect(formatUsd8("-2407811")).toBe("-$0.0241");
  });
  it("is null-safe", () => {
    expect(formatUsd8(null)).toBe("—");
    expect(formatUsd8(undefined)).toBe("—");
  });
});

describe("formatTokenAmount", () => {
  it("decimal-adjusts and labels with the real symbol", () => {
    expect(formatTokenAmount("17240587377", 6, "USDC")).toBe("17,240.59 USDC");
  });
  it("handles 18-decimal tokens", () => {
    expect(formatTokenAmount("1000000000000000000", 18, "WETH")).toBe("1.00 WETH");
  });
  it("falls back to raw units rather than guess a decimals value", () => {
    expect(formatTokenAmount("123456", null, "USDC")).toBe("123,456 raw units");
  });
  it("falls back to a generic 'tokens' label for an unresolved symbol", () => {
    expect(formatTokenAmount("1000000", 6, "UNKNOWN")).toBe("1.00 tokens");
  });
  it("is null-safe", () => {
    expect(formatTokenAmount(null, 18, "WETH")).toBe("—");
  });
});

describe("formatGas", () => {
  it("formats raw gas units with thousands separators and a unit label", () => {
    expect(formatGas("539463")).toBe("539,463 gas");
  });
  it("is null-safe", () => {
    expect(formatGas(null)).toBe("—");
  });
});

describe("formatMagnitudePct", () => {
  it("shows a signed magnitude with a trailing %", () => {
    expect(formatMagnitudePct("-30.00")).toBe("-30.00%");
    expect(formatMagnitudePct(-65)).toBe("-65.00%");
  });
});

describe("formatPct", () => {
  it("uses more decimals for a genuinely tiny real value, not rounding it to 0%", () => {
    expect(formatPct("0.000001")).toBe("0.000001%");
  });
  it("uses 2 decimals for an ordinary-sized percentage", () => {
    expect(formatPct("-100.000000")).toBe("-100.00%");
  });
  it("is null-safe", () => {
    expect(formatPct(null)).toBe("—");
    expect(formatPct(undefined)).toBe("—");
  });
  it("shows exactly 0% for a real zero result", () => {
    expect(formatPct(0)).toBe("0%");
  });
});
