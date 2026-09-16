import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { NavigationProvider, useNavigation } from "../useNavigation";

describe("useNavigation", () => {
  it("starts on the overview tab with no pending anchor, and goTo switches both", () => {
    const { result } = renderHook(() => useNavigation(), {
      wrapper: ({ children }) => <NavigationProvider>{children}</NavigationProvider>,
    });

    expect(result.current.active).toBe("overview");
    expect(result.current.pendingAnchor).toBeNull();

    act(() => result.current.goTo("glossary", "hf"));
    expect(result.current.active).toBe("glossary");
    expect(result.current.pendingAnchor).toBe("hf");

    act(() => result.current.clearPendingAnchor());
    expect(result.current.pendingAnchor).toBeNull();
    expect(result.current.active).toBe("glossary");
  });

  it("goTo with no anchor clears any previously pending one", () => {
    const { result } = renderHook(() => useNavigation(), {
      wrapper: ({ children }) => <NavigationProvider>{children}</NavigationProvider>,
    });

    act(() => result.current.goTo("glossary", "hf"));
    expect(result.current.pendingAnchor).toBe("hf");

    act(() => result.current.goTo("validation"));
    expect(result.current.active).toBe("validation");
    expect(result.current.pendingAnchor).toBeNull();
  });

  it("outside a provider, returns a local default (overview, no-op goTo) rather than throwing", () => {
    const { result } = renderHook(() => useNavigation());
    expect(result.current.active).toBe("overview");
    expect(() => result.current.goTo("glossary")).not.toThrow();
  });
});
