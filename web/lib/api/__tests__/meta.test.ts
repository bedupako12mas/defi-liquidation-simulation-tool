import { describe, it, expect } from "vitest";
import { fetchMeta } from "../meta";

describe("fetchMeta (mock mode)", () => {
  it("returns a MetaResponse with capabilities.rpc and capabilities.fork both true - the mainnet-fork tier (#37/#38) is real now, not a stub", async () => {
    const meta = await fetchMeta();
    expect(meta.mode).toBe("demo");
    expect(meta.capabilities).toEqual({ rpc: true, fork: true });
  });

  it("returns all five named presets", async () => {
    const meta = await fetchMeta();
    const ids = meta.presets.map((p) => p.id).sort();
    expect(ids).toEqual([
      "correlated",
      "lst-slashing-hypothetical",
      "mild-depeg",
      "severe-depeg",
      "stablecoin-depeg",
    ]);
  });

  it("flags the hypothetical preset as hypothetical, and only that one", async () => {
    const meta = await fetchMeta();
    const hypothetical = meta.presets.filter((p) => p.isHypothetical).map((p) => p.id);
    expect(hypothetical).toEqual(["lst-slashing-hypothetical"]);
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
