import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSimulationStream } from "../useSimulationStream";
import type { ShockPreset } from "@/lib/api/meta";

describe("useSimulationStream", () => {
  it("returns idle/empty state when presetId is null", () => {
    const { result } = renderHook(() => useSimulationStream(null));
    expect(result.current.status).toBe("idle");
    expect(result.current.aave).toEqual([]);
    expect(result.current.fluid).toEqual([]);
  });

  it("streams to completion and accumulates points for both protocols", async () => {
    const { result } = renderHook(() => useSimulationStream("correlated"));

    await waitFor(() => expect(result.current.status).toBe("done"), { timeout: 5000 });

    expect(result.current.aave.length).toBe(81);
    expect(result.current.fluid.length).toBe(81);
    expect(result.current.preset?.id).toBe("correlated");
    expect(result.current.pointsReceived).toBe(162); // 81 aave + 81 fluid onPoint calls
  });

  it("switching presetId resets accumulated points instead of appending across scenarios", async () => {
    const { result, rerender } = renderHook(
      ({ presetId }: { presetId: ShockPreset["id"] }) => useSimulationStream(presetId),
      { initialProps: { presetId: "correlated" } }
    );

    await waitFor(() => expect(result.current.status).toBe("done"), { timeout: 5000 });
    const firstRunLength = result.current.aave.length;
    expect(firstRunLength).toBeGreaterThan(0);

    rerender({ presetId: "severe-depeg" });

    // Immediately after the switch (before the new stream's first chunk), state must not
    // still show the old preset's accumulated points.
    expect(result.current.aave.length).toBeLessThanOrEqual(firstRunLength);

    await waitFor(() => expect(result.current.status).toBe("done"), { timeout: 5000 });
    expect(result.current.preset?.id).toBe("severe-depeg");
    expect(result.current.aave.length).toBe(81);
  });
});
