import Link from "next/link";

const BTN =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";

/**
 * Dashboard month selector (?month=YYYY-MM). Prev / label / next + "Текущий
 * месяц". Pure links — the page validates the query param and falls back to the
 * current month, so the selection survives reload/navigation.
 */
export function DashboardMonthSelector({
  monthLabel,
  prevMonth,
  nextMonth,
  isCurrent,
}: {
  monthLabel: string;
  prevMonth: string;
  nextMonth: string;
  isCurrent: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={`/dashboard?month=${prevMonth}`} className={BTN} aria-label="Предыдущий месяц">‹</Link>
      <span className="min-w-[9.5rem] text-center text-sm font-semibold text-slate-900 dark:text-slate-100">{monthLabel}</span>
      <Link href={`/dashboard?month=${nextMonth}`} className={BTN} aria-label="Следующий месяц">›</Link>
      {isCurrent ? (
        <span className="rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">Текущий месяц</span>
      ) : (
        <Link href="/dashboard" className={BTN}>Текущий месяц</Link>
      )}
    </div>
  );
}
