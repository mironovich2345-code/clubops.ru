"use client";

import { useFormState, useFormStatus } from "react-dom";
import type { ImportActionState } from "@/lib/excel-import";

const initial: ImportActionState = { ok: false };

// Local prop types (avoid importing server-only modules into the client bundle).
export type LastImport = {
  id: string;
  fileName: string | null;
  createdAt: Date;
  createdBy: string;
  rowsCreated: number;
  rowsSkipped: number;
  rowsDuplicated: number;
  rowsErrored: number;
  status: string;
};
type RevertState = { ok: boolean; error?: string; reverted?: number; kept?: number };
type RevertAction = (prev: RevertState | undefined, formData: FormData) => Promise<RevertState>;

const dtf = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

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

function RevertButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 shadow-sm hover:bg-rose-50 disabled:opacity-60"
    >
      {pending ? "Отмена..." : "Отменить последний импорт"}
    </button>
  );
}

/**
 * Reusable template-download + Excel-upload panel with import-safety UI:
 * created/skipped/duplicates/errors counts, a per-row errors+duplicates table,
 * a duplicate-file block message, and a "last import" section with undo.
 */
export function ExcelImportPanel({
  title,
  description,
  templateHref,
  templateLabel,
  uploadLabel,
  action,
  lastBatch,
  revertAction,
}: {
  title: string;
  description?: string;
  templateHref: string;
  templateLabel: string;
  uploadLabel: string;
  action: (prev: ImportActionState | undefined, formData: FormData) => Promise<ImportActionState>;
  lastBatch?: LastImport | null;
  revertAction?: RevertAction;
}) {
  const [state, formAction] = useFormState(action, initial);
  const [revertState, revertFormAction] = useFormState<RevertState, FormData>(
    revertAction ?? (async () => ({ ok: false })),
    { ok: false },
  );
  const r = state.result;
  const tableRows = r ? [...r.errors.map((e) => ({ ...e, kind: "error" as const })), ...r.duplicates.map((e) => ({ ...e, kind: "dup" as const }))] : [];
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

      {/* Duplicate-file block (Part 2 / 8) */}
      {state.blocked ? (
        <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
          {state.error ?? "Этот файл уже загружался ранее. Повторная загрузка заблокирована."}
          <div className="mt-0.5 text-xs text-amber-700">
            Загружен: {dtf.format(new Date(state.blocked.at))} · {state.blocked.by}
          </div>
        </div>
      ) : state.error ? (
        <p className="mt-3 text-sm text-rose-600">{state.error}</p>
      ) : null}

      {/* Import result (Part 8) */}
      {r ? (
        <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm ring-1 ring-inset ring-slate-200">
          <div className="text-sm font-semibold text-slate-700">Импорт завершён</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-slate-700">
            <span>Обработано: <b>{r.processed}</b></span>
            <span className="text-emerald-700">Создано: <b>{r.created}</b></span>
            {r.updated > 0 ? <span className="text-sky-700">Обновлено: <b>{r.updated}</b></span> : null}
            <span className="text-slate-500">Пропущено: <b>{r.skipped}</b></span>
            <span className={r.duplicates.length > 0 ? "text-amber-700" : "text-slate-500"}>Дубли: <b>{r.duplicates.length}</b></span>
            <span className={r.errors.length > 0 ? "text-rose-700" : "text-slate-500"}>Ошибки: <b>{r.errors.length}</b></span>
          </div>
          {tableRows.length > 0 ? (
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
                  {tableRows.map((e, i) => (
                    <tr key={i} className="text-slate-700">
                      <td className="py-1 pr-3 align-top">{e.row}</td>
                      <td className="py-1 pr-3 align-top">{e.club}</td>
                      <td className="py-1 pr-3 align-top text-slate-500">{e.field ?? "—"}</td>
                      <td className={`py-1 align-top ${e.kind === "dup" ? "text-amber-700" : "text-rose-700"}`}>{e.issue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Last import + undo (Part 5) */}
      {lastBatch && revertAction ? (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Последний импорт</div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-slate-700">
              <div>
                <span className="font-medium text-slate-900">{lastBatch.fileName ?? "файл"}</span>
                <span className="ml-2 text-xs text-slate-500">{dtf.format(new Date(lastBatch.createdAt))} · {lastBatch.createdBy}</span>
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                Создано {lastBatch.rowsCreated} · Пропущено {lastBatch.rowsSkipped} · Дубли {lastBatch.rowsDuplicated} · Ошибки {lastBatch.rowsErrored}
              </div>
            </div>
            <form action={revertFormAction}>
              <input type="hidden" name="batchId" value={lastBatch.id} />
              <RevertButton />
            </form>
          </div>
          {revertState.ok ? (
            <p className="mt-2 text-sm text-emerald-700">
              Импорт отменён. Откатано записей: {revertState.reverted ?? 0}
              {revertState.kept ? ` · оставлено (с действиями): ${revertState.kept}` : ""}
            </p>
          ) : revertState.error ? (
            <p className="mt-2 text-sm text-rose-600">{revertState.error}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
