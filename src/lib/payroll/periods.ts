// PayrollPeriod (per club+month) + PayrollCalculation persistence helpers. A period
// aggregates one calculation per employee. Each calculation SNAPSHOTS the pay scheme
// at generation time (schemeSnapshotJson) so later scheme edits never change it, and a
// closed month can never be recomputed.
import type { PayrollCalculation, PayrollPeriod, EmployeePayScheme } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validateSchemeParams, type SchemeParams } from "@/lib/payroll/scheme";
import { PAYROLL_PERIOD_STATUS_LABELS } from "@/lib/payroll/enums";

export const MONTH_NAMES_RU = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

export function periodLabel(p: Pick<PayrollPeriod, "year" | "month">): string {
  return `${MONTH_NAMES_RU[p.month - 1] ?? p.month} ${p.year}`;
}
export function periodStatusLabel(status: string): string {
  return PAYROLL_PERIOD_STATUS_LABELS[status] ?? status;
}

/** Shape stored in PayrollCalculation.schemeSnapshotJson. */
export type SchemeSnapshot = {
  schemeId: string;
  schemeType: string;
  params: Record<string, unknown>;
  effectiveFrom: string;
};

export function makeSchemeSnapshot(scheme: EmployeePayScheme): SchemeSnapshot {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(scheme.paramsJson) as Record<string, unknown>;
  } catch {
    params = {};
  }
  return { schemeId: scheme.id, schemeType: scheme.schemeType, params, effectiveFrom: scheme.effectiveFrom.toISOString() };
}

/** Re-validate a stored snapshot into a typed SchemeParams for the engine. */
export function snapshotToSchemeParams(snapshotJson: string | null): SchemeParams | null {
  if (!snapshotJson) return null;
  let snap: SchemeSnapshot;
  try {
    snap = JSON.parse(snapshotJson) as SchemeSnapshot;
  } catch {
    return null;
  }
  const res = validateSchemeParams(snap.schemeType, snap.params);
  return res.ok ? res.scheme : null;
}

/** Periods for the scope (club-filtered), newest first. */
export async function getPeriodsForScope(companyId: string, clubIds: string[]): Promise<PayrollPeriod[]> {
  if (clubIds.length === 0) return [];
  return prisma.payrollPeriod.findMany({
    where: { companyId, clubId: { in: clubIds } },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });
}

/** A single period scoped to company + accessible clubs. */
export async function getPeriodForScope(
  companyId: string,
  clubIds: string[],
  id: string,
): Promise<PayrollPeriod | null> {
  const p = await prisma.payrollPeriod.findUnique({ where: { id } });
  if (!p || p.companyId !== companyId || !clubIds.includes(p.clubId)) return null;
  return p;
}

export async function getCalculations(periodId: string): Promise<PayrollCalculation[]> {
  return prisma.payrollCalculation.findMany({ where: { payrollPeriodId: periodId }, orderBy: [{ createdAt: "asc" }] });
}

export type PeriodTotals = {
  count: number;
  grossAccruedKopeks: number;
  netPayableKopeks: number;
  paidKopeks: number;
  remainingKopeks: number;
  needsReview: number;
};

/** Pure roll-up of a period's calculations. */
export function periodTotals(calcs: readonly PayrollCalculation[]): PeriodTotals {
  return calcs.reduce<PeriodTotals>(
    (t, c) => ({
      count: t.count + 1,
      grossAccruedKopeks: t.grossAccruedKopeks + c.grossAccruedKopeks,
      netPayableKopeks: t.netPayableKopeks + c.netPayableKopeks,
      paidKopeks: t.paidKopeks + c.paidKopeks,
      remainingKopeks: t.remainingKopeks + c.remainingKopeks,
      needsReview: t.needsReview + (needsReview(c) ? 1 : 0),
    }),
    { count: 0, grossAccruedKopeks: 0, netPayableKopeks: 0, paidKopeks: 0, remainingKopeks: 0, needsReview: 0 },
  );
}

function needsReview(c: PayrollCalculation): boolean {
  if (!c.detailsJson) return false;
  try {
    const d = JSON.parse(c.detailsJson) as { flags?: { needsManualReview?: boolean } };
    return Boolean(d.flags?.needsManualReview);
  } catch {
    return false;
  }
}
