"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CloseIcon, ExternalLinkIcon, DownloadIcon } from "./icons";

// Kinds we can render inline. HEIC/webp are not inline-previewable (backend forces download for
// webp and rejects HEIC), so they get an honest download fallback (spec §16).
function kindOf(mime?: string, name?: string): "image" | "pdf" | "other" {
  const m = (mime ?? "").toLowerCase();
  const n = (name ?? "").toLowerCase();
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (m === "image/jpeg" || m === "image/png" || n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".png")) return "image";
  return "other";
}

/**
 * Full-screen document viewer. Single adaptive viewer for JPG/PNG (fit-to-width, vertical
 * flow) and PDF (native embed), with download / open-in-new-tab, close, safe-area, and
 * loading/error/retry. PDF is only embedded when opened — never preloaded.
 */
export function DocumentLink({ href, name, mime, className, children }: { href: string; name: string; mime?: string; className?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className ?? "inline-flex min-h-[44px] items-center rounded-md px-2 text-sm font-medium text-brand-700 hover:underline"}>
        {children ?? "Открыть"}
      </button>
      {open ? <Viewer href={href} name={name} mime={mime} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function Viewer({ href, name, mime, onClose }: { href: string; name: string; mime?: string; onClose: () => void }) {
  const kind = kindOf(mime, name);
  const [state, setState] = useState<"loading" | "ready" | "error">(kind === "other" ? "ready" : "loading");
  const [zoom, setZoom] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Body-scroll lock (spec §7): freeze the page under the overlay and restore the exact
  // scroll position on close. position:fixed + negative top is the iOS-Safari-safe lock —
  // plain overflow:hidden on <body> does not stop momentum scroll there. The overlay is a
  // fixed child, so its own scroll container is unaffected by the lock.
  useEffect(() => {
    const scrollY = window.scrollY;
    const body = document.body;
    const prev = { position: body.style.position, top: body.style.top, width: body.style.width, overflow: body.style.overflow };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";
    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.width = prev.width;
      body.style.overflow = prev.overflow;
      window.scrollTo(0, scrollY);
    };
  }, []);

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex h-[100dvh] flex-col bg-slate-900/95" role="dialog" aria-modal="true" aria-label={`Документ: ${name}`}>
      {/* Toolbar — sticky top of the overlay, never scrolls away; open/download/close always reachable. */}
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 pt-safe text-white">
        <span className="min-w-0 break-anywhere text-sm font-medium">{name}</span>
        <div className="flex shrink-0 items-center gap-1">
          <a href={href} target="_blank" rel="noopener noreferrer" className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-white/10" aria-label="Открыть в новой вкладке"><ExternalLinkIcon className="h-5 w-5" /></a>
          <a href={href} download={name} className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-white/10" aria-label="Скачать"><DownloadIcon className="h-5 w-5" /></a>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-white/10"><CloseIcon className="h-5 w-5" /></button>
        </div>
      </div>

      {/* Scroll body — one-finger vertical pan through the whole document. overscroll-contain
          keeps the gesture inside the viewer; touch-action pan-y + -webkit-overflow-scrolling
          make iOS treat a drag as a scroll (not an image pan), so zoom is never required to
          reach the bottom (spec §7). */}
      <div
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-safe"
        style={{ WebkitOverflowScrolling: "touch", touchAction: "pan-y" }}
      >
        {state === "loading" ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center py-8 text-sm text-white/70">Загрузка…</div>
        ) : null}

        {kind === "image" ? (
          // Vertical flow: full page width, natural height — a tall receipt scrolls; tap
          // toggles zoom but is NOT the way to navigate.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={reloadKey}
            src={href}
            alt={name}
            onLoad={() => setState("ready")}
            onError={() => setState("error")}
            onClick={() => setZoom((z) => !z)}
            className={zoom ? "mx-auto block max-w-none cursor-zoom-out" : "mx-auto block h-auto w-full max-w-3xl cursor-zoom-in"}
          />
        ) : kind === "pdf" ? (
          // Native embed via <iframe> — its own vertical scroll flows through multipage PDFs
          // (more reliable than <object> on iOS). Fills the scroll body height.
          <iframe key={reloadKey} src={href} title={name} onLoad={() => setState("ready")} className="h-full min-h-[100%] w-full border-0">
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-white/80">
              <p className="text-sm">Не удалось показать PDF во встроенном просмотре.</p>
              <a href={href} target="_blank" rel="noopener noreferrer" className="rounded-md bg-white/15 px-4 py-2 text-sm font-medium">Открыть PDF</a>
            </div>
          </iframe>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-white/80">
            <p className="text-sm">Этот формат нельзя показать в приложении.</p>
            <a href={href} download={name} className="rounded-md bg-white/15 px-4 py-2 text-sm font-medium text-white">Скачать файл</a>
          </div>
        )}

        {state === "error" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/80 p-6 text-center text-white/80">
            <p className="text-sm">Не удалось загрузить документ.</p>
            <button type="button" onClick={() => { setState("loading"); setReloadKey((k) => k + 1); }} className="rounded-md bg-white/15 px-4 py-2 text-sm font-medium">Повторить</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
