import { formatKopeks } from "@/lib/money";
import type { MonthlyForecast } from "@/lib/forecast";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

const RISK_LABEL: Record<string, string> = { low: "низкий", medium: "средний", high: "высокий", none: "—" };
const RISK_CLS: Record<string, string> = {
  low: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  medium: "bg-amber-50 text-amber-800 ring-amber-200",
  high: "bg-rose-50 text-rose-700 ring-rose-200",
  none: "bg-slate-100 text-slate-600 ring-slate-200",
};

function pct(p: number | null): string {
  return p === null || !Number.isFinite(p) ? "—" : `${p.toFixed(0)}%`;
}

/**
 * Sales forecast/result for the selected month. Honest about the month's phase:
 *  - past month: actual final result, labeled "Факт" (no false forecast).
 *  - current month: projection by current pace + risk vs plan.
 *  - future month: configured plan only; projection shows
 *    "Недостаточно данных для прогноза" (plan is never labeled as a forecast).
 * All numbers come from the NaN/Infinity-safe forecast helper.
 */
export function DashboardForecast({
  mode,
  monthLabel,
  forecast: f,
  abFact,
  ptFact,
  abPlan,
  ptPlan,
}: {
  mode: "past" | "current" | "future";
  monthLabel: string;
  forecast: MonthlyForecast;
  abFact: number;
  ptFact: number;
  abPlan: number;
  ptPlan: number;
}) {
  const badge =
    mode === "past"
      ? { text: "Факт", cls: "bg-slate-100 text-slate-600 ring-slate-200" }
      : mode === "current"
        ? { text: "Прогноз", cls: "bg-sky-50 text-sky-700 ring-sky-200" }
        : { text: "План", cls: "bg-violet-50 text-violet-700 ring-violet-200" };

  return (
    <div className={`mb-6 p-5 ${CARD}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Прогноз продаж</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">{monthLabel}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${badge.cls}`}>{badge.text}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {mode === "past" ? (
          <Metric label="Итог за месяц (факт)" value={formatKopeks(f.salesFact)} accent="text-slate-900 dark:text-slate-100" />
        ) : mode === "current" ? (
          <Metric
            label="Прогноз по темпу"
            value={f.projectedMonthSales === null ? "Недостаточно данных для прогноза" : formatKopeks(f.projectedMonthSales)}
            accent="text-sky-700 dark:text-sky-400"
          />
        ) : (
          <Metric label="Прогноз" value="Недостаточно данных для прогноза" accent="text-slate-400 dark:text-slate-500" />
        )}

        <Metric
          label={mode === "future" ? "План месяца" : "План / выполнение"}
          value={f.hasPlan ? formatKopeks(f.salesPlan) : "План не задан"}
          hint={mode !== "future" && f.hasPlan ? `Выполнение: ${pct(f.completionPercent)}` : undefined}
          accent="text-slate-900 dark:text-slate-100"
        />

        {mode === "current" && f.hasPlan ? (
          <div className="min-w-0">
            <div className="text-xs text-slate-400 dark:text-slate-500">Риск невыполнения плана</div>
            <div className="mt-1">
              <span className={`inline-flex rounded-full px-2.5 py-0.5 text-sm font-medium ring-1 ring-inset ${RISK_CLS[f.risk]}`}>
                {RISK_LABEL[f.risk] ?? "—"}
              </span>
            </div>
            {f.daysLeft > 0 && !f.planReached ? (
              <div className="mt-1 text-[11px] text-slate-400">Нужно в день: {formatKopeks(f.requiredPerDayToPlan)}</div>
            ) : null}
          </div>
        ) : (
          <Metric
            label={mode === "future" ? "В т.ч. план АБ / ПТ" : "Факт АБ / ПТ"}
            value={mode === "future" ? `${formatKopeks(abPlan)} / ${formatKopeks(ptPlan)}` : `${formatKopeks(abFact)} / ${formatKopeks(ptFact)}`}
            accent="text-slate-700 dark:text-slate-300"
          />
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-slate-400 dark:text-slate-500">{label}</div>
      <div className={`mt-1 truncate text-lg font-semibold ${accent}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">{hint}</div> : null}
    </div>
  );
}
