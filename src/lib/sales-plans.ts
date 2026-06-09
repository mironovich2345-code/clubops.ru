import { prisma } from "@/lib/prisma";
import { getSalesReportFactBreakdown, FACT_BREAKDOWN_KEYS } from "@/lib/sales-report-rows";

// Monthly sales targets (план продаж). A plan is keyed by company + club (null =
// company-wide) + month ("YYYY-MM"). Only the general director sets them
// (capability "sales_plan.manage"); everyone scoped can view plan-vs-fact.

/** "YYYY-MM" for the given date. */
export function monthKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Valid "YYYY-MM" or null. */
export function normalizeMonth(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}$/.test(value) ? value : null;
}

/** The plan for a company + club (null = company-wide) + month, or null. */
export async function getSalesPlan(
  companyId: string,
  clubId: string | null,
  month: string,
): Promise<{ id: string; targetAmountKopeks: number } | null> {
  const plan = await prisma.salesPlan.findFirst({
    where: { companyId, clubId, month },
    select: { id: true, targetAmountKopeks: true },
  });
  return plan;
}

/** All plans (company-wide + per-club) for a company in a month. */
export async function getSalesPlansForCompanyMonth(
  companyId: string,
  month: string,
): Promise<Array<{ clubId: string | null; planType: string; targetAmountKopeks: number }>> {
  return prisma.salesPlan.findMany({
    where: { companyId, month },
    select: { clubId: true, planType: true, targetAmountKopeks: true },
  });
}

// --- Plan types -------------------------------------------------------------

export type PlanType = "total" | "subscriptions" | "personal_training";

// Each plan type maps to a confirmed sales-report line for the "fact".
export const PLAN_TYPES: ReadonlyArray<{ key: PlanType; label: string; factKey: string }> = [
  { key: "total", label: "Общий план", factKey: "total_revenue" },
  { key: "subscriptions", label: "Абонементы", factKey: "subscriptions_ooo" },
  { key: "personal_training", label: "Персональные", factKey: "personal_training_total" },
];
export const PLAN_TYPE_KEYS: PlanType[] = PLAN_TYPES.map((t) => t.key);
export const PLAN_FACT_KEYS = PLAN_TYPES.map((t) => t.factKey);

export function isPlanType(v: string): v is PlanType {
  return v === "total" || v === "subscriptions" || v === "personal_training";
}

export type PlanTotals = Record<PlanType, number>;
const emptyTotals = (): PlanTotals => ({ total: 0, subscriptions: 0, personal_training: 0 });

/** Per-type plan totals for the scope's clubs; company-wide total is a fallback. */
export function planTotalsByType(
  plans: Array<{ clubId: string | null; planType: string; targetAmountKopeks: number }>,
  scopeClubIds: string[],
): PlanTotals {
  const set = new Set(scopeClubIds);
  const out = emptyTotals();
  for (const p of plans) {
    if (p.clubId && set.has(p.clubId) && isPlanType(p.planType)) out[p.planType] += p.targetAmountKopeks;
  }
  if (out.total === 0) {
    out.total = plans
      .filter((p) => !p.clubId && p.planType === "total")
      .reduce((a, b) => a + b.targetAmountKopeks, 0);
  }
  return out;
}

function monthBounds(month: string): { start: Date; end: Date } | null {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: new Date(y, mo, 1), end: new Date(y, mo + 1, 1) };
}

/**
 * Confirmed-report facts per plan direction for a month. Uses the shared
 * breakdown so ИП revenue counts as personal training:
 *   total            = total_revenue
 *   subscriptions    = subscriptions_ooo
 *   personal_training = personal_training_total + revenue_ip
 */
export async function getConfirmedReportFactTotals(
  companyId: string,
  clubIds: string[],
  month: string,
): Promise<PlanTotals> {
  const out = emptyTotals();
  const b = monthBounds(month);
  if (clubIds.length === 0 || !b) return out;
  const reports = await prisma.salesReport.findMany({
    where: { companyId, clubId: { in: clubIds }, status: "confirmed", reportDate: { gte: b.start, lt: b.end } },
    select: { lines: { where: { key: { in: FACT_BREAKDOWN_KEYS } }, select: { key: true, amountKopeks: true } } },
  });
  for (const r of reports) {
    const bd = getSalesReportFactBreakdown(r.lines);
    out.total += bd.totalRevenue;
    out.subscriptions += bd.subscriptionsRevenue;
    out.personal_training += bd.personalTrainingRevenue;
  }
  return out;
}

export type SalesPlanProgress = {
  planKopeks: number;
  factKopeks: number;
  /** fact / plan * 100, or null when there is no positive plan. */
  percent: number | null;
};

export function salesPlanProgress(planKopeks: number, factKopeks: number): SalesPlanProgress {
  return {
    planKopeks,
    factKopeks,
    percent: planKopeks > 0 ? (factKopeks / planKopeks) * 100 : null,
  };
}
