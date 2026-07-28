"use client";

import { useEffect, useState, type ReactNode } from "react";
import { pushStickyActions } from "./mobile-chrome";

/**
 * Sticky bottom action bar (spec §18). Mobile-only (`lg:hidden`) so desktop keeps its inline
 * buttons untouched — pages render the in-body action row as `hidden lg:flex` to avoid
 * duplication. Clears the iPhone home indicator (`pb-safe-actions`).
 *
 * Keyboard-aware: when the iOS soft keyboard opens, `visualViewport` shrinks; we lift the bar by
 * the covered height so the primary action is never hidden behind the keyboard (the exact defect
 * the WAVE-2 audit flagged on create/wizard forms). Falls back to a normal fixed bar where
 * `visualViewport` is unavailable.
 *
 * The host page must reserve space with the `.has-sticky-actions` utility so the last field is
 * never covered.
 */
export function StickyActions({ children }: { children: ReactNode }) {
  const [lift, setLift] = useState(0);

  // While a sticky action bar is mounted, suppress the mobile bottom nav (spec §16).
  useEffect(() => pushStickyActions(), []);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Height hidden by the keyboard = layout viewport bottom − visual viewport bottom.
      const covered = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      setLift(covered);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
  }, []);

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 pb-safe-actions backdrop-blur lg:hidden"
      style={lift > 0 ? { transform: `translateY(-${lift}px)`, paddingBottom: "0.75rem" } : undefined}
    >
      {children}
    </div>
  );
}
