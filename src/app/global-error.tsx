"use client";

import { useEffect } from "react";
import { recoverFromChunkError } from "@/lib/chunk-error";

// Top-level boundary: catches errors that escape segment boundaries (including
// the root layout). Must render its own <html>/<body>. Like the app boundary,
// it auto-reloads once on a stale-chunk-after-deploy error.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (recoverFromChunkError(error)) return;
    console.error("Global error boundary:", error);
  }, [error]);

  return (
    <html lang="ru">
      <body
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          margin: 0,
          background: "#f8fafc",
        }}
      >
        <div
          style={{
            maxWidth: 420,
            width: "100%",
            margin: 24,
            padding: 24,
            borderRadius: 8,
            border: "1px solid #e2e8f0",
            background: "#fff",
            textAlign: "center",
          }}
        >
          <div style={{ fontWeight: 600, color: "#0f172a" }}>Что-то пошло не так</div>
          <p style={{ marginTop: 8, fontSize: 14, color: "#64748b" }}>
            Не удалось загрузить приложение. Обычно это происходит после обновления — перезагрузка
            страницы решает проблему.
          </p>
          <div style={{ marginTop: 20, display: "flex", justifyContent: "center", gap: 12 }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                borderRadius: 6,
                background: "#4f46e5",
                color: "#fff",
                border: "none",
                padding: "8px 16px",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Обновить страницу
            </button>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                borderRadius: 6,
                background: "#fff",
                color: "#334155",
                border: "1px solid #cbd5e1",
                padding: "8px 16px",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Повторить
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
