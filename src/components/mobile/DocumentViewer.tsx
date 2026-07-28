"use client";

import { useState, type ReactNode } from "react";

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
 * Full-screen document viewer (spec §16). Single adaptive viewer for JPG/PNG (fit-to-width +
 * tap-to-zoom) and PDF (native embed), with download / open-in-new-tab, close, safe-area, and
 * loading/error/retry. No horizontal page overflow (it's a fixed overlay). PDF is only embedded
 * when opened — never preloaded.
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

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/95" role="dialog" aria-modal="true" aria-label={`Документ: ${name}`}>
      <div className="flex items-center justify-between gap-2 px-3 py-2 pt-safe text-white">
        <span className="min-w-0 break-anywhere text-sm font-medium">{name}</span>
        <div className="flex shrink-0 items-center gap-1">
          <a href={href} target="_blank" rel="noopener noreferrer" className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-white/10" aria-label="Открыть в новой вкладке">↗</a>
          <a href={href} download={name} className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-white/10" aria-label="Скачать">⤓</a>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-white/10">✕</button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto pb-safe">
        {state === "loading" ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">Загрузка…</div>
        ) : null}

        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={reloadKey}
            src={href}
            alt={name}
            onLoad={() => setState("ready")}
            onError={() => setState("error")}
            onClick={() => setZoom((z) => !z)}
            className={zoom ? "mx-auto max-w-none cursor-zoom-out" : "mx-auto w-full max-w-3xl cursor-zoom-in"}
          />
        ) : kind === "pdf" ? (
          <object key={reloadKey} data={href} type="application/pdf" onLoad={() => setState("ready")} className="h-full w-full">
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-white/80">
              <p className="text-sm">Не удалось показать PDF во встроенном просмотре.</p>
              <a href={href} target="_blank" rel="noopener noreferrer" className="rounded-md bg-white/15 px-4 py-2 text-sm font-medium">Открыть PDF</a>
            </div>
          </object>
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
