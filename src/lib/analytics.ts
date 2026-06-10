import { prisma } from "@/lib/prisma";
import { expenseCategoryLabel } from "@/lib/expenses";
import {
  computeBudgetFactReport,
  type BudgetFactReport,
} from "@/lib/budgets";
import { REVENUE_LINE_KEY, CASH_OOO_KEY, ENCASHMENT_KEY, getSalesReportFactBreakdown } from "@/lib/sales-report-rows";
import { invoiceAnalyticsDate } from "@/lib/invoices";

// Confirmed-report line keys for the plan-direction split facts.
const SUBSCRIPTIONS_KEY = "subscriptions_ooo";
const PERSONAL_TRAINING_KEY = "personal_training_total";
const REVENUE_IP_KEY = "revenue_ip";

// Russian short weekday names indexed by Date.getDay() (0 = Sunday).
const WEEKDAY_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
// Full weekday names, Monday-first, for the weekday analytics table.
const WEEKDAY_FULL_MON_FIRST = [
  { day: 1, label: "Понедельник" },
  { day: 2, label: "Вторник" },
  { day: 3, label: "Среда" },
  { day: 4, label: "Четверг" },
  { day: 5, label: "Пятница" },
  { day: 6, label: "Суббота" },
  { day: 0, label: "Воскресенье" },
];

// ---------------------------------------------------------------------------
// Network analytics. Period-aware aggregation built from settled financial
// events:
//   sales  = confirmed sales
//   spend  = confirmed expenses + paid invoices + paid refunds
// (everything else — draft / pending / rejected / waiting_budget_approval — is
// excluded.) All money in kopeks. Scope (companyId + clubIds) is resolved by the
// caller from effective roles; these helpers never widen it.
// ---------------------------------------------------------------------------

export type AnalyticsPeriodKey =
  | "current_week"
  | "previous_week"
  | "current_month"
  | "previous_month"
  | "current_year"
  | "previous_year"
  | "custom";

export type ResolvedPeriod = {
  key: AnalyticsPeriodKey;
  label: string;
  start: Date;
  end: Date; // exclusive
  prevStart: Date;
  prevEnd: Date; // exclusive
  months: string[]; // "YYYY-MM" months overlapping [start, end)
  primaryMonth: string; // month of `start` (used for monthly budget/plan blocks)
};

function monthStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthsBetween(start: Date, end: Date): string[] {
  const out: string[] = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur.getTime() < end.getTime()) {
    out.push(monthStr(cur));
    cur.setMonth(cur.getMonth() + 1);
  }
  return out.length ? out : [monthStr(start)];
}

/** Monday-00:00 of the calendar week containing `d` (local time). */
function startOfWeek(d: Date): Date {
  const offset = (d.getDay() + 6) % 7; // days since Monday (Mon=0 … Sun=6)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
}

function buildPeriod(key: AnalyticsPeriodKey, label: string, start: Date, end: Date, prevStart: Date): ResolvedPeriod {
  return { key, label, start, end, prevStart, prevEnd: start, months: monthsBetween(start, end), primaryMonth: monthStr(start) };
}

export function resolvePeriod(
  key: AnalyticsPeriodKey,
  now: Date,
  from?: Date,
  to?: Date,
): ResolvedPeriod {
  const y = now.getFullYear();
  const m = now.getMonth();
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  if (key === "current_week") {
    const start = startOfWeek(now);
    const end = new Date(start.getTime() + WEEK);
    return buildPeriod(key, "Текущая неделя", start, end, new Date(start.getTime() - WEEK));
  }
  if (key === "previous_week") {
    const cur = startOfWeek(now);
    const start = new Date(cur.getTime() - WEEK);
    return buildPeriod(key, "Прошлая неделя", start, cur, new Date(start.getTime() - WEEK));
  }
  if (key === "previous_month") {
    const start = new Date(y, m - 1, 1);
    return buildPeriod(key, "Прошлый месяц", start, new Date(y, m, 1), new Date(y, m - 2, 1));
  }
  if (key === "current_year") {
    const start = new Date(y, 0, 1);
    return buildPeriod(key, "Текущий год", start, new Date(y + 1, 0, 1), new Date(y - 1, 0, 1));
  }
  if (key === "previous_year") {
    const start = new Date(y - 1, 0, 1);
    return buildPeriod(key, "Прошлый год", start, new Date(y, 0, 1), new Date(y - 2, 0, 1));
  }
  if (key === "custom" && from && to) {
    const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const end = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1); // inclusive `to`
    const span = end.getTime() - start.getTime();
    const prevStart = new Date(start.getTime() - span);
    return { key, label: "Произвольный период", start, end, prevStart, prevEnd: start, months: monthsBetween(start, end), primaryMonth: monthStr(start) };
  }
  // current_month (default)
  const start = new Date(y, m, 1);
  return buildPeriod("current_month", "Текущий месяц", start, new Date(y, m + 1, 1), new Date(y, m - 1, 1));
}

// --- raw data --------------------------------------------------------------

const APPROVED_UNPAID = ["approved_by_regional", "approved_by_owner"];

export type AnalyticsData = {
  clubs: Array<{ id: string; name: string }>;
  sales: Array<{ clubId: string; amountKopeks: number; saleDate: Date }>;
  expenses: Array<{ clubId: string; category: string; amountKopeks: number; expenseDate: Date; status: string }>;
  invoices: Array<{ clubId: string; expenseCategory: string | null; amountKopeks: number; expensePeriod: string | null; paidAt: Date | null; invoiceDate: Date | null; createdAt: Date; status: string }>;
  refunds: Array<{ clubId: string; amountKopeks: number; paidAt: Date | null; refundDate: Date | null; createdAt: Date; status: string }>;
  budgets: Array<{ clubId: string; category: string; limitAmountKopeks: number }>;
  plans: Array<{ clubId: string | null; planType: string; targetAmountKopeks: number }>;
  reportCash: Array<{ reportDate: Date; cashOooKopeks: number; encashmentKopeks: number }>;
  // Per-report confirmed facts by plan direction (общий / абонементы /
  // персональные — ИП revenue folded into personal training), plus the manager
  // and weekday for the by-weekday / by-manager analytics.
  reportSplit: Array<{ clubId: string; date: Date; managerName: string | null; total: number; subscriptions: number; personal_training: number }>;
  pendingSalesCount: number;
  debtKopeks: number;
};

/**
 * Load settled financial rows for the scope, bounded to [prevStart, end) for
 * trend/comparison. Status filters at the DB layer keep the dataset small.
 */
export async function loadAnalyticsData(
  companyId: string,
  clubIds: string[],
  period: ResolvedPeriod,
): Promise<AnalyticsData> {
  if (clubIds.length === 0) {
    return { clubs: [], sales: [], expenses: [], invoices: [], refunds: [], budgets: [], plans: [], reportCash: [], reportSplit: [], pendingSalesCount: 0, debtKopeks: 0 };
  }
  const lo = period.prevStart;
  const hi = period.end;
  const inClubs = { in: clubIds };

  const [clubs, sales, reports, expenses, invoices, refunds, budgets, plans, pendingSalesCount, debtInvoices, debtRefunds] =
    await Promise.all([
      prisma.club.findMany({ where: { id: inClubs }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      prisma.sale.findMany({ where: { companyId, clubId: inClubs, status: "confirmed", saleDate: { gte: lo, lt: hi } }, select: { clubId: true, amountKopeks: true, saleDate: true } }),
      prisma.salesReport.findMany({ where: { companyId, clubId: inClubs, status: "confirmed", reportDate: { gte: lo, lt: hi } }, select: { clubId: true, reportDate: true, managerName: true, lines: { where: { key: { in: [REVENUE_LINE_KEY, CASH_OOO_KEY, ENCASHMENT_KEY, SUBSCRIPTIONS_KEY, PERSONAL_TRAINING_KEY, REVENUE_IP_KEY] } }, select: { key: true, amountKopeks: true } } } }),
      prisma.expense.findMany({ where: { companyId, clubId: inClubs, status: "confirmed", expenseDate: { gte: lo, lt: hi } }, select: { clubId: true, category: true, amountKopeks: true, expenseDate: true, status: true } }),
      prisma.invoice.findMany({ where: { companyId, clubId: inClubs, status: "paid" }, select: { clubId: true, expenseCategory: true, amountKopeks: true, expensePeriod: true, paidAt: true, invoiceDate: true, createdAt: true, status: true } }),
      prisma.refund.findMany({ where: { companyId, clubId: inClubs, status: "paid" }, select: { clubId: true, amountKopeks: true, paidAt: true, refundDate: true, createdAt: true, status: true } }),
      prisma.budget.findMany({ where: { companyId, clubId: inClubs, month: { in: period.months } }, select: { clubId: true, category: true, limitAmountKopeks: true } }),
      prisma.salesPlan.findMany({ where: { companyId, month: { in: period.months } }, select: { clubId: true, planType: true, targetAmountKopeks: true } }),
      prisma.sale.count({ where: { companyId, clubId: inClubs, status: "pending_accountant" } }),
      prisma.invoice.aggregate({ where: { companyId, clubId: inClubs, status: { in: APPROVED_UNPAID } }, _sum: { amountKopeks: true } }),
      prisma.refund.aggregate({ where: { companyId, clubId: inClubs, status: { in: APPROVED_UNPAID } }, _sum: { amountKopeks: true } }),
    ]);

  // Fold confirmed daily-report revenue (total_revenue line) into sales events.
  const lineOf = (r: (typeof reports)[number], key: string) =>
    r.lines.find((l) => l.key === key)?.amountKopeks ?? 0;
  const reportSales = reports.map((r) => ({
    clubId: r.clubId,
    amountKopeks: lineOf(r, REVENUE_LINE_KEY),
    saleDate: r.reportDate,
  }));
  const reportCash = reports.map((r) => ({
    reportDate: r.reportDate,
    cashOooKopeks: lineOf(r, CASH_OOO_KEY),
    encashmentKopeks: lineOf(r, ENCASHMENT_KEY),
  }));
  const reportSplit = reports.map((r) => {
    const bd = getSalesReportFactBreakdown(r.lines);
    return {
      clubId: r.clubId,
      date: r.reportDate,
      managerName: r.managerName,
      total: bd.totalRevenue,
      subscriptions: bd.subscriptionsRevenue,
      personal_training: bd.personalTrainingRevenue,
    };
  });

  return {
    clubs,
    sales: [...sales, ...reportSales],
    expenses,
    invoices,
    refunds,
    budgets,
    plans,
    reportCash,
    reportSplit,
    pendingSalesCount,
    debtKopeks: (debtInvoices._sum.amountKopeks ?? 0) + (debtRefunds._sum.amountKopeks ?? 0),
  };
}

// --- events ----------------------------------------------------------------

type SalesEvent = { clubId: string; amountKopeks: number; date: Date };
type SpendEvent = { clubId: string; category: string; amountKopeks: number; date: Date };

function salesEvents(data: AnalyticsData): SalesEvent[] {
  return data.sales.map((s) => ({ clubId: s.clubId, amountKopeks: s.amountKopeks, date: s.saleDate }));
}

function spendEvents(data: AnalyticsData): SpendEvent[] {
  return [
    ...data.expenses.map((e) => ({ clubId: e.clubId, category: e.category, amountKopeks: e.amountKopeks, date: e.expenseDate })),
    // Invoices contribute to their accounting month (expensePeriod), not the
    // payment date.
    ...data.invoices.map((i) => ({ clubId: i.clubId, category: i.expenseCategory ?? "other", amountKopeks: i.amountKopeks, date: invoiceAnalyticsDate(i) })),
    ...data.refunds.map((r) => ({ clubId: r.clubId, category: "refunds", amountKopeks: r.amountKopeks, date: r.paidAt ?? r.refundDate ?? r.createdAt })),
  ];
}

function inRange(d: Date, start: Date, end: Date): boolean {
  const t = d.getTime();
  return t >= start.getTime() && t < end.getTime();
}

function sumInRange(events: Array<{ amountKopeks: number; date: Date }>, start: Date, end: Date): number {
  let s = 0;
  for (const e of events) if (inRange(e.date, start, end)) s += e.amountKopeks;
  return s;
}

function changePercent(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

// --- blocks ----------------------------------------------------------------

export type ExecutiveSummary = {
  salesKopeks: number;
  subscriptionsKopeks: number; // фактические продажи абонементов (confirmed reports)
  personalTrainingKopeks: number; // фактические продажи ПТ (ИП-выручка уже свёрнута сюда)
  expensesKopeks: number;
  budgetTotalKopeks: number; // план расходов (лимит бюджета за период); 0 если не задан
  profitKopeks: number;
  prevProfitKopeks: number;
  // Previous-period facts for the small KPI trend deltas (same windows).
  prevSubscriptionsKopeks: number;
  prevPersonalTrainingKopeks: number;
  prevExpensesKopeks: number;
  planTargetKopeks: number;
  planPercent: number | null;
  cashOooRemainingKopeks: number;
  // Долги / обязательства: approved-but-unpaid invoices + refunds (network debt).
  obligationsKopeks: number;
};

export type TrendGranularity = "day" | "week" | "month";

export type TrendBucket = { label: string; subLabel?: string; valueKopeks: number };

export type Trend = {
  buckets: TrendBucket[];
  currentKopeks: number;
  previousKopeks: number;
  changePercent: number | null;
};

// Dual-series sales dynamics: абонементы vs персональные тренировки per bucket.
// Built from confirmed daily reports (same source as the weekday/manager tables).
export type SplitTrendBucket = { label: string; subLabel?: string; subsKopeks: number; ptKopeks: number };
export type SalesSplitTrend = {
  buckets: SplitTrendBucket[];
  subsCurrentKopeks: number;
  ptCurrentKopeks: number;
};

export type ClubRankRow = {
  clubId: string;
  clubName: string;
  salesKopeks: number;
  expensesKopeks: number;
  profitKopeks: number;
  planPercent: number | null;
  budgetPercent: number | null;
};

export type PlanStatus = "ahead" | "near" | "behind";

export type PlanPerfRow = {
  clubId: string;
  clubName: string;
  planKopeks: number;
  factKopeks: number;
  differenceKopeks: number;
  completionPercent: number | null;
  status: PlanStatus;
};

export type PlanSplitCell = { planKopeks: number; factKopeks: number; percent: number | null };
// Company-wide plan/fact totals by direction, for the KPI plan-progress bars.
export type PlanTotals = { subscriptions: PlanSplitCell; personal_training: PlanSplitCell };
export type PlanSplitClubRow = {
  clubId: string;
  clubName: string;
  total: PlanSplitCell;
  subscriptions: PlanSplitCell;
  personal_training: PlanSplitCell;
};

export type WeekdayRow = {
  weekday: number; // Date.getDay()
  label: string;
  reportCount: number;
  totalKopeks: number;
  subscriptionsKopeks: number;
  personalTrainingKopeks: number;
  avgTotalKopeks: number;
  avgSubscriptionsKopeks: number;
  avgPersonalTrainingKopeks: number;
  // Best weekday is the one with the highest average total per report.
  isBest: boolean;
};

export type ManagerRow = {
  manager: string;
  reportCount: number;
  totalKopeks: number;
  subscriptionsKopeks: number;
  personalTrainingKopeks: number;
  avgTotalKopeks: number;
  avgSubscriptionsKopeks: number;
  avgPersonalTrainingKopeks: number;
  // Best manager is the one with the highest average total per shift.
  isBest: boolean;
};

export type TopExpenseRow = { category: string; label: string; amountKopeks: number; sharePercent: number };

export type CriticalZone = { tone: "red" | "amber"; text: string };

export type AnalyticsReport = {
  period: ResolvedPeriod;
  granularity: TrendGranularity;
  summary: ExecutiveSummary;
  salesTrend: Trend;
  salesSplitTrend: SalesSplitTrend;
  expenseTrend: Trend;
  profitTrend: Trend;
  clubRanking: ClubRankRow[];
  planPerformance: PlanPerfRow[];
  planSplitByClub: PlanSplitClubRow[];
  planTotals: PlanTotals;
  weekdaySales: WeekdayRow[];
  managerSales: ManagerRow[];
  budgetPerformance: BudgetFactReport;
  topExpenses: TopExpenseRow[];
  criticalZones: CriticalZone[];
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Ordered time buckets covering [start, end) at the given granularity. */
function makeBuckets(start: Date, end: Date, gran: TrendGranularity): Array<{ label: string; start: Date; end: Date }> {
  const out: Array<{ label: string; start: Date; end: Date }> = [];
  if (gran === "month") {
    const cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur.getTime() < end.getTime()) {
      const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      out.push({ label: `${pad(cur.getMonth() + 1)}.${cur.getFullYear()}`, start: new Date(cur), end: next });
      cur.setMonth(cur.getMonth() + 1);
    }
    return out;
  }
  const step = gran === "week" ? 7 : 1;
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  while (cur.getTime() < end.getTime()) {
    const next = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + step);
    const bEnd = next.getTime() < end.getTime() ? next : end;
    out.push({ label: `${pad(cur.getDate())}.${pad(cur.getMonth() + 1)}`, start: new Date(cur), end: bEnd });
    cur.setDate(cur.getDate() + step);
  }
  return out;
}

function buildTrend(events: SalesEvent[] | SpendEvent[], period: ResolvedPeriod, gran: TrendGranularity): Trend {
  const buckets = makeBuckets(period.start, period.end, gran).map((b) => ({
    label: b.label,
    subLabel: gran === "day" ? WEEKDAY_SHORT[b.start.getDay()] : undefined,
    valueKopeks: sumInRange(events, b.start, b.end),
  }));
  const currentKopeks = sumInRange(events, period.start, period.end);
  const previousKopeks = sumInRange(events, period.prevStart, period.prevEnd);
  return { buckets, currentKopeks, previousKopeks, changePercent: changePercent(currentKopeks, previousKopeks) };
}

/** Dual-series sales dynamics (абонементы / ПТ) from confirmed daily reports. */
function buildSalesSplitTrend(
  reportSplit: AnalyticsData["reportSplit"],
  period: ResolvedPeriod,
  gran: TrendGranularity,
): SalesSplitTrend {
  const buckets = makeBuckets(period.start, period.end, gran).map((b) => {
    let subsKopeks = 0;
    let ptKopeks = 0;
    for (const r of reportSplit) {
      if (inRange(r.date, b.start, b.end)) {
        subsKopeks += r.subscriptions;
        ptKopeks += r.personal_training;
      }
    }
    return { label: b.label, subLabel: gran === "day" ? WEEKDAY_SHORT[b.start.getDay()] : undefined, subsKopeks, ptKopeks };
  });
  const inPeriod = reportSplit.filter((r) => inRange(r.date, period.start, period.end));
  return {
    buckets,
    subsCurrentKopeks: inPeriod.reduce((s, r) => s + r.subscriptions, 0),
    ptCurrentKopeks: inPeriod.reduce((s, r) => s + r.personal_training, 0),
  };
}

function buildProfitTrend(sales: SalesEvent[], spend: SpendEvent[], period: ResolvedPeriod, gran: TrendGranularity): Trend {
  const buckets = makeBuckets(period.start, period.end, gran).map((b) => ({
    label: b.label,
    subLabel: gran === "day" ? WEEKDAY_SHORT[b.start.getDay()] : undefined,
    valueKopeks: sumInRange(sales, b.start, b.end) - sumInRange(spend, b.start, b.end),
  }));
  const cur = sumInRange(sales, period.start, period.end) - sumInRange(spend, period.start, period.end);
  const prev = sumInRange(sales, period.prevStart, period.prevEnd) - sumInRange(spend, period.prevStart, period.prevEnd);
  return { buckets, currentKopeks: cur, previousKopeks: prev, changePercent: changePercent(cur, prev) };
}

function planStatus(pct: number | null): PlanStatus {
  if (pct === null) return "behind";
  if (pct > 100) return "ahead";
  if (pct >= 80) return "near";
  return "behind";
}

/** Per-club overall (total) plan targets across the period months. */
function planByClub(data: AnalyticsData): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of data.plans) {
    if (!p.clubId || p.planType !== "total") continue;
    m.set(p.clubId, (m.get(p.clubId) ?? 0) + p.targetAmountKopeks);
  }
  return m;
}

function budgetByClub(data: AnalyticsData): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of data.budgets) m.set(b.clubId, (m.get(b.clubId) ?? 0) + b.limitAmountKopeks);
  return m;
}

/**
 * Compute the full analytics report. `opts.categories` restricts budget/expense
 * category output (marketer => ["advertising"]); `opts.financial` toggles the
 * money-heavy blocks for non-financial viewers.
 */
export function buildAnalyticsReport(
  data: AnalyticsData,
  period: ResolvedPeriod,
  granularity: TrendGranularity,
  opts?: { categories?: readonly string[] },
): AnalyticsReport {
  const sales = salesEvents(data);
  const spend = spendEvents(data);
  const allowed = opts?.categories ? new Set(opts.categories) : null;
  const spendForCats = allowed ? spend.filter((e) => allowed.has(e.category)) : spend;

  // Block 1: executive summary
  const curSales = sumInRange(sales, period.start, period.end);
  const curSpend = sumInRange(spendForCats, period.start, period.end);
  const prevSales = sumInRange(sales, period.prevStart, period.prevEnd);
  const prevSpend = sumInRange(spendForCats, period.prevStart, period.prevEnd);
  const planMap = planByClub(data);
  const sumPerClubPlan = [...planMap.values()].reduce((a, b) => a + b, 0);
  const companyWidePlan = data.plans.filter((p) => !p.clubId && p.planType === "total").reduce((a, b) => a + b.targetAmountKopeks, 0);
  const planTargetKopeks = sumPerClubPlan > 0 ? sumPerClubPlan : companyWidePlan;
  // Остаток наличности ООО за период: sum(cash_ooo − encashment_ooo) of confirmed reports.
  const cashOooRemainingKopeks = data.reportCash
    .filter((r) => inRange(r.reportDate, period.start, period.end))
    .reduce((s, r) => s + (r.cashOooKopeks - r.encashmentKopeks), 0);
  // Фактические продажи АБ / ПТ за период — из подтверждённых отчётов (тот же
  // источник, что у таблиц по дням/менеджерам). ИП-выручка уже свёрнута в ПТ.
  const splitInPeriod = data.reportSplit.filter((r) => inRange(r.date, period.start, period.end));
  const subscriptionsKopeks = splitInPeriod.reduce((s, r) => s + r.subscriptions, 0);
  const personalTrainingKopeks = splitInPeriod.reduce((s, r) => s + r.personal_training, 0);
  const splitInPrev = data.reportSplit.filter((r) => inRange(r.date, period.prevStart, period.prevEnd));
  const prevSubscriptionsKopeks = splitInPrev.reduce((s, r) => s + r.subscriptions, 0);
  const prevPersonalTrainingKopeks = splitInPrev.reduce((s, r) => s + r.personal_training, 0);
  // План расходов = сумма лимитов бюджета за месяцы периода (по разрешённым
  // категориям, если задано ограничение для маркетолога).
  const budgetTotalKopeks = (allowed ? data.budgets.filter((b) => allowed.has(b.category)) : data.budgets)
    .reduce((s, b) => s + b.limitAmountKopeks, 0);
  const summary: ExecutiveSummary = {
    salesKopeks: curSales,
    subscriptionsKopeks,
    personalTrainingKopeks,
    expensesKopeks: curSpend,
    budgetTotalKopeks,
    profitKopeks: curSales - curSpend,
    prevProfitKopeks: prevSales - prevSpend,
    prevSubscriptionsKopeks,
    prevPersonalTrainingKopeks,
    prevExpensesKopeks: prevSpend,
    planTargetKopeks,
    planPercent: planTargetKopeks > 0 ? (curSales / planTargetKopeks) * 100 : null,
    cashOooRemainingKopeks,
    obligationsKopeks: data.debtKopeks,
  };

  // Blocks 2/3/4: trends
  const salesTrend = buildTrend(sales, period, granularity);
  const salesSplitTrend = buildSalesSplitTrend(data.reportSplit, period, granularity);
  const expenseTrend = buildTrend(spendForCats, period, granularity);
  const profitTrend = buildProfitTrend(sales, spendForCats, period, granularity);

  // Block 5: club ranking
  const budgetMap = budgetByClub(data);
  const clubRanking: ClubRankRow[] = data.clubs
    .map((c) => {
      const cs = sumInRange(sales.filter((e) => e.clubId === c.id), period.start, period.end);
      const ce = sumInRange(spend.filter((e) => e.clubId === c.id), period.start, period.end);
      const plan = planMap.get(c.id) ?? 0;
      const budget = budgetMap.get(c.id) ?? 0;
      return {
        clubId: c.id,
        clubName: c.name,
        salesKopeks: cs,
        expensesKopeks: ce,
        profitKopeks: cs - ce,
        planPercent: plan > 0 ? (cs / plan) * 100 : null,
        budgetPercent: budget > 0 ? (ce / budget) * 100 : null,
      };
    })
    .sort((a, b) => b.profitKopeks - a.profitKopeks);

  // Block 6: sales plan performance
  const planPerformance: PlanPerfRow[] = data.clubs
    .map((c) => {
      const plan = planMap.get(c.id) ?? 0;
      const fact = sumInRange(sales.filter((e) => e.clubId === c.id), period.start, period.end);
      const completion = plan > 0 ? (fact / plan) * 100 : null;
      return { clubId: c.id, clubName: c.name, planKopeks: plan, factKopeks: fact, differenceKopeks: fact - plan, completionPercent: completion, status: planStatus(completion) };
    })
    .filter((r) => r.planKopeks > 0 || r.factKopeks > 0)
    .sort((a, b) => (b.completionPercent ?? -1) - (a.completionPercent ?? -1));

  // Block 6b: plan/fact split by type per club (общий / абонементы / персональные).
  // Plan from per-club SalesPlan rows by type; fact from confirmed daily reports.
  const cell = (planK: number, factK: number): PlanSplitCell => ({
    planKopeks: planK,
    factKopeks: factK,
    percent: planK > 0 ? (factK / planK) * 100 : null,
  });
  type SplitAcc = { total: number; subscriptions: number; personal_training: number };
  const planByClubType = new Map<string, SplitAcc>();
  for (const p of data.plans) {
    if (!p.clubId) continue;
    const acc = planByClubType.get(p.clubId) ?? { total: 0, subscriptions: 0, personal_training: 0 };
    if (p.planType === "total") acc.total += p.targetAmountKopeks;
    else if (p.planType === "subscriptions") acc.subscriptions += p.targetAmountKopeks;
    else if (p.planType === "personal_training") acc.personal_training += p.targetAmountKopeks;
    planByClubType.set(p.clubId, acc);
  }
  const factByClubType = new Map<string, SplitAcc>();
  for (const r of data.reportSplit) {
    if (!inRange(r.date, period.start, period.end)) continue;
    const acc = factByClubType.get(r.clubId) ?? { total: 0, subscriptions: 0, personal_training: 0 };
    acc.total += r.total;
    acc.subscriptions += r.subscriptions;
    acc.personal_training += r.personal_training;
    factByClubType.set(r.clubId, acc);
  }
  const zeroAcc: SplitAcc = { total: 0, subscriptions: 0, personal_training: 0 };
  const planSplitByClub: PlanSplitClubRow[] = data.clubs
    .map((c) => {
      const pl = planByClubType.get(c.id) ?? zeroAcc;
      const fa = factByClubType.get(c.id) ?? zeroAcc;
      return {
        clubId: c.id,
        clubName: c.name,
        total: cell(pl.total, fa.total),
        subscriptions: cell(pl.subscriptions, fa.subscriptions),
        personal_training: cell(pl.personal_training, fa.personal_training),
      };
    })
    .filter(
      (r) =>
        r.total.planKopeks > 0 || r.total.factKopeks > 0 ||
        r.subscriptions.planKopeks > 0 || r.subscriptions.factKopeks > 0 ||
        r.personal_training.planKopeks > 0 || r.personal_training.factKopeks > 0,
    );

  // Company-wide plan/fact by direction for the KPI progress bars (same per-club
  // SalesPlan source as planSplitByClub; fact reuses the period subs/PT totals).
  let planSubsTarget = 0;
  let planPtTarget = 0;
  for (const acc of planByClubType.values()) {
    planSubsTarget += acc.subscriptions;
    planPtTarget += acc.personal_training;
  }
  const planTotals: PlanTotals = {
    subscriptions: cell(planSubsTarget, subscriptionsKopeks),
    personal_training: cell(planPtTarget, personalTrainingKopeks),
  };

  // Confirmed daily reports in the current period, split into total / subs / PT.
  const reportsInPeriod = data.reportSplit.filter((r) => inRange(r.date, period.start, period.end));
  type SalesAcc = { count: number; total: number; subs: number; pt: number };
  const accumulate = (rows: typeof reportsInPeriod): SalesAcc => {
    const a: SalesAcc = { count: 0, total: 0, subs: 0, pt: 0 };
    for (const r of rows) {
      a.count += 1;
      a.total += r.total;
      a.subs += r.subscriptions;
      a.pt += r.personal_training;
    }
    return a;
  };
  const avg = (sum: number, count: number) => (count > 0 ? Math.round(sum / count) : 0);

  // Sales by weekday. Best weekday = highest AVERAGE total per report.
  const weekdayAcc = new Map<number, SalesAcc>();
  for (const r of reportsInPeriod) {
    const wd = r.date.getDay();
    const a = weekdayAcc.get(wd) ?? { count: 0, total: 0, subs: 0, pt: 0 };
    a.count += 1;
    a.total += r.total;
    a.subs += r.subscriptions;
    a.pt += r.personal_training;
    weekdayAcc.set(wd, a);
  }
  const bestWeekdayAvg = Math.max(0, ...[...weekdayAcc.values()].map((a) => avg(a.total, a.count)));
  const weekdaySales: WeekdayRow[] = WEEKDAY_FULL_MON_FIRST.map(({ day, label }) => {
    const a = weekdayAcc.get(day) ?? { count: 0, total: 0, subs: 0, pt: 0 };
    const avgTotal = avg(a.total, a.count);
    return {
      weekday: day,
      label,
      reportCount: a.count,
      totalKopeks: a.total,
      subscriptionsKopeks: a.subs,
      personalTrainingKopeks: a.pt,
      avgTotalKopeks: avgTotal,
      avgSubscriptionsKopeks: avg(a.subs, a.count),
      avgPersonalTrainingKopeks: avg(a.pt, a.count),
      isBest: a.count > 0 && avgTotal === bestWeekdayAvg,
    };
  });

  // Sales by manager. Best manager + sort key = highest AVERAGE total per shift
  // (NOT total revenue); ties broken by total revenue desc.
  const managerAcc = new Map<string, SalesAcc>();
  for (const r of reportsInPeriod) {
    const name = r.managerName?.trim() || "Не указан";
    const a = managerAcc.get(name) ?? { count: 0, total: 0, subs: 0, pt: 0 };
    a.count += 1;
    a.total += r.total;
    a.subs += r.subscriptions;
    a.pt += r.personal_training;
    managerAcc.set(name, a);
  }
  const managerRows = [...managerAcc.entries()].map(([manager, a]) => ({
    manager,
    reportCount: a.count,
    totalKopeks: a.total,
    subscriptionsKopeks: a.subs,
    personalTrainingKopeks: a.pt,
    avgTotalKopeks: avg(a.total, a.count),
    avgSubscriptionsKopeks: avg(a.subs, a.count),
    avgPersonalTrainingKopeks: avg(a.pt, a.count),
  }));
  const bestManagerAvg = Math.max(0, ...managerRows.map((m) => m.avgTotalKopeks));
  const managerSales: ManagerRow[] = managerRows
    .map((m) => ({ ...m, isBest: m.avgTotalKopeks === bestManagerAvg && m.reportCount > 0 }))
    .sort((x, y) => y.avgTotalKopeks - x.avgTotalKopeks || y.totalKopeks - x.totalKopeks);

  // Block 7: budget performance (reuse existing budget report for the period's month)
  const budgetPerformance = computeBudgetFactReport(
    data.budgets,
    { expenses: data.expenses, invoices: data.invoices, refunds: data.refunds },
    period.primaryMonth,
    opts?.categories ? { categories: opts.categories } : undefined,
  );

  // Block 8: top expenses by category
  const byCat = new Map<string, number>();
  for (const e of spendForCats) if (inRange(e.date, period.start, period.end)) byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amountKopeks);
  const totalSpend = [...byCat.values()].reduce((a, b) => a + b, 0);
  const topExpenses: TopExpenseRow[] = [...byCat.entries()]
    .map(([category, amountKopeks]) => ({ category, label: expenseCategoryLabel(category), amountKopeks, sharePercent: totalSpend > 0 ? (amountKopeks / totalSpend) * 100 : 0 }))
    .sort((a, b) => b.amountKopeks - a.amountKopeks)
    .slice(0, 10);

  // Block 9: critical zones
  const criticalZones: CriticalZone[] = [];
  for (const r of planPerformance) {
    if (r.completionPercent !== null && r.completionPercent < 50) {
      criticalZones.push({ tone: "red", text: `${r.clubName}: ${r.completionPercent.toFixed(0)}% плана` });
    }
  }
  for (const b of budgetPerformance) {
    if (b.completionPercent > 100) {
      criticalZones.push({ tone: "red", text: `${b.label}: ${b.completionPercent.toFixed(0)}% бюджета` });
    }
  }
  if (!allowed) {
    if (data.debtKopeks > 0) criticalZones.push({ tone: "amber", text: `Задолженность по сети: ${Math.round(data.debtKopeks / 100).toLocaleString("ru-RU")} ₽` });
    if (data.pendingSalesCount >= 3) criticalZones.push({ tone: "amber", text: `Продаж на проверке: ${data.pendingSalesCount}` });
  }

  return {
    period,
    granularity,
    summary,
    salesTrend,
    salesSplitTrend,
    expenseTrend,
    profitTrend,
    clubRanking,
    planPerformance,
    planSplitByClub,
    planTotals,
    weekdaySales,
    managerSales,
    budgetPerformance,
    topExpenses,
    criticalZones,
  };
}
