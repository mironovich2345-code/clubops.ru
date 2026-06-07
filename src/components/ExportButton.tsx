"use client";

import { useState } from "react";

const PERIODS = [
  { key: "current_month", label: "Текущий месяц" },
  { key: "previous_month", label: "Прошлый месяц" },
  { key: "custom", label: "Произвольный период" },
];

/** Downloads scoped CSV from /api/export/<type>; the server enforces scope+role. */
export function ExportButton({ type, label = "Экспорт CSV" }: { type: string; label?: string }) {
  const [period, setPeriod] = useState("current_month");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const params = new URLSearchParams({ period });
  if (period === "custom") {
    if (from) params.set("from", from);
    if (to) params.set("to", to);
  }
  const href = `/api/export/${type}?${params.toString()}`;

  return (
    <details className="group relative inline-block">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
        {label}
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-64 rounded-md border border-slate-200 bg-white p-3 shadow-lg">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Период</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} className="input w-full">
            {PERIODS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        </label>
        {period === "custom" ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">С</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input w-full" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">По</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input w-full" />
            </label>
          </div>
        ) : null}
        <a
          href={href}
          className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          Скачать CSV
        </a>
      </div>
    </details>
  );
}
