// Prefill payroll calculation bases from EXISTING sales data (spec §13). Plan and fact
// are club-level and already split by direction (subscriptions vs personal training),
// which is exactly what the manager plan-fact / revenue-% schemes need. Personal-sales
// commission is NOT prefilled — there is no per-employee sales attribution in the data,
// so it stays a manual input.
import { getSalesPlansForCompanyMonth, planTotalsByType, getConfirmedReportFactTotals } from "@/lib/sales-plans";

export type PlanFactBases = {
  subscriptions: { planKopeks: number; factKopeks: number };
  personalTraining: { planKopeks: number; factKopeks: number };
  hasPlan: boolean;
  hasFact: boolean;
};

/** Club subscriptions/PT plan + confirmed-report fact for a month, split by direction. */
export async function getClubPlanFactBases(
  companyId: string,
  clubId: string,
  year: number,
  month: number,
): Promise<PlanFactBases> {
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const [plans, fact] = await Promise.all([
    getSalesPlansForCompanyMonth(companyId, monthKey),
    getConfirmedReportFactTotals(companyId, [clubId], monthKey),
  ]);
  const plan = planTotalsByType(plans, [clubId]);
  return {
    subscriptions: { planKopeks: plan.subscriptions, factKopeks: fact.subscriptions },
    personalTraining: { planKopeks: plan.personal_training, factKopeks: fact.personal_training },
    hasPlan: plan.subscriptions > 0 || plan.personal_training > 0,
    hasFact: fact.subscriptions > 0 || fact.personal_training > 0,
  };
}
