"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, getUserClubs, canAccessClub, recordAudit } from "@/lib/access";
import { monthClosedError } from "@/lib/month-close";
import { rublesToKopeks } from "@/lib/money";
import { canManagePayrollAssignments } from "@/lib/payroll/access";
import { getEffectiveSchemeForEmployee } from "@/lib/payroll/schemes";
import { makeSchemeSnapshot, snapshotToSchemeParams, getPeriodForScope } from "@/lib/payroll/periods";
import { computeScheme, type PeriodInput } from "@/lib/payroll/compute";
import { isPayrollPeriodLocked } from "@/lib/payroll/period";
import { BP_PER_100_PERCENT } from "@/lib/payroll/enums";

export type PayrollPeriodFormState = { ok: boolean; error?: string; fieldErrors?: Record<string, string>; periodId?: string };

async function accessibleClubIds(userId: string, companyId: string): Promise<string[]> {
  return (await getUserClubs(userId, companyId)).map((c) => c.id);
}
const fail = (error: string): PayrollPeriodFormState => ({ ok: false, error });

const rub = (fd: FormData, name: string): number => {
  const raw = String(fd.get(name) ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const n = raw === "" ? 0 : Number(raw);
  return Number.isFinite(n) ? rublesToKopeks(n) : 0;
};
const int = (fd: FormData, name: string): number => {
  const n = Number(String(fd.get(name) ?? "").trim());
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/** Create a draft payroll period for a club + month (unique per club+year+month). */
export async function createPayrollPeriod(
  _prev: PayrollPeriodFormState | undefined,
  formData: FormData,
): Promise<PayrollPeriodFormState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return fail("Нет доступа");
  if (!canManagePayrollAssignments(ctx.effectiveRoles)) return fail("Недостаточно прав");
  const companyId = ctx.selectedCompanyId;
  const clubIds = await accessibleClubIds(ctx.user.id, companyId);

  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId || !clubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, fieldErrors: { clubId: "Нет доступа к выбранному клубу" } };
  }
  const monthRaw = String(formData.get("month") ?? "").trim();
  const m = /^(\d{4})-(\d{2})$/.exec(monthRaw);
  if (!m) return { ok: false, fieldErrors: { month: "Укажите месяц" } };
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return { ok: false, fieldErrors: { month: "Неверный месяц" } };

  const firstDay = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const closed = await monthClosedError(companyId, clubId, firstDay);
  if (closed) return fail(closed);

  const existing = await prisma.payrollPeriod.findFirst({
    where: { companyId, clubId, year, month },
    select: { id: true },
  });
  if (existing) return { ok: true, periodId: existing.id };

  const period = await prisma.payrollPeriod.create({
    data: { companyId, clubId, year, month, status: "draft", createdByUserId: ctx.user.id },
  });
  try {
    await recordAudit({
      action: "payroll.period_created",
      entityType: "PayrollPeriod",
      entityId: period.id,
      companyId,
      clubId,
      userId: ctx.user.id,
      metadata: { year, month },
    });
  } catch {
    /* ignore */
  }
  revalidatePath("/payroll/periods");
  return { ok: true, periodId: period.id };
}

async function resolvePeriodScope(periodId: string) {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false as const, error: "Нет доступа" };
  const companyId = ctx.selectedCompanyId;
  const clubIds = await accessibleClubIds(ctx.user.id, companyId);
  const period = await getPeriodForScope(companyId, clubIds, periodId);
  if (!period) return { ok: false as const, error: "Расчётный период не найден" };
  return { ok: true as const, ctx, companyId, period };
}

/**
 * Seed one PayrollCalculation per active employee assigned to the period's club,
 * snapshotting the pay scheme in effect for that month. Idempotent (upsert on
 * period+employee). Blocked once the period is locked.
 */
export async function generateCalculations(formData: FormData): Promise<void> {
  const periodId = String(formData.get("periodId") ?? "").trim();
  const scope = await resolvePeriodScope(periodId);
  if (!scope.ok) return;
  if (!canManagePayrollAssignments(scope.ctx.effectiveRoles)) return;
  if (isPayrollPeriodLocked(scope.period.status)) return;

  const { companyId, period } = scope;
  const firstDay = new Date(period.year, period.month - 1, 1, 0, 0, 0, 0);
  const assignments = await prisma.employeeClubAssignment.findMany({
    where: { companyId, clubId: period.clubId, isActive: true },
  });
  // One calculation per employee (first active assignment wins for the role snapshot).
  const byEmployee = new Map<string, string>();
  for (const a of assignments) if (!byEmployee.has(a.employeeId)) byEmployee.set(a.employeeId, a.position);

  let created = 0;
  for (const [employeeId, position] of byEmployee) {
    const employee = await prisma.clubEmployee.findUnique({ where: { id: employeeId } });
    if (!employee || employee.companyId !== companyId || employee.status !== "active") continue;

    const scheme = await getEffectiveSchemeForEmployee(companyId, period.clubId, employeeId, firstDay);
    const snapshot = scheme ? makeSchemeSnapshot(scheme) : null;
    const details = { breakdown: [] as unknown[], flags: {}, warnings: scheme ? [] : ["Схема оплаты не задана на этот месяц."] };

    await prisma.payrollCalculation.upsert({
      where: { payrollPeriodId_employeeId: { payrollPeriodId: period.id, employeeId } },
      create: {
        companyId,
        payrollPeriodId: period.id,
        employeeId,
        clubId: period.clubId,
        legalEntityId: employee.defaultLegalEntityId ?? null,
        roleSnapshot: position,
        schemeSnapshotJson: snapshot ? JSON.stringify(snapshot) : null,
        status: "draft",
        detailsJson: JSON.stringify(details),
      },
      // Never overwrite inputs on re-generate; only refresh the scheme snapshot while
      // still a draft (keeps historical calcs stable, refreshes newly-set schemes).
      update: scheme ? { schemeSnapshotJson: JSON.stringify(snapshot) } : {},
    });
    created += 1;
  }
  try {
    await recordAudit({
      action: "payroll.calculations_generated",
      entityType: "PayrollPeriod",
      entityId: period.id,
      companyId,
      clubId: period.clubId,
      userId: scope.ctx.user.id,
      metadata: { employees: created },
    });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/periods/${period.id}`);
}

/** Read period inputs from the form for a given scheme type. */
function collectPeriodInput(schemeType: string, fd: FormData): PeriodInput {
  switch (schemeType) {
    case "salary_by_shifts":
      return { actualShifts: int(fd, "actualShifts") };
    case "salary_plus_percentage":
      return {
        actualShifts: int(fd, "actualShifts"),
        netPersonalSalesKopeks: rub(fd, "netPersonalSales"),
        planMet: String(fd.get("planMet") ?? "") === "on",
      };
    case "sales_percentage":
      return { salesKopeks: rub(fd, "sales") };
    case "hourly":
      return { hours: int(fd, "hours") };
    case "plan_adjusted_salary":
      return {
        subscriptions: { planKopeks: rub(fd, "subsPlan"), factKopeks: rub(fd, "subsFact") },
        personalTraining: { planKopeks: rub(fd, "ptPlan"), factKopeks: rub(fd, "ptFact") },
      };
    case "revenue_percentage":
      return { subscriptionsRevenueKopeks: rub(fd, "subsRevenue"), ptRevenueKopeks: rub(fd, "ptRevenue") };
    case "profit_percentage":
      return { cityProfitKopeks: rub(fd, "cityProfit") };
    case "mixed":
      return { manualAmountKopeks: rub(fd, "manualAmount") };
    default:
      return {};
  }
}

/**
 * Enter/refresh the period inputs for one calculation and recompute the automatic
 * amount from the SNAPSHOT scheme (not the live scheme). No adjustments/payments yet
 * (Stages 4–5). Blocked once the period is locked.
 */
export async function saveCalculationInputs(
  _prev: PayrollPeriodFormState | undefined,
  formData: FormData,
): Promise<PayrollPeriodFormState> {
  const calculationId = String(formData.get("calculationId") ?? "").trim();
  const calc = await prisma.payrollCalculation.findUnique({ where: { id: calculationId } });
  if (!calc) return fail("Расчёт не найден");
  const scope = await resolvePeriodScope(calc.payrollPeriodId);
  if (!scope.ok) return fail(scope.error);
  if (!canManagePayrollAssignments(scope.ctx.effectiveRoles)) return fail("Недостаточно прав");
  if (isPayrollPeriodLocked(scope.period.status)) return fail("Период закрыт для изменений расчёта");

  const scheme = snapshotToSchemeParams(calc.schemeSnapshotJson);
  if (!scheme) return fail("Схема оплаты не зафиксирована для этого расчёта. Сначала задайте схему и пересоздайте расчёт.");

  const input = collectPeriodInput(scheme.type, formData);
  const result = computeScheme(scheme, input);

  // Stage 3: no adjustments/payments yet → gross = net = automatic, all unpaid.
  const automatic = result.amountKopeks;
  const planKopeks =
    scheme.type === "plan_adjusted_salary"
      ? (input.subscriptions?.planKopeks ?? 0) + (input.personalTraining?.planKopeks ?? 0)
      : null;
  const actualKopeks =
    scheme.type === "plan_adjusted_salary"
      ? (input.subscriptions?.factKopeks ?? 0) + (input.personalTraining?.factKopeks ?? 0)
      : null;
  const completionBp = planKopeks && planKopeks > 0 ? Math.round(((actualKopeks ?? 0) / planKopeks) * BP_PER_100_PERCENT) : null;

  await prisma.payrollCalculation.update({
    where: { id: calc.id },
    data: {
      shifts: input.actualShifts ?? null,
      hours: input.hours ?? null,
      salesBaseKopeks: input.netPersonalSalesKopeks ?? input.salesKopeks ?? 0,
      revenueBaseKopeks: (input.subscriptionsRevenueKopeks ?? 0) + (input.ptRevenueKopeks ?? 0),
      profitBaseKopeks: input.cityProfitKopeks ?? 0,
      planKopeks,
      actualKopeks,
      completionBp,
      automaticAmountKopeks: automatic,
      grossAccruedKopeks: automatic,
      netPayableKopeks: automatic,
      paidKopeks: 0,
      remainingKopeks: automatic,
      employeeDebtKopeks: 0,
      companyDebtKopeks: automatic > 0 ? automatic : 0,
      status: "calculated",
      calculatedAt: new Date(),
      detailsJson: JSON.stringify({ breakdown: result.breakdown, flags: result.flags, warnings: result.warnings }),
    },
  });
  try {
    await recordAudit({
      action: "payroll.calculation_computed",
      entityType: "PayrollCalculation",
      entityId: calc.id,
      companyId: scope.companyId,
      clubId: calc.clubId,
      userId: scope.ctx.user.id,
      metadata: { automaticKopeks: automatic, schemeType: scheme.type },
    });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/periods/${calc.payrollPeriodId}`);
  return { ok: true, periodId: calc.payrollPeriodId };
}
