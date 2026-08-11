import { describe, it, expect } from "vitest";
import { fetchMeta } from "../meta";

describe("fetchMeta (mock mode)", () => {
  it("returns a MetaResponse with capabilities.rpc true and capabilities.fork false", async () => {
    const meta = await fetchMeta();
    expect(meta.mode).toBe("demo");
    expect(meta.capabilities).toEqual({ rpc: true, fork: false });
  });

  it("returns all three named presets", async () => {
    const meta = await fetchMeta();
    const ids = meta.presets.map((p) => p.id).sort();
    expect(ids).toEqual(["correlated", "mild-depeg", "severe-depeg"]);
  });

  it("every ucFrontier row satisfies LTV_UC = 1/(1+i) within rounding tolerance", async () => {
    const meta = await fetchMeta();
    expect(meta.ucFrontier.length).toBeGreaterThan(0);
    for (const row of meta.ucFrontier) {
      const expected = 100 / (1 + row.incentivePct / 100);
      expect(row.ucFrontierPct).toBeCloseTo(expected, 1);
    }
  });

  it("includes a limitation flagging mock mode explicitly", async () => {
    const meta = await fetchMeta();
    expect(meta.limitations.some((l) => l.includes("MOCK MODE"))).toBe(true);
  });
});
