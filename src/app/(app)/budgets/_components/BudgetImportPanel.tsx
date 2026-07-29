"use client";

import { useFormState } from "react-dom";
import { previewBudgetImport, applyBudgetImport, type BudgetImportState } from "../budget-import-actions";
import { formatKopeksThousands } from "@/lib/imports/amount";
import { MobileFileField } from "@/components/mobile/MobileFileField";
import { buttonClass } from "@/components/mobile/buttons";

const initial: BudgetImportState = { ok: false };

// Owner/GD-only budget import by category: download template → upload → preview →
// confirm. A club's monthly budget = sum of its category rows. Apply is atomic.
export function BudgetImportPanel({ month }: { month: string }) {
  const [preview, previewAction] = useFormState(previewBudgetImport, initial);
  const [applied, applyAction] = useFormState(applyBudgetImport, initial);

  const rows = preview.preview ?? [];
  const applyable = rows.filter((r) => r.status !== "error").map((r) => ({ clubId: r.clubId!, category: r.category!, kopeks: r.newKopeks }));

  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Импорт бюджетов из шаблона</div>
      {/* Mobile: template download (full-width secondary, centered) → file field →
          upload (full-width primary), one column, equal heights. Desktop: compact. (spec §9) */}
      <div className="flex flex-col gap-3">
        <a href={`/api/budgets/template?month=${encodeURIComponent(month)}`} className={`${buttonClass({ variant: "secondary" })} w-full sm:w-auto`}>
          Скачать шаблон
        </a>
        <form action={previewAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <input type="hidden" name="month" value={month} />
          <div className="min-w-0 flex-1">
            <MobileFileField name="file" accept=".xlsx,.xls,.csv" maxFiles={1} required />
          </div>
          <button type="submit" className={`${buttonClass({ variant: "primary" })} w-full sm:w-auto`}>Загрузить бюджеты</button>
        </form>
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Бюджет клуба за месяц = сумма строк по статьям. Суммы можно писать как 2 500 000, 2.500.000 или 2500000. Пустые суммы пропускаются.</p>

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
                  <Th>Клуб</Th><Th>Статья</Th><Th>Текущая сумма</Th><Th>Новая сумма</Th><Th>Изменение</Th><Th>Статус</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {rows.map((r, i) => (
                  <tr key={i}>
                    <Td className="font-medium text-slate-800 dark:text-slate-100">{r.clubName}</Td>
                    <Td>{r.categoryLabel}</Td>
                    {r.status === "error" ? (
                      <Td className="text-rose-600 dark:text-rose-400" colSpan={3}>{r.error}</Td>
                    ) : (
                      <>
                        <Td>{formatKopeksThousands(r.currentKopeks)}</Td>
                        <Td className="font-medium text-slate-900 dark:text-slate-100">{formatKopeksThousands(r.newKopeks)}</Td>
                        <Td className={r.deltaKopeks >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>{r.deltaKopeks >= 0 ? "+" : ""}{formatKopeksThousands(r.deltaKopeks)}</Td>
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
