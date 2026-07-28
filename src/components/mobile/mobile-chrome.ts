"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// Decoupled cross-tree signal so the mobile bottom nav can hide itself whenever a
// StickyActions bar is mounted or an overlay (Sheet / drawer) is open — without any
// page writing its own scroll/visibility logic (spec §5/§16). Module-level counters
// with a tiny external store; components push a token on mount/open and pop on cleanup.
let stickyCount = 0;
let overlayCount = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Register a mounted StickyActions bar (returns a cleanup that unregisters). */
export function pushStickyActions(): () => void {
  stickyCount++; emit();
  return () => { stickyCount = Math.max(0, stickyCount - 1); emit(); };
}
/** Register an open overlay (Sheet / drawer). */
export function pushOverlay(): () => void {
  overlayCount++; emit();
  return () => { overlayCount = Math.max(0, overlayCount - 1); emit(); };
}

/** True when the bottom nav must be suppressed (a sticky bar or overlay is active). */
export function useChromeSuppressed(): boolean {
  return useSyncExternalStore(subscribe, () => stickyCount > 0 || overlayCount > 0, () => false);
}

/**
 * Hide-on-scroll-down / show-on-scroll-up with hysteresis (spec §5/§16). Accumulates
 * signed scroll delta and only flips past `threshold`, so micro-scroll and iOS bounce
 * don't cause jitter or layout shift (the caller translates a fixed bar, never remounts).
 * Never hides while a form control is focused (keyboard open) and always shows at the top.
 */
export function useHideOnScrollDown(threshold = 14): boolean {
  const [hidden, setHidden] = useState(false);
  const acc = useRef(0);
  const lastY = useRef(0);

  useEffect(() => {
    lastY.current = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      // At/above the top → always visible; reset accumulator.
      if (y <= 4) { acc.current = 0; lastY.current = y; setHidden(false); return; }
      // Don't react to the layout jump when the soft keyboard opens.
      const ae = document.activeElement;
      if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) { lastY.current = y; return; }
      const dy = y - lastY.current;
      lastY.current = y;
      if (Math.abs(dy) < 2) return; // ignore micro-scroll / bounce noise
      // Accumulate in the current direction; reset when direction flips.
      acc.current = Math.sign(dy) === Math.sign(acc.current) ? acc.current + dy : dy;
      if (acc.current > threshold) { setHidden(true); acc.current = 0; }
      else if (acc.current < -threshold) { setHidden(false); acc.current = 0; }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);

  return hidden;
}
