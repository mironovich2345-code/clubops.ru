import Link from "next/link";
import { MonthNav } from "@/components/mobile/MonthNav";

/**
 * Dashboard month selector (?month=YYYY-MM). Uses the shared MonthNav: symmetric 44×44
 * arrows + centered label, with "Текущий месяц" on its own line (badge when already the
 * current month, else a reset link). Pure links — the page validates the query param.
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
    <MonthNav
      prevHref={`/dashboard?month=${prevMonth}`}
      nextHref={`/dashboard?month=${nextMonth}`}
      label={monthLabel}
      badge={
        isCurrent ? (
          <span className="rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300">Текущий месяц</span>
        ) : (
          <Link href="/dashboard" className="rounded-md px-2.5 py-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">← Текущий месяц</Link>
        )
      }
    />
  );
}
