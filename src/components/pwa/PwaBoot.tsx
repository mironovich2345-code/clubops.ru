"use client";

import { useEffect, useState } from "react";

/**
 * Registers the service worker (PRODUCTION only — dev works without it, spec §28.44) and
 * drives a CONTROLLED update flow: when a new SW is installed and waiting, show a small
 * "Доступно обновление" banner; the reload happens only when the user taps «Обновить», never
 * mid-form (spec §13). No sensitive data, no caching decisions here — that's in sw.js.
 */
export function PwaBoot() {
  const [updateReady, setUpdateReady] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (process.env.NODE_ENV !== "production") return; // dev: no SW (§28.44)
    if (!("serviceWorker" in navigator)) return;

    let reloaded = false;
    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        // Already waiting from a previous visit.
        if (reg.waiting && navigator.serviceWorker.controller) {
          setWaitingWorker(reg.waiting);
          setUpdateReady(true);
        }
        reg.addEventListener("updatefound", () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener("statechange", () => {
            if (sw.state === "installed" && navigator.serviceWorker.controller) {
              setWaitingWorker(sw);
              setUpdateReady(true);
            }
          });
        });
      })
      .catch(() => {
        /* registration failure must never break the app */
      });

    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, []);

  if (!updateReady) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 pb-safe" role="status" aria-live="polite">
      <div className="mx-auto mb-2 flex max-w-md items-center justify-between gap-3 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-lg">
        <span>Доступно обновление CLUB-OPS.</span>
        <button
          type="button"
          onClick={() => { waitingWorker?.postMessage({ type: "SKIP_WAITING" }); }}
          className="min-h-[36px] shrink-0 rounded-md bg-brand-600 px-3 font-medium text-white hover:bg-brand-700"
        >
          Обновить
        </button>
      </div>
    </div>
  );
}
