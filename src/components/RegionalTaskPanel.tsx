import Link from "next/link";
import { formatKopeks } from "@/lib/money";
import type { RegionalTaskListRow } from "@/lib/regional-tasks";

const dfmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

/**
 * Panel shown on a list page when `?task=regional_review` is active: an active-filter chip, a
 * reset link, and the regional's task rows (nearest-due first). Rows are already scoped +
 * (optionally) club-narrowed by the loader — the URL can never widen scope. Presentational.
 */
export function RegionalTaskPanel({ base, rows, hasDue, resetHref, clubChip }: {
  base: "invoices" | "expenses" | "refunds"; rows: RegionalTaskListRow[]; hasDue: boolean; resetHref: string; clubChip?: string | null;
}) {
  return (
    <div className="mb-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">Задачи регионала: на проверке</span>
        {clubChip ? <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">Клуб: {clubChip}</span> : null}
        <Link href={resetHref} className="text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400">Сбросить фильтр</Link>
        <span className="ml-auto text-xs text-slate-400">{rows.length} задач(и)</span>
      </div>

      {rows.length === 0 ? (
        <div className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">Нет задач на проверке</div>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 lg:block dark:border-slate-800">
            <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-800/50"><tr><Th>Клуб</Th><Th>Объект</Th><Th>Сумма</Th><Th>Срок</Th><Th>Действие</Th></tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <Td>{r.clubName}</Td>
                    <Td>{r.title}</Td>
                    <Td className="tabular-nums">{formatKopeks(r.amountKopeks)}</Td>
                    <Td>{hasDue ? (r.dueIso ? <span className={r.overdue ? "font-medium text-amber-700 dark:text-amber-400" : ""}>{dfmt.format(new Date(`${r.dueIso}T00:00:00`))}{r.overdue ? " · просрочено" : ""}</span> : "Без срока") : "—"}</Td>
                    <Td><Link href={`/${base}/${r.id}`} className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">Открыть</Link></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-2 lg:hidden">
            {rows.map((r) => (
              <Link key={r.id} href={`/${base}/${r.id}`} className="block rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{r.title}</div><div className="text-xs text-slate-500 dark:text-slate-400">{r.clubName}</div></div>
                  <div className="shrink-0 text-right"><div className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">{formatKopeks(r.amountKopeks)}</div>{hasDue ? <div className={`text-xs ${r.overdue ? "text-amber-700 dark:text-amber-400" : "text-slate-400"}`}>{r.dueIso ? dfmt.format(new Date(`${r.dueIso}T00:00:00`)) : "Без срока"}</div> : null}</div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
function Th({ children }: { children: React.ReactNode }) { return <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</th>; }
function Td({ children, className }: { children: React.ReactNode; className?: string }) { return <td className={`px-3 py-2 align-top text-slate-700 dark:text-slate-300 ${className ?? ""}`}>{children}</td>; }
