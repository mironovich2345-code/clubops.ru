import Link from "next/link";
import { formatKopeks } from "@/lib/money";
import { taskListHref, type RegionalReviewTasks, type RegionalTaskCard } from "@/lib/regional-tasks";

const dfmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const CARDS: { key: keyof RegionalReviewTasks; base: "invoices" | "expenses" | "refunds"; title: string; hasDue: boolean }[] = [
  { key: "invoices", base: "invoices", title: "Счета на проверке", hasDue: true },
  { key: "expenses", base: "expenses", title: "Расходы на проверке", hasDue: false },
  { key: "refunds", base: "refunds", title: "Возвраты на проверке", hasDue: true },
];

/**
 * Regional director «Требуют внимания» — three review-task cards. Neutral by default; a
 * warning ring only when something is overdue. Mobile: one column; desktop: three across.
 * Every count/sum/link comes from the shared loader (single source of truth).
 */
export function RegionalReviewCards({ tasks }: { tasks: RegionalReviewTasks }) {
  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Требуют внимания</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => <TaskCard key={c.key} card={tasks[c.key]} title={c.title} base={c.base} hasDue={c.hasDue} />)}
      </div>
    </section>
  );
}

function TaskCard({ card, title, base, hasDue }: { card: RegionalTaskCard; title: string; base: "invoices" | "expenses" | "refunds"; hasDue: boolean }) {
  const warn = card.overdue > 0;
  const shownClubs = card.clubs.slice(0, 4);
  const moreClubs = card.clubCount - shownClubs.length;
  return (
    <div className={`flex h-full flex-col rounded-2xl border bg-white p-4 shadow-sm dark:bg-slate-900 ${warn ? "border-amber-300 dark:border-amber-500/40" : "border-slate-200 dark:border-slate-800"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-slate-500 dark:text-slate-400">{title}</div>
        {warn ? <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/25">просрочено {card.overdue}</span> : null}
      </div>

      {card.error ? (
        <div className="mt-3 flex flex-1 items-center text-sm text-rose-600 dark:text-rose-400">Не удалось загрузить — обновите страницу</div>
      ) : card.count === 0 ? (
        <div className="mt-3 flex flex-1 items-center text-sm text-slate-400 dark:text-slate-500">Нет задач на проверке</div>
      ) : (
        <>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">{card.count}</span>
            <span className="truncate text-sm font-medium tabular-nums text-slate-600 dark:text-slate-300">{formatKopeks(card.sumKopeks)}</span>
          </div>
          <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">
            {hasDue
              ? (card.nearestDueIso ? `Ближайший срок: ${dfmt.format(new Date(`${card.nearestDueIso}T00:00:00`))}` : "Без срока")
              : "Срок проверки не задан"}
            {card.clubCount > 0 ? ` · клубов: ${card.clubCount}` : ""}
            {card.noDue > 0 && hasDue ? ` · без срока: ${card.noDue}` : ""}
          </div>

          {shownClubs.length > 0 ? (
            <ul className="mt-3 space-y-1.5">
              {shownClubs.map((cl) => (
                <li key={cl.clubId} className="flex items-center justify-between gap-2 text-xs">
                  <Link href={taskListHref(base, cl.clubId)} className="min-w-0 truncate text-slate-600 hover:text-brand-700 dark:text-slate-300">{cl.clubName}</Link>
                  <span className="flex shrink-0 items-center gap-2 tabular-nums">
                    <span className="text-slate-500 dark:text-slate-400">{cl.count} · {formatKopeks(cl.sumKopeks)}</span>
                    {cl.overdue > 0 ? <span className="text-amber-700 dark:text-amber-400">просроч. {cl.overdue}</span> : null}
                  </span>
                </li>
              ))}
              {moreClubs > 0 ? <li className="text-xs text-slate-400 dark:text-slate-500">Ещё {moreClubs} клуб(ов)</li> : null}
            </ul>
          ) : null}
        </>
      )}

      <Link href={card.href} className="mt-3 inline-flex min-h-[40px] items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
        Открыть
      </Link>
    </div>
  );
}
