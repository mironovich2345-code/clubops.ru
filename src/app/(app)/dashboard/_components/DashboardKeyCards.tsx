import { formatKopeks } from "@/lib/money";

// Compact "key figures" row for the simplified dashboard. Shows only the essential
// managerial numbers for the selected month/scope; the detailed tables, forecast and
// ОФД overview live in /analytics and /analytics/ofd-sales. Every card uses neutral,
// dark-theme-safe tokens (no bright fills / hard light backgrounds); accents are soft
// text-only so warning/positive/negative states never overpower the screen.
export type DashboardKeyMetrics = {
  showSales: boolean; // ОФД membership / ПТ / result (owner/GD/regional)
  showExpenses: boolean; // confirmed expenses (financial roles)
  showCash: boolean; // ООО / ИП fact cash (owner/GD/regional/manager)
  cashAvailable: boolean; // cash actually computed (single company in scope)
  abKopeks: number;
  ptKopeks: number;
  expensesKopeks: number;
  resultKopeks: number;
  oooCashKopeks: number;
  ipCashKopeks: number;
  monthLabel: string;
};

export function DashboardKeyCards(m: DashboardKeyMetrics) {
  const anything = m.showSales || m.showExpenses || (m.showCash && m.cashAvailable);
  if (!anything) {
    return (
      <div className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        Финансовые показатели для вашей роли не отображаются.
      </div>
    );
  }
  return (
    <div className="mb-5">
      <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Ключевые показатели · {m.monthLabel}</div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        {m.showSales ? <Card label="Абонементы" value={formatKopeks(m.abKopeks)} accent="text-emerald-600 dark:text-emerald-400" /> : null}
        {m.showSales ? <Card label="ПТ" value={formatKopeks(m.ptKopeks)} accent="text-sky-600 dark:text-sky-400" /> : null}
        {m.showExpenses ? <Card label="Фактические расходы" value={formatKopeks(m.expensesKopeks)} accent="text-rose-600 dark:text-rose-400" /> : null}
        {m.showCash && m.cashAvailable ? <Card label="Наличные ООО" value={formatKopeks(m.oooCashKopeks)} /> : null}
        {m.showCash && m.cashAvailable ? <Card label="Наличные ИП" value={formatKopeks(m.ipCashKopeks)} /> : null}
        {m.showSales ? <Card label="Результат" value={formatKopeks(m.resultKopeks)} accent={m.resultKopeks >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"} sub="ОФД − расходы" /> : null}
      </div>
    </div>
  );
}

function Card({ label, value, accent, sub }: { label: string; value: string; accent?: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1.5 truncate text-xl font-semibold tracking-tight ${accent ?? "text-slate-900 dark:text-slate-100"}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">{sub}</div> : null}
    </div>
  );
}
