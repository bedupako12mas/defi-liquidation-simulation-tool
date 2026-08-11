"use client";

/**
 * FRONTEND_STRATEGY.md's capability-driven rendering mechanism, client side: fetch
 * `/api/meta` exactly once at app load, publish it via context, and let every tab/component
 * read `capabilities.fork` (and the rest of `meta`) from here instead of re-fetching or
 * hardcoding "Milestone 2 isn't built yet". The day `capabilities.fork` flips true
 * server-side, this hook's next fetch (a fresh page load) is the only thing that needs to
 * happen - no component changes.
 *
 * Also carries the full `MetaResponse`, not just `capabilities` - `OverviewTab` needs
 * `presets`, `MethodologyTab` needs `ucFrontier`/`limitations`, and fetching meta twice (once
 * here, once per-tab) would be wasteful for data that's identical either way. The hook is
 * still named/exported the way FRONTEND_STRATEGY.md's folder listing names it
 * (`useCapabilities.ts`); `capabilities` is the field every consumer is expected to actually
 * branch on.
 */

import { createContext, useContext, useEffect, useState, type ReactNode, createElement } from "react";
import { fetchMeta, type MetaResponse, type Capabilities } from "@/lib/api/meta";

export interface CapabilitiesState {
  meta: MetaResponse | null;
  capabilities: Capabilities | null;
  loading: boolean;
  error: string | null;
}

const CapabilitiesContext = createContext<CapabilitiesState>({
  meta: null,
  capabilities: null,
  loading: true,
  error: null,
});

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CapabilitiesState>({
    meta: null,
    capabilities: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetchMeta()
      .then((meta) => {
        if (!cancelled) setState({ meta, capabilities: meta.capabilities, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ meta: null, capabilities: null, loading: false, error: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return createElement(CapabilitiesContext.Provider, { value: state }, children);
}

export function useCapabilities(): CapabilitiesState {
  return useContext(CapabilitiesContext);
}
