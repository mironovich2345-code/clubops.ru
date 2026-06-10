// Pure monthly-forecast math for the Analytics "Прогноз месяца" block. All money
// is in kopeks (integers). The function never produces NaN or Infinity — every
// division is guarded and day counts are clamped to the period. UI strings live
// in the component; this module only computes numbers and discrete states.

export type ForecastRisk = "low" | "medium" | "high" | "none";

export type MonthlyForecast = {
  // Period day accounting (relative to `now`, clamped to the period).
  totalDays: number;
  elapsedDays: number; // days from period start through today (inclusive); 0 if not started
  daysLeft: number; // remaining days INCLUDING today; 0 if the period is over

  salesFact: number;

  // 1 — Выполнение плана
  hasPlan: boolean;
  salesPlan: number;
  completionPercent: number | null; // null when no plan
  remainingToPlan: number; // plan − fact (negative once exceeded)
  planReached: boolean;

  // 2 — Нужно в день до плана
  requiredPerDayToPlan: number; // 0 when reached / no plan / period over

  // 3 — Нужно в день до окупаемости
  hasBudget: boolean;
  expenseBudget: number;
  remainingToBreakEven: number; // budget − fact
  breakEvenReached: boolean;
  requiredPerDayToBreakEven: number;

  // 4 — Прогноз по текущему темпу
  averagePerDay: number; // 0 when nothing has elapsed yet
  projectedMonthSales: number | null; // null when no elapsed days (no pace yet)

  // 5 — Прогноз по прошлому месяцу
  prevMonthForecast: number | null; // null = недостаточно данных

  // 6 — Риск выполнения плана
  risk: ForecastRisk; // "none" = no plan; assess only when projection exists

  // 7 — Запас прочности
  safetyMargin: number; // fact − budget (gate display on hasBudget)
};

const DAY = 86_400_000;

export function buildMonthlyForecast(input: {
  salesFact: number;
  salesPlan: number;
  expenseBudget: number;
  periodStart: Date;
  periodEnd: Date; // exclusive
  now: Date;
  previousMonthRemainingSales: number | null;
}): MonthlyForecast {
  const { salesFact, salesPlan, expenseBudget, periodStart, periodEnd, now, previousMonthRemainingSales } = input;

  const totalDays = Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / DAY));

  // Elapsed days: today is counted as elapsed (sales so far include today).
  let elapsedDays: number;
  if (now.getTime() < periodStart.getTime()) elapsedDays = 0;
  else if (now.getTime() >= periodEnd.getTime()) elapsedDays = totalDays;
  else elapsedDays = Math.min(totalDays, Math.floor((now.getTime() - periodStart.getTime()) / DAY) + 1);

  // Days left INCLUDING today (you can still sell today).
  let daysLeft: number;
  if (now.getTime() < periodStart.getTime()) daysLeft = totalDays;
  else if (now.getTime() >= periodEnd.getTime()) daysLeft = 0;
  else daysLeft = totalDays - elapsedDays + 1;

  const hasPlan = salesPlan > 0;
  const completionPercent = hasPlan ? (salesFact / salesPlan) * 100 : null;
  const remainingToPlan = salesPlan - salesFact;
  const planReached = hasPlan && salesFact >= salesPlan;
  const requiredPerDayToPlan = hasPlan && daysLeft > 0 ? Math.round(Math.max(0, remainingToPlan) / daysLeft) : 0;

  const hasBudget = expenseBudget > 0;
  const remainingToBreakEven = expenseBudget - salesFact;
  const breakEvenReached = hasBudget && salesFact >= expenseBudget;
  const requiredPerDayToBreakEven = hasBudget && daysLeft > 0 ? Math.round(Math.max(0, remainingToBreakEven) / daysLeft) : 0;

  const averagePerDay = elapsedDays > 0 ? Math.round(salesFact / elapsedDays) : 0;
  // Remaining FULL days after today; projection extrapolates the current pace.
  const remainingAfterToday = Math.max(0, totalDays - elapsedDays);
  const projectedMonthSales = elapsedDays > 0 ? salesFact + averagePerDay * remainingAfterToday : null;

  const prevMonthForecast = previousMonthRemainingSales === null ? null : salesFact + previousMonthRemainingSales;

  let risk: ForecastRisk = "none";
  if (hasPlan && projectedMonthSales !== null) {
    if (projectedMonthSales >= salesPlan) risk = "low";
    else if (projectedMonthSales >= salesPlan * 0.9) risk = "medium"; // behind by ≤10%
    else risk = "high";
  }

  const safetyMargin = salesFact - expenseBudget;

  return {
    totalDays,
    elapsedDays,
    daysLeft,
    salesFact,
    hasPlan,
    salesPlan,
    completionPercent,
    remainingToPlan,
    planReached,
    requiredPerDayToPlan,
    hasBudget,
    expenseBudget,
    remainingToBreakEven,
    breakEvenReached,
    requiredPerDayToBreakEven,
    averagePerDay,
    projectedMonthSales,
    prevMonthForecast,
    risk,
    safetyMargin,
  };
}
