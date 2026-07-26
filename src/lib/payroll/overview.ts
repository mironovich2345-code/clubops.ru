// Read-only aggregator for the payroll «Обзор». Reuses existing scope/period/obligation
// helpers — NO new business logic, NO writes. Money = integer kopeks.
import { prisma } from "@/lib/prisma";
import { getEmployeesForScope } from "@/lib/club-employees";
import { getSchemesForEmployee, resolveEffectiveScheme } from "@/lib/payroll/schemes";
import { getPeriodsForScope } from "@/lib/payroll/periods";
import { getOpenObligationsForScope } from "@/lib/payroll/obligations";

export type PayrollOverview = {
  month: string; // YYYY-MM
  employeesActive: number;
  employeesWithScheme: number;
  employeesNotConfigured: number;
  periodsDraft: number;
  periodsOnReview: number;
  periodsNeedsDecision: number;
  accruedKopeks: number;
  paidKopeks: number;
  remainingKopeks: number;
  activeDebtsCount: number;
  activeDebtsKopeks: number;
  advancesCount: number;
  advancesKopeks: number;
};

const ON_REVIEW = new Set(["manager_submitted", "regional_review", "regional_approved", "accounting_review"]);
const NEEDS_DECISION = new Set(["needs_correction"]);

/** Aggregate the payroll dashboard for a company + accessible clubs + a month (YYYY-MM). */
export async function loadPayrollOverview(companyId: string, clubIds: string[], month: string, now: Date = new Date()): Promise<PayrollOverview> {
  const [yStr, mStr] = month.split("-");
  const year = Number(yStr) || now.getFullYear();
  const monthNum = Number(mStr) || now.getMonth() + 1;

  const employees = clubIds.length ? await getEmployeesForScope(companyId, clubIds, { status: "active" }) : [];
  let withScheme = 0;
  await Promise.all(
    employees.map(async (e) => {
      const schemes = await getSchemesForEmployee(companyId, e.id);
      if (resolveEffectiveScheme(schemes, now)) withScheme += 1;
    }),
  );

  const periods = clubIds.length ? await getPeriodsForScope(companyId, clubIds) : [];
  const monthPeriods = periods.filter((p) => p.year === year && p.month === monthNum);
  const periodsDraft = periods.filter((p) => p.status === "draft").length;
  const periodsOnReview = periods.filter((p) => ON_REVIEW.has(p.status)).length;
  const periodsNeedsDecision = periods.filter((p) => NEEDS_DECISION.has(p.status)).length;

  // Money for the selected month (calculations of the month's periods).
  const monthPeriodIds = monthPeriods.map((p) => p.id);
  const calcAgg = monthPeriodIds.length
    ? await prisma.payrollCalculation.aggregate({
        where: { payrollPeriodId: { in: monthPeriodIds } },
        _sum: { grossAccruedKopeks: true, paidKopeks: true, remainingKopeks: true },
      })
    : { _sum: { grossAccruedKopeks: 0, paidKopeks: 0, remainingKopeks: 0 } };

  const obligations = clubIds.length ? await getOpenObligationsForScope(companyId, clubIds) : [];
  const activeDebtsKopeks = obligations.reduce((s, o) => s + (o.outstandingAmountKopeks ?? 0), 0);

  const advances = clubIds.length
    ? await prisma.payrollAdvance.findMany({ where: { companyId, clubId: { in: clubIds }, periodYear: year, periodMonth: monthNum, status: "paid" }, select: { amountKopeks: true } })
    : [];

  return {
    month,
    employeesActive: employees.length,
    employeesWithScheme: withScheme,
    employeesNotConfigured: employees.length - withScheme,
    periodsDraft,
    periodsOnReview,
    periodsNeedsDecision,
    accruedKopeks: calcAgg._sum.grossAccruedKopeks ?? 0,
    paidKopeks: calcAgg._sum.paidKopeks ?? 0,
    remainingKopeks: calcAgg._sum.remainingKopeks ?? 0,
    activeDebtsCount: obligations.length,
    activeDebtsKopeks,
    advancesCount: advances.length,
    advancesKopeks: advances.reduce((s, a) => s + a.amountKopeks, 0),
  };
}
