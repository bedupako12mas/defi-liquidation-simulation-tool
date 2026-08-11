import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { CapabilitiesProvider, useCapabilities } from "../useCapabilities";

describe("useCapabilities", () => {
  it("starts loading, then resolves capabilities from /api/meta (mock mode)", async () => {
    const { result } = renderHook(() => useCapabilities(), {
      wrapper: ({ children }) => <CapabilitiesProvider>{children}</CapabilitiesProvider>,
    });

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.capabilities).toEqual({ rpc: true, fork: false });
    expect(result.current.meta).not.toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("outside a provider, returns the default (loading, no capabilities) rather than throwing", () => {
    const { result } = renderHook(() => useCapabilities());
    expect(result.current.capabilities).toBeNull();
    expect(result.current.loading).toBe(true);
  });
});
