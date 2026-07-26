import Link from "next/link";
import { formatKopeks } from "@/lib/money";

export type CategoryCard = {
  group: string; // manager_card | administrative_card | gym_trainers_card | group_trainers_card | advances_card
  label: string;
  count: number; // active employees in this card
  filled: number; // calculations no longer in draft
  problems: number;
  prelimKopeks: number;
  href: string;
  status: string; // user-facing block status
};

const STATUS_CLS: Record<string, string> = {
  "Не начато": "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  "Требует заполнения": "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  "Заполнено": "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  "Требует проверки": "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
};

/** Five payroll cards for the manager's period screen (spec §9). Vertical on mobile,
 * grid on desktop. Each card is a summary + «Открыть» into the category view. */
export function PeriodCategoryCards({ cards }: { cards: CategoryCard[] }) {
  return (
    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {cards.map((c) => (
        <Link key={c.group} href={c.href} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800/40">
          <div className="mb-1 flex items-start justify-between gap-2">
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{c.label}</span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_CLS[c.status] ?? "bg-slate-100 text-slate-500"}`}>{c.status}</span>
          </div>
          {c.group === "advances_card" ? (
            <div className="text-xs text-slate-500 dark:text-slate-400">Все активные сотрудники по категориям</div>
          ) : (
            <>
              <div className="text-xs text-slate-500 dark:text-slate-400">Сотрудников: {c.count}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">Заполнено: {c.filled} из {c.count}{c.problems > 0 ? <span className="ml-1 text-amber-600">· проблем {c.problems}</span> : null}</div>
              <div className="mt-1 text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">{formatKopeks(c.prelimKopeks)}</div>
              <div className="text-[11px] text-slate-400">предварительно</div>
            </>
          )}
          <div className="mt-2 text-xs text-brand-600 dark:text-brand-400">Открыть →</div>
        </Link>
      ))}
    </div>
  );
}
