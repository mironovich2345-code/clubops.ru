import { prisma } from "@/lib/prisma";

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
