"use client";

import { useEffect } from "react";
import { recoverFromChunkError } from "@/lib/chunk-error";

// Error boundary for the authenticated app subtree (dashboard, expenses,
// invoices, ...). Auto-recovers from stale-chunk-after-deploy errors with a
// single reload; otherwise shows a friendly retry instead of the bare
// "Application error" screen.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Returns true (and reloads) when this is a stale-chunk error.
    if (recoverFromChunkError(error)) return;
    // Otherwise surface for diagnostics.
    console.error("App error boundary:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="text-base font-semibold text-slate-900">Что-то пошло не так</div>
        <p className="mt-2 text-sm text-slate-500">
          Не удалось отобразить страницу. Обычно это происходит после обновления приложения —
          перезагрузка страницы решает проблему.
        </p>
        <div className="mt-5 flex justify-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
          >
            Обновить страницу
          </button>
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Повторить
          </button>
        </div>
      </div>
    </div>
  );
}
