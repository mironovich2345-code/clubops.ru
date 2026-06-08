"use client";

import { useFormState, useFormStatus } from "react-dom";
import { importSalesPlans, type ImportState } from "../plan-import-actions";

const initial: ImportState = { ok: false };

type PlanRow = { clubName: string; month: string; total: string; subscriptions: string; personal: string };

function UploadButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Загрузка..." : "Загрузить планы из Excel"}
    </button>
  );
}

/** General-director-only: download the plan template, upload a filled file, and
 * review the current per-club plans (общий / абонементы / персональные). */
export function SalesPlanImport({ rows }: { rows: PlanRow[] }) {
  const [state, action] = useFormState(importSalesPlans, initial);
  const r = state.result;
  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <div className="mb-3 text-sm font-semibold text-slate-700">Планы продаж по клубам</div>

      <div className="flex flex-wrap items-end gap-3">
        <a
          href="/api/sales-plans/template"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
        >
          Скачать шаблон планов
        </a>
        <form action={action} className="flex flex-wrap items-end gap-3">
          <input
            type="file"
            name="file"
            accept=".xlsx,.xls,.csv"
            required
            className="block text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
          />
          <UploadButton />
        </form>
      </div>

      {state.error ? <p className="mt-3 text-sm text-rose-600">{state.error}</p> : null}

      {r ? (
        <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm ring-1 ring-inset ring-slate-200">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-700">
            <span>Обработано строк: <b>{r.processed}</b></span>
            <span className="text-emerald-700">Создано: <b>{r.created}</b></span>
            <span className="text-sky-700">Обновлено: <b>{r.updated}</b></span>
            <span className="text-slate-500">Пропущено ячеек: <b>{r.skipped}</b></span>
            <span className={r.errors.length > 0 ? "text-rose-700" : "text-slate-500"}>Ошибок: <b>{r.errors.length}</b></span>
          </div>
          {r.errors.length > 0 ? (
            <table className="mt-3 min-w-full divide-y divide-slate-200 text-left">
              <thead>
                <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th className="py-1 pr-3">Строка</th>
                  <th className="py-1 pr-3">Клуб</th>
                  <th className="py-1">Проблема</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {r.errors.map((e, i) => (
                  <tr key={i} className="text-slate-700">
                    <td className="py-1 pr-3 align-top">{e.row}</td>
                    <td className="py-1 pr-3 align-top">{e.club}</td>
                    <td className="py-1 align-top text-rose-700">{e.issue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3 text-left">Клуб</th>
                <th className="py-2 pr-3 text-left">Месяц</th>
                <th className="py-2 pr-3 text-right">Общий</th>
                <th className="py-2 pr-3 text-right">Абонементы</th>
                <th className="py-2 text-right">Персональные</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, i) => (
                <tr key={i} className="text-sm text-slate-700">
                  <td className="py-2 pr-3 font-medium text-slate-900">{row.clubName}</td>
                  <td className="py-2 pr-3 text-slate-500">{row.month}</td>
                  <td className="py-2 pr-3 text-right">{row.total}</td>
                  <td className="py-2 pr-3 text-right">{row.subscriptions}</td>
                  <td className="py-2 text-right">{row.personal}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">Планы по клубам ещё не заданы. Скачайте шаблон и загрузите заполненный файл.</p>
      )}
    </div>
  );
}
