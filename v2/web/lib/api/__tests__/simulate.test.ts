import { describe, it, expect } from "vitest";
import { openSimulationStream, fetchPositionSnapshot, type SweepPoint, type Protocol } from "../simulate";

function collectStream(presetId: "correlated" | "mild-depeg" | "severe-depeg") {
  return new Promise<{ aave: SweepPoint[]; fluid: SweepPoint[]; done: boolean; latencies: (number | null)[] }>(
    (resolve, reject) => {
      const aave: SweepPoint[] = [];
      const fluid: SweepPoint[] = [];
      const latencies: (number | null)[] = [];
      let lastArrival: number | null = null;

      const handle = openSimulationStream(presetId, {
        onPoint: (protocol: Protocol, point: SweepPoint, arrivedAt: number) => {
          latencies.push(lastArrival === null ? null : arrivedAt - lastArrival);
          lastArrival = arrivedAt;
          if (protocol === "aave") aave.push(point);
          else fluid.push(point);
        },
        onDone: () => {
          resolve({ aave, fluid, done: true, latencies });
        },
        onError: (message) => reject(new Error(message)),
      });

      // Safety timeout so a broken mock stream fails the test instead of hanging forever.
      setTimeout(() => {
        handle.close();
        reject(new Error("simulation stream did not complete within 5s"));
      }, 5000);
    }
  );
}

describe("openSimulationStream (mock mode)", () => {
  it("streams a full sweep for both protocols and calls onDone exactly once", async () => {
    const result = await collectStream("correlated");
    expect(result.aave.length).toBe(81); // 0% to -80% at 1% steps, per the fixture's sweep grid
    expect(result.fluid.length).toBe(81);
    expect(result.done).toBe(true);
  });

  it("delivers points in increasing shock-magnitude order (0% down to -80%)", async () => {
    const result = await collectStream("severe-depeg");
    const magnitudes = result.aave.map((p) => p.magnitudePct);
    const sorted = [...magnitudes].sort((a, b) => b - a); // 0, -1, -2, ... descending
    expect(magnitudes).toEqual(sorted);
    expect(magnitudes[0]).toBe(0);
    expect(magnitudes.at(-1)).toBe(-80);
  });

  it("reports real (non-fabricated) per-chunk latency - non-negative integers, not a constant", async () => {
    const result = await collectStream("mild-depeg");
    const measured = result.latencies.filter((l): l is number => l !== null);
    expect(measured.length).toBeGreaterThan(10);
    for (const l of measured) {
      expect(l).toBeGreaterThanOrEqual(0);
    }
    // If every latency were identical, that would be a strong sign of a fabricated constant
    // rather than a real setTimeout-driven delay.
    const distinctValues = new Set(measured);
    expect(distinctValues.size).toBeGreaterThan(1);
  });

  it("liquidatableCollateralUsd is monotonically non-decreasing as the shock deepens (base-price valuation)", async () => {
    const result = await collectStream("correlated");
    for (let i = 1; i < result.aave.length; i++) {
      expect(result.aave[i].liquidatableCollateralUsd).toBeGreaterThanOrEqual(result.aave[i - 1].liquidatableCollateralUsd);
    }
  });

  it("close() stops further point delivery", async () => {
    let pointCount = 0;
    const handle = openSimulationStream("correlated", {
      onPoint: () => {
        pointCount++;
      },
      onDone: () => {},
      onError: () => {},
    });
    handle.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(pointCount).toBe(0);
  });
});

describe("fetchPositionSnapshot (mock mode)", () => {
  it("returns per-position rows classified into exactly the three documented states", async () => {
    const rows = await fetchPositionSnapshot("severe-depeg", -60, "aave");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(["healthy", "liquidatable", "toxic"]).toContain(row.state);
    }
  });

  it("a position with healthFactor < 1 is never classified 'healthy'", async () => {
    const rows = await fetchPositionSnapshot("severe-depeg", -70, "fluid");
    for (const row of rows) {
      if (row.healthFactor !== null && row.healthFactor < 1) {
        expect(row.state).not.toBe("healthy");
      }
    }
  });

  it("snaps an off-grid magnitude to the nearest available snapshot instead of returning nothing", async () => {
    const rows = await fetchPositionSnapshot("correlated", -23, "aave");
    expect(rows.length).toBeGreaterThan(0);
  });
});
