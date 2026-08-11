"use client";

/**
 * Owns one streaming simulation run (lib/api/simulate.ts's openSimulationStream). Re-opens
 * the stream whenever `presetId` changes, tearing down the previous one first - never two
 * concurrent streams racing to update the same state. Appends chunks to `aave`/`fluid`
 * arrays as they arrive (FRONTEND_STRATEGY.md: "StreamedChart re-renders on each chunk"), and
 * tracks the real inter-arrival latency of each chunk for display - not fabricated, an actual
 * `Date.now()` delta between consecutive `onPoint` calls, in both mock and live mode.
 *
 * IMPLEMENTATION NOTE on why state is keyed by `presetId` instead of reset synchronously in
 * the effect: eslint-plugin-react-hooks (react-hooks/set-state-in-effect) flags calling
 * setState directly in an effect body as opposed to inside an async/subscription callback,
 * since that causes an extra synchronous render-then-render-again cascade. Instead, internal
 * state carries the presetId it belongs to, every setState call happens inside
 * openSimulationStream's callbacks (genuinely async), and the value returned to callers is
 * *derived* at render time - falling back to an empty "streaming" shape whenever the
 * internal state's presetId hasn't caught up to the latest requested one yet (i.e. exactly
 * the render right after a preset change, before the new stream's first chunk arrives).
 */

import { useEffect, useRef, useState } from "react";
import { openSimulationStream, type Protocol, type SweepPoint } from "@/lib/api/simulate";
import type { ShockPreset } from "@/lib/api/meta";

export type StreamStatus = "idle" | "streaming" | "done" | "error";

export interface SimulationStreamState {
  aave: SweepPoint[];
  fluid: SweepPoint[];
  status: StreamStatus;
  error: string | null;
  preset: ShockPreset | null;
  lastChunkLatencyMs: number | null;
  pointsReceived: number;
}

interface InternalState extends SimulationStreamState {
  presetId: ShockPreset["id"];
}

function emptyState(presetId: ShockPreset["id"], status: StreamStatus): InternalState {
  return {
    presetId,
    aave: [],
    fluid: [],
    status,
    error: null,
    preset: null,
    lastChunkLatencyMs: null,
    pointsReceived: 0,
  };
}

export function useSimulationStream(presetId: ShockPreset["id"] | null): SimulationStreamState {
  const [state, setState] = useState<InternalState | null>(null);
  const lastArrivalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!presetId) return;

    lastArrivalRef.current = null;

    const handle = openSimulationStream(presetId, {
      onPoint: (protocol: Protocol, point: SweepPoint, arrivedAt: number) => {
        const latency = lastArrivalRef.current === null ? null : arrivedAt - lastArrivalRef.current;
        lastArrivalRef.current = arrivedAt;
        setState((prev) => {
          const base = prev && prev.presetId === presetId ? prev : emptyState(presetId, "streaming");
          return {
            ...base,
            status: "streaming",
            aave: protocol === "aave" ? [...base.aave, point] : base.aave,
            fluid: protocol === "fluid" ? [...base.fluid, point] : base.fluid,
            lastChunkLatencyMs: latency,
            pointsReceived: base.pointsReceived + 1,
          };
        });
      },
      onDone: (preset: ShockPreset) => {
        setState((prev) => {
          const base = prev && prev.presetId === presetId ? prev : emptyState(presetId, "streaming");
          return { ...base, status: "done", preset };
        });
      },
      onError: (message: string) => {
        setState((prev) => {
          const base = prev && prev.presetId === presetId ? prev : emptyState(presetId, "idle");
          return { ...base, status: "error", error: message };
        });
      },
    });

    return () => handle.close();
  }, [presetId]);

  if (!presetId) {
    return { aave: [], fluid: [], status: "idle", error: null, preset: null, lastChunkLatencyMs: null, pointsReceived: 0 };
  }
  if (state && state.presetId === presetId) return state;
  // New preset requested, first chunk hasn't arrived (or is being dispatched) yet.
  return emptyState(presetId, "streaming");
}
