"use client";

/**
 * Small "i" trigger used everywhere a plain-language line sits next to real, precise
 * technical prose (OverviewTab's metric pills, PositionDrilldown's per-position fields,
 * MethodologyTab's dense paragraphs) - the always-visible text stays plain, the existing
 * technical explanation lives here, unchanged, opened on hover or click/tap rather than
 * deleted or rewritten. One component so the interaction is identical in all three places.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useNavigation } from "@/lib/hooks/useNavigation";

export function InfoTooltip({
  label,
  glossaryId,
  children,
}: {
  label: string;
  /** When set, the popover gets a "Full definition & formula" link that jumps straight to
   *  that row in the Glossary tab (web/components/shared/Glossary.tsx's entry `id`s) - the
   *  short blurb here stays the quick, in-place explanation; the glossary is the full one. */
  glossaryId?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();
  const { goTo } = useNavigation();

  // Hover opens it for pointer users; click/tap toggles it for keyboard and touch, which
  // also has to win over hover so it stays open on touch devices (no real hover there).
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <span
      className="info-tooltip"
      ref={wrapperRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="info-tooltip-trigger"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        i
      </button>
      {open && (
        <span role="note" id={popoverId} className="info-tooltip-popover">
          {children}
          {glossaryId && (
            <>
              <br />
              <br />
              <button
                type="button"
                className="info-tooltip-glossary-link"
                onClick={() => {
                  setOpen(false);
                  goTo("glossary", glossaryId);
                }}
              >
                Full definition &amp; formula →
              </button>
            </>
          )}
        </span>
      )}
    </span>
  );
}
