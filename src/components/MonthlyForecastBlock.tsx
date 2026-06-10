import { formatKopeks } from "@/lib/money";
import type { MonthlyForecast } from "@/lib/forecast";

type Tone = "good" | "warn" | "bad" | "neutral";

const TONE_CARD: Record<Tone, string> = {
  good: "border-emerald-200 bg-emerald-50/50 dark:border-emerald-500/20 dark:bg-emerald-500/5",
  warn: "border-amber-200 bg-amber-50/50 dark:border-amber-500/20 dark:bg-amber-500/5",
  bad: "border-rose-200 bg-rose-50/50 dark:border-rose-500/20 dark:bg-rose-500/5",
  neutral: "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
};
const TONE_VALUE: Record<Tone, string> = {
  good: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-rose-700 dark:text-rose-400",
  neutral: "text-slate-900 dark:text-slate-100",
};

function ForecastCard({ title, value, tone, sub }: { title: string; value: string; tone: Tone; sub?: string }) {
  return (
    <div className={`flex flex-col rounded-xl border p-3.5 ${TONE_CARD[tone]}`}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</div>
      <div className={`mt-1.5 truncate text-base font-semibold tracking-tight ${TONE_VALUE[tone]}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] leading-snug text-slate-400 dark:text-slate-500">{sub}</div> : null}
    </div>
  );
}

const money = (k: number) => formatKopeks(k);

// Tone by how a projected value compares to plan (only meaningful with a plan).
function planTone(value: number, plan: number, hasPlan: boolean): Tone {
  if (!hasPlan) return "neutral";
  if (value >= plan) return "good";
  if (value >= plan * 0.9) return "warn";
  return "bad";
}

/**
 * "Прогноз месяца" — compact grid of monthly forecast indicators. Sales-based
 * cards are shown to everyone; break-even and safety-margin cards (which use the
 * expense budget) are financial-only. All numbers come from buildMonthlyForecast.
 */
export function MonthlyForecastBlock({ forecast: f, financials, hint }: { forecast: MonthlyForecast; financials: boolean; hint?: string }) {
  const cards: Array<{ title: string; value: string; tone: Tone; sub?: string }> = [];

  // 1 — Выполнение плана
  if (!f.hasPlan) {
    cards.push({ title: "Выполнение плана", value: "План не задан", tone: "neutral" });
  } else {
    const pct = f.completionPercent ?? 0;
    cards.push({
      title: "Выполнение плана",
      value: `${pct.toFixed(0)}%`,
      tone: pct >= 100 ? "good" : pct >= 80 ? "warn" : "bad",
      sub: `${money(f.salesFact)} из ${money(f.salesPlan)} · ${f.remainingToPlan > 0 ? `осталось ${money(f.remainingToPlan)}` : "план закрыт"}`,
    });
  }

  // 2 — Нужно в день до плана
  if (!f.hasPlan) {
    cards.push({ title: "Нужно в день до плана", value: "План не задан", tone: "neutral" });
  } else if (f.planReached) {
    cards.push({ title: "Нужно в день до плана", value: "План выполнен", tone: "good", sub: `осталось дней: ${f.daysLeft}` });
  } else {
    cards.push({
      title: "Нужно в день до плана",
      value: `${money(f.requiredPerDayToPlan)} / день`,
      tone: "neutral",
      sub: `осталось дней: ${f.daysLeft}`,
    });
  }

  // 3 — Нужно в день до окупаемости (financial)
  if (financials) {
    if (!f.hasBudget) {
      cards.push({ title: "Нужно в день до окупаемости", value: "Бюджет не задан", tone: "neutral" });
    } else if (f.breakEvenReached) {
      cards.push({ title: "Нужно в день до окупаемости", value: "Окупаемость достигнута", tone: "good" });
    } else {
      cards.push({
        title: "Нужно в день до окупаемости",
        value: `${money(f.requiredPerDayToBreakEven)} / день`,
        tone: "warn",
        sub: `бюджет ${money(f.expenseBudget)} · осталось ${money(f.remainingToBreakEven)}`,
      });
    }
  }

  // 4 — Прогноз по текущему темпу
  if (f.projectedMonthSales === null) {
    cards.push({ title: "Прогноз по текущему темпу", value: "Недостаточно данных", tone: "neutral" });
  } else {
    cards.push({
      title: "Прогноз по текущему темпу",
      value: money(f.projectedMonthSales),
      tone: planTone(f.projectedMonthSales, f.salesPlan, f.hasPlan),
      sub: `в среднем ${money(f.averagePerDay)} / день`,
    });
  }

  // 5 — Прогноз по прошлому месяцу
  if (f.prevMonthForecast === null) {
    cards.push({ title: "Прогноз по прошлому месяцу", value: "Недостаточно данных", tone: "neutral" });
  } else {
    cards.push({
      title: "Прогноз по прошлому месяцу",
      value: money(f.prevMonthForecast),
      tone: planTone(f.prevMonthForecast, f.salesPlan, f.hasPlan),
      sub: "по темпу прошлого месяца",
    });
  }

  // 6 — Риск выполнения плана
  if (!f.hasPlan) {
    cards.push({ title: "Риск выполнения плана", value: "План не задан", tone: "neutral" });
  } else if (f.projectedMonthSales === null) {
    cards.push({ title: "Риск выполнения плана", value: "Недостаточно данных", tone: "neutral" });
  } else {
    const map: Record<"low" | "medium" | "high", { value: string; tone: Tone }> = {
      low: { value: "Низкий риск", tone: "good" },
      medium: { value: "Средний риск", tone: "warn" },
      high: { value: "Высокий риск", tone: "bad" },
    };
    const r = map[f.risk as "low" | "medium" | "high"];
    cards.push({ title: "Риск выполнения плана", value: r.value, tone: r.tone, sub: `прогноз ${money(f.projectedMonthSales)}` });
  }

  // 7 — Запас прочности (financial)
  if (financials) {
    if (!f.hasBudget) {
      cards.push({ title: "Запас прочности", value: "Бюджет не задан", tone: "neutral" });
    } else if (f.safetyMargin >= 0) {
      cards.push({ title: "Запас прочности", value: `+${money(f.safetyMargin)}`, tone: "good", sub: "сверх окупаемости" });
    } else {
      cards.push({ title: "Запас прочности", value: money(f.safetyMargin), tone: "bad", sub: "не хватает до окупаемости" });
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Прогноз месяца</span>
        {hint ? <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">{hint}</span> : null}
      </div>
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
        {cards.map((c, i) => (
          <ForecastCard key={i} title={c.title} value={c.value} tone={c.tone} sub={c.sub} />
        ))}
      </div>
    </div>
  );
}
