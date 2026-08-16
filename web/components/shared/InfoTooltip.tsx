"use client";

/**
 * Small "i" trigger used everywhere a plain-language line sits next to real, precise
 * technical prose (OverviewTab's metric pills, PositionDrilldown's per-position fields,
 * MethodologyTab's dense paragraphs) - the always-visible text stays plain, the existing
 * technical explanation lives here, unchanged, opened on hover or click/tap rather than
 * deleted or rewritten. One component so the interaction is identical in all three places.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export function InfoTooltip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();

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
        </span>
      )}
    </span>
  );
}
