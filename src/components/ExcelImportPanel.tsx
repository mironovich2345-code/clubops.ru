"use client";

import { useFormState, useFormStatus } from "react-dom";
import type { ImportActionState } from "@/lib/excel-import";

const initial: ImportActionState = { ok: false };

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Загрузка..." : label}
    </button>
  );
}

/**
 * Reusable template-download + Excel-upload panel. The server import action is
 * passed in by the page; it returns an {ok, error?, result?} ImportActionState.
 * Shows created/updated/skipped/errors and a per-row errors table.
 */
export function ExcelImportPanel({
  title,
  description,
  templateHref,
  templateLabel,
  uploadLabel,
  action,
}: {
  title: string;
  description?: string;
  templateHref: string;
  templateLabel: string;
  uploadLabel: string;
  action: (prev: ImportActionState | undefined, formData: FormData) => Promise<ImportActionState>;
}) {
  const [state, formAction] = useFormState(action, initial);
  const r = state.result;
  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-sm font-semibold text-slate-700">{title}</div>
      {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <a
          href={templateHref}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
        >
          {templateLabel}
        </a>
        <form action={formAction} className="flex flex-wrap items-end gap-3">
          <input
            type="file"
            name="file"
            accept=".xlsx,.xls,.csv"
            required
            className="block text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
          />
          <SubmitButton label={uploadLabel} />
        </form>
      </div>

      {state.error ? <p className="mt-3 text-sm text-rose-600">{state.error}</p> : null}

      {r ? (
        <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm ring-1 ring-inset ring-slate-200">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-700">
            <span>Обработано строк: <b>{r.processed}</b></span>
            <span className="text-emerald-700">Создано: <b>{r.created}</b></span>
            {r.updated > 0 ? <span className="text-sky-700">Обновлено: <b>{r.updated}</b></span> : null}
            <span className="text-slate-500">Пропущено: <b>{r.skipped}</b></span>
            <span className={r.errors.length > 0 ? "text-rose-700" : "text-slate-500"}>Ошибок: <b>{r.errors.length}</b></span>
          </div>
          {r.errors.length > 0 ? (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-left">
                <thead>
                  <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <th className="py-1 pr-3">Строка</th>
                    <th className="py-1 pr-3">Клуб</th>
                    <th className="py-1 pr-3">Поле</th>
                    <th className="py-1">Проблема</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {r.errors.map((e, i) => (
                    <tr key={i} className="text-slate-700">
                      <td className="py-1 pr-3 align-top">{e.row}</td>
                      <td className="py-1 pr-3 align-top">{e.club}</td>
                      <td className="py-1 pr-3 align-top text-slate-500">{e.field ?? "—"}</td>
                      <td className="py-1 align-top text-rose-700">{e.issue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
