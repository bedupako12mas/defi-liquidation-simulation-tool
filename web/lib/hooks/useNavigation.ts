"use client";

/**
 * Which tab is active, lifted out of AppShell's local useState (page.tsx) so any component -
 * not just the tab nav - can switch tabs. Exists specifically so an InfoTooltip's "Full
 * definition" link (glossaryId prop) can jump straight to a Glossary row from anywhere in the
 * app, not just from the Glossary tab itself. Same createContext + Provider + accessor-hook
 * shape as useCapabilities.ts, not a new pattern.
 */

import { createContext, useContext, useState, type ReactNode, createElement } from "react";

export type TabId =
  | "overview"
  | "glossary"
  | "methodology"
  | "cascade"
  | "validation"
  | "smart-vaults"
  | "smart-debt-vaults"
  | "fully-smart-vaults";

export interface NavigationState {
  active: TabId;
  /** anchor is consumed once by whichever tab reads pendingAnchor, then cleared - it's a
   *  one-shot "scroll to this on arrival" signal, not persistent tab state. */
  pendingAnchor: string | null;
  goTo(tab: TabId, anchor?: string): void;
  clearPendingAnchor(): void;
}

const NavigationContext = createContext<NavigationState | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<TabId>("overview");
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);

  const value: NavigationState = {
    active,
    pendingAnchor,
    goTo(tab, anchor) {
      setActive(tab);
      setPendingAnchor(anchor ?? null);
    },
    clearPendingAnchor() {
      setPendingAnchor(null);
    },
  };

  return createElement(NavigationContext.Provider, { value }, children);
}

/** Outside a provider, falls back to local-only navigation (active always "overview", goTo a
 *  no-op) rather than throwing - mirrors useCapabilities' outside-provider default so a
 *  component using this hook in isolation (e.g. a unit test) doesn't need to wrap every
 *  render in NavigationProvider unless it actually asserts navigation behavior. */
export function useNavigation(): NavigationState {
  const ctx = useContext(NavigationContext);
  if (ctx) return ctx;
  return {
    active: "overview",
    pendingAnchor: null,
    goTo() {},
    clearPendingAnchor() {},
  };
}
