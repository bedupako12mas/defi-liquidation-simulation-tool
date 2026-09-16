"use client";

/**
 * Every metric and status shown anywhere in this app, with its formula, in one place -
 * promoted out of MethodologyTab into its own tab so it's easy to find on its own rather than
 * buried at the bottom of a dense methodology page. InfoTooltip's `glossaryId` prop links here
 * directly (see components/shared/InfoTooltip.tsx) - `pendingAnchor` carries which row to
 * scroll to and highlight on arrival.
 */

import { useEffect } from "react";
import { Glossary } from "@/components/shared/Glossary";
import { useNavigation } from "@/lib/hooks/useNavigation";

export function GlossaryTab() {
  const { pendingAnchor, clearPendingAnchor } = useNavigation();

  // Consumed once: Glossary's own effect reads activeAnchor to scroll/highlight on this same
  // render pass, then this clears it so switching away and back to the tab later doesn't
  // replay the scroll against a stale anchor.
  useEffect(() => {
    if (pendingAnchor) clearPendingAnchor();
  }, [pendingAnchor, clearPendingAnchor]);

  return (
    <div className="card">
      <h2>Glossary</h2>
      <p className="preset-note" style={{ marginTop: 0, marginBottom: "1rem" }}>
        Every metric and status shown anywhere in this app, in one place - grouped by where it
        appears, with the formula behind each one shown explicitly rather than left buried in
        prose. The inline (i) icons throughout the app link straight to the relevant row here.
      </p>
      <Glossary activeAnchor={pendingAnchor} />
    </div>
  );
}
