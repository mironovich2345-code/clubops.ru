"use client";

import { useFormState } from "react-dom";
import { previewPlanImport, applyPlanImport, type PlanImportState } from "../plan-import-actions";
import { formatKopeksThousands } from "@/lib/imports/amount";

const initial: PlanImportState = { ok: false };

// Owner/GD-only plan import: download template → upload → preview → confirm. The
// total plan is always АБ + ПТ (never entered); apply is atomic (blocked on errors).
export function PlanImportPanel({ month }: { month: string }) {
  const [preview, previewAction] = useFormState(previewPlanImport, initial);
  const [applied, applyAction] = useFormState(applyPlanImport, initial);

  const rows = preview.preview ?? [];
  const applyable = rows.filter((r) => r.status !== "error").map((r) => ({ clubId: r.clubId!, subsKopeks: r.newSubsKopeks, ptKopeks: r.newPtKopeks }));

  return (
    <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
      <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Импорт планов из шаблона</div>
      <div className="flex flex-wrap items-center gap-3">
        <a href={`/api/sales-plans/template?month=${encodeURIComponent(month)}`} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
          Скачать шаблон
        </a>
        <form action={previewAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="month" value={month} />
          <input type="file" name="file" accept=".xlsx,.xls,.csv" required className="text-sm text-slate-600 dark:text-slate-300" />
          <button type="submit" className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700">Загрузить планы</button>
        </form>
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Общий план считается автоматически = План АБ + План ПТ. Суммы можно писать как 2 500 000, 2.500.000 или 2500000.</p>

      {preview.error ? <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{preview.error}</p> : null}
      {applied.applied ? (
        <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">Обновлено: {applied.applied.updated}, создано: {applied.applied.created}, ошибок: 0.</p>
      ) : null}
      {applied.error ? <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{applied.error}</p> : null}

      {rows.length > 0 && !applied.applied ? (
        <div className="mt-3">
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  <Th>Клуб</Th><Th>Текущий АБ</Th><Th>Новый АБ</Th><Th>Текущий ПТ</Th><Th>Новый ПТ</Th><Th>Текущий общий</Th><Th>Новый общий</Th><Th>Статус</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {rows.map((r, i) => (
                  <tr key={i}>
                    <Td className="font-medium text-slate-800 dark:text-slate-100">{r.clubName}</Td>
                    {r.status === "error" ? (
                      <Td className="text-rose-600 dark:text-rose-400" colSpan={6}>{r.error}</Td>
                    ) : (
                      <>
                        <Td>{formatKopeksThousands(r.currentSubsKopeks)}</Td>
                        <Td className="font-medium text-slate-900 dark:text-slate-100">{formatKopeksThousands(r.newSubsKopeks)}</Td>
                        <Td>{formatKopeksThousands(r.currentPtKopeks)}</Td>
                        <Td className="font-medium text-slate-900 dark:text-slate-100">{formatKopeksThousands(r.newPtKopeks)}</Td>
                        <Td>{formatKopeksThousands(r.currentTotalKopeks)}</Td>
                        <Td className="font-medium text-slate-900 dark:text-slate-100">{formatKopeksThousands(r.newTotalKopeks)}</Td>
                      </>
                    )}
                    <Td><StatusChip status={r.status} /></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.anyError ? (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">Исправьте ошибки в файле — импорт не применяется, пока есть ошибки.</p>
          ) : (
            <form action={applyAction} className="mt-3">
              <input type="hidden" name="month" value={month} />
              <input type="hidden" name="payload" value={JSON.stringify(applyable)} />
              <button type="submit" className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700">Применить импорт ({applyable.length})</button>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}

function StatusChip({ status }: { status: "create" | "update" | "error" }) {
  const map = {
    create: { t: "будет создано", c: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300" },
    update: { t: "будет обновлено", c: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300" },
    error: { t: "ошибка", c: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300" },
  }[status];
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${map.c}`}>{map.t}</span>;
}
function Th({ children }: { children: React.ReactNode }) {
  return <th scope="col" className="px-3 py-2">{children}</th>;
}
function Td({ children, className, colSpan }: { children: React.ReactNode; className?: string; colSpan?: number }) {
  return <td colSpan={colSpan} className={`px-3 py-2 align-top text-slate-600 dark:text-slate-300 ${className ?? ""}`}>{children}</td>;
}
