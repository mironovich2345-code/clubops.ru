"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { pushOverlay } from "./mobile-chrome";

/**
 * Base sheet primitive (spec §19). The finance contour had NO modal/dialog/sheet component —
 * confirmations fell back to window.prompt/confirm. This is the keyboard-safe, safe-area-aware,
 * theme-aware foundation the finance flows build on.
 *
 * - variant="bottom": bottom sheet for short confirmations / filters. Caps at 90dvh so the iOS
 *   keyboard never hides content; the sticky footer stays reachable.
 * - variant="full": full-screen sheet for comment forms / long content, respecting the notch.
 *
 * `dirty` + confirm-on-close guards unsaved text in return/reject comment forms (spec §19).
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  variant = "bottom",
  dirty = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  variant?: "bottom" | "full";
  dirty?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Lock background scroll + suppress the bottom nav while open (spec §16).
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const releaseOverlay = pushOverlay();
    return () => { document.body.style.overflow = prev; releaseOverlay(); };
  }, [open]);

  const requestClose = () => {
    if (dirty && !window.confirm("Закрыть без сохранения? Введённый текст будет потерян.")) return;
    onClose();
  };

  // Esc to close; focus the panel on open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dirty]);

  if (!open) return null;

  const isFull = variant === "full";
  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <button type="button" aria-label="Закрыть" onClick={requestClose} className="absolute inset-0 bg-slate-900/50" />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={
          isFull
            ? "relative z-10 flex h-full w-full flex-col bg-white pt-safe outline-none"
            : "relative z-10 mt-auto flex max-h-[90dvh] w-full flex-col rounded-t-2xl bg-white outline-none"
        }
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0 break-anywhere text-sm font-semibold text-slate-900">{title}</div>
          <button type="button" aria-label="Закрыть" onClick={requestClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer ? <div className="border-t border-slate-200 px-4 py-3 pb-safe-actions">{footer}</div> : null}
      </div>
    </div>
  );
}
