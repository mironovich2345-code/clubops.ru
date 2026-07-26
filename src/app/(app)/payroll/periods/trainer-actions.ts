"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, getUserClubs, recordAudit } from "@/lib/access";
import { monthClosedError } from "@/lib/month-close";
import { rublesToKopeks } from "@/lib/money";
import { canManagePayrollAssignments, canAddPayrollAdjustment } from "@/lib/payroll/access";
import { getPeriodForScope, snapshotToSchemeParams } from "@/lib/payroll/periods";
import { effectiveSchemeParams } from "@/lib/payroll/change-request";
import { computeScheme } from "@/lib/payroll/compute";
import { toGymPackage, computeTrainerSummary } from "@/lib/payroll/trainer";
import { recomputeCalculationTotals } from "@/lib/payroll/aggregate";
import { isPayrollPeriodLocked, isPayrollPeriodClosed } from "@/lib/payroll/period";

export type TrainerState = { ok: boolean; error?: string; notice?: string };
const fail = (error: string): TrainerState => ({ ok: false, error });
const rub = (fd: FormData, n: string): number => {
  const raw = String(fd.get(n) ?? "").trim().replace(/\s/g, "").replace(",", ".");
  return raw === "" ? 0 : Math.max(0, Math.round(Number(raw) * 100) || 0);
};
const int = (fd: FormData, n: string): number => {
  const v = Number(String(fd.get(n) ?? "").trim());
  return Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
};
const pctBp = (fd: FormData, n: string): number | null => {
  const raw = String(fd.get(n) ?? "").trim();
  if (raw === "") return null;
  const v = Number(raw.replace(",", "."));
  return Number.isFinite(v) ? Math.round(v * 100) : null;
};

async function resolveCalcScope(calculationId: string) {
  const calc = await prisma.payrollCalculation.findUnique({ where: { id: calculationId } });
  if (!calc) return { ok: false as const, error: "Расчёт не найден" };
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false as const, error: "Нет доступа" };
  const clubIds = (await getUserClubs(ctx.user.id, ctx.selectedCompanyId)).map((c) => c.id);
  const period = await getPeriodForScope(ctx.selectedCompanyId, clubIds, calc.payrollPeriodId);
  if (!period) return { ok: false as const, error: "Период вне зоны доступа" };
  return { ok: true as const, ctx, companyId: ctx.selectedCompanyId, calc, period };
}

/**
 * Recompute a gym-trainer calculation from its packages + the snapshot scheme. Accrual
 * = calcGymTrainer income (with the 70% plan gate warning); the trainer summary (sold
 * packages / provided / credit) is stored in detailsJson. planCompletionBp is preserved
 * on the calc (completionBp). Exported so saveCalculationInputs reuses it.
 */
export async function recomputeGymTrainerCalculation(calculationId: string): Promise<void> {
  const calc = await prisma.payrollCalculation.findUnique({ where: { id: calculationId } });
  if (!calc) return;
  // Effective scheme = base snapshot + approved overrides (STAGE 10–11): a GD-approved
  // rate/threshold change re-runs the gym-trainer income here too.
  const scheme = effectiveSchemeParams(calc.schemeSnapshotJson, calc.approvedOverridesJson);
  if (!scheme || scheme.type !== "gym_trainer") return;
  const pkgs = await prisma.payrollTrainerPackage.findMany({ where: { payrollCalculationId: calculationId } });
  const planCompletionBp = calc.completionBp ?? 0;
  const result = computeScheme(scheme, { gymPackages: pkgs.map(toGymPackage), planCompletionBp });
  const summary = computeTrainerSummary(scheme.params, pkgs);
  await prisma.payrollCalculation.update({
    where: { id: calc.id },
    data: {
      automaticAmountKopeks: result.amountKopeks,
      salesBaseKopeks: summary.salesTotalKopeks,
      status: "calculated",
      calculatedAt: new Date(),
      detailsJson: JSON.stringify({ breakdown: result.breakdown, flags: result.flags, warnings: result.warnings, trainer: summary }),
    },
  });
  await recomputeCalculationTotals(calc.id);
}

/** Add a trainer package to a gym-trainer calculation. Operational band, period open. */
export async function addTrainerPackage(_prev: TrainerState | undefined, formData: FormData): Promise<TrainerState> {
  const calculationId = String(formData.get("calculationId") ?? "").trim();
  const scope = await resolveCalcScope(calculationId);
  if (!scope.ok) return fail(scope.error);
  if (!canManagePayrollAssignments(scope.ctx.effectiveRoles)) return fail("Недостаточно прав");
  if (isPayrollPeriodLocked(scope.period.status)) return fail("Период закрыт для изменений расчёта");

  const scheme = snapshotToSchemeParams(scope.calc.schemeSnapshotJson);
  if (!scheme || scheme.type !== "gym_trainer") return fail("Схема сотрудника — не «Тренер ТЗ». Задайте её и пересоздайте расчёт.");

  const contractAmountKopeks = rub(formData, "contractAmount");
  const sessionCount = int(formData, "sessionCount");
  if (contractAmountKopeks <= 0) return fail("Укажите сумму договора.");
  if (sessionCount <= 0) return fail("Укажите количество тренировок в пакете.");
  const providedSessions = int(formData, "providedSessions");
  if (providedSessions > sessionCount) return fail("Проведено не может превышать количество в пакете.");
  const returnedSessions = int(formData, "returnedSessions");
  const refundKopeks = rub(formData, "refund");
  if (refundKopeks > contractAmountKopeks) return fail("Возврат не может превышать сумму договора.");
  const trainerRateBp = pctBp(formData, "trainerRatePercent");
  if (trainerRateBp != null && (trainerRateBp < 0 || trainerRateBp > 10000)) return fail("Ставка тренера должна быть 0–100%.");
  const sessionPriceKopeks = sessionCount > 0 ? Math.round(contractAmountKopeks / sessionCount) : 0;
  const source = String(formData.get("source") ?? "manual").trim();

  await prisma.payrollTrainerPackage.create({
    data: {
      companyId: scope.companyId,
      clubId: scope.calc.clubId,
      employeeId: scope.calc.employeeId,
      payrollCalculationId: calculationId,
      clientRef: String(formData.get("clientRef") ?? "").trim() || null,
      contractNumber: String(formData.get("contractNumber") ?? "").trim() || null,
      saleDate: (() => { const d = String(formData.get("saleDate") ?? "").trim(); return d ? new Date(d) : null; })(),
      contractAmountKopeks,
      sessionCount,
      sessionPriceKopeks,
      trainerRateBp,
      providedSessions,
      returnedSessions,
      refundKopeks,
      seniorTrainerConfirmed: false,
      documentKey: String(formData.get("documentKey") ?? "").trim() || null,
      source: ["manual", "import", "integration"].includes(source) ? source : "manual",
      createdByUserId: scope.ctx.user.id,
    },
  });
  await recomputeGymTrainerCalculation(calculationId);
  try {
    await recordAudit({ action: "payroll.trainer_package_added", entityType: "PayrollCalculation", entityId: calculationId, companyId: scope.companyId, clubId: scope.calc.clubId, userId: scope.ctx.user.id, metadata: { contractAmountKopeks, sessionCount } });
  } catch { /* ignore */ }
  revalidatePath(`/payroll/periods/${scope.calc.payrollPeriodId}`);
  return { ok: true };
}

/** Remove a package (period open). */
export async function removeTrainerPackage(formData: FormData): Promise<void> {
  const packageId = String(formData.get("packageId") ?? "").trim();
  if (!packageId) return;
  const pkg = await prisma.payrollTrainerPackage.findUnique({ where: { id: packageId } });
  if (!pkg) return;
  const scope = await resolveCalcScope(pkg.payrollCalculationId);
  if (!scope.ok || isPayrollPeriodLocked(scope.period.status)) return;
  if (!canManagePayrollAssignments(scope.ctx.effectiveRoles)) return;
  await prisma.payrollTrainerPackage.delete({ where: { id: packageId } });
  await recomputeGymTrainerCalculation(pkg.payrollCalculationId);
  try {
    await recordAudit({ action: "payroll.trainer_package_removed", entityType: "PayrollCalculation", entityId: pkg.payrollCalculationId, companyId: scope.companyId, clubId: pkg.clubId, userId: scope.ctx.user.id, metadata: { packageId } });
  } catch { /* ignore */ }
  revalidatePath(`/payroll/periods/${scope.calc.payrollPeriodId}`);
}

/** Senior-trainer confirmation of provided sessions (подтверждение старшего тренера). */
export async function confirmTrainerPackage(formData: FormData): Promise<void> {
  const packageId = String(formData.get("packageId") ?? "").trim();
  if (!packageId) return;
  const pkg = await prisma.payrollTrainerPackage.findUnique({ where: { id: packageId } });
  if (!pkg) return;
  const scope = await resolveCalcScope(pkg.payrollCalculationId);
  if (!scope.ok || isPayrollPeriodLocked(scope.period.status)) return;
  if (!canManagePayrollAssignments(scope.ctx.effectiveRoles)) return;
  await prisma.payrollTrainerPackage.update({ where: { id: packageId }, data: { seniorTrainerConfirmed: true, seniorTrainerUserId: scope.ctx.user.id } });
  await recomputeGymTrainerCalculation(pkg.payrollCalculationId);
  try {
    await recordAudit({ action: "payroll.trainer_package_confirmed", entityType: "PayrollCalculation", entityId: pkg.payrollCalculationId, companyId: scope.companyId, clubId: pkg.clubId, userId: scope.ctx.user.id, metadata: { packageId } });
  } catch { /* ignore */ }
  revalidatePath(`/payroll/periods/${scope.calc.payrollPeriodId}`);
}

/**
 * Final settlement at dismissal: reclaim the trainer credit (начислено сверх проведённого)
 * as a trainer_credit_recovery DEBIT adjustment. It is withheld from the available salary
 * (folds into netPayable); any uncovered part becomes an employee debt on close and is
 * NEVER auto-written-off. Requires the employee to be dismissed.
 */
export async function recordTrainerFinalSettlement(_prev: TrainerState | undefined, formData: FormData): Promise<TrainerState> {
  const calculationId = String(formData.get("calculationId") ?? "").trim();
  const scope = await resolveCalcScope(calculationId);
  if (!scope.ok) return fail(scope.error);
  if (isPayrollPeriodClosed(scope.period.status)) return fail("Период закрыт — окончательный расчёт невозможен");
  const locked = isPayrollPeriodLocked(scope.period.status);
  if (!canAddPayrollAdjustment(scope.ctx.effectiveRoles, { locked })) {
    return fail(locked ? "После утверждения окончательный расчёт проводит бухгалтер" : "Недостаточно прав");
  }
  const scheme = snapshotToSchemeParams(scope.calc.schemeSnapshotJson);
  if (!scheme || scheme.type !== "gym_trainer") return fail("Окончательный расчёт по кредиту доступен только для тренера ТЗ.");

  const employee = await prisma.clubEmployee.findUnique({ where: { id: scope.calc.employeeId }, select: { status: true } });
  if (employee?.status !== "dismissed") return fail("Окончательный расчёт по кредиту доступен только для уволенного сотрудника.");

  const pkgs = await prisma.payrollTrainerPackage.findMany({ where: { payrollCalculationId: calculationId } });
  const summary = computeTrainerSummary(scheme.params, pkgs);
  if (summary.creditKopeks <= 0) return { ok: true, notice: "Кредита тренера нет — удержание не требуется." };

  // Idempotent: don't stack the recovery adjustment.
  const existing = await prisma.payrollAdjustment.findFirst({
    where: { payrollCalculationId: calculationId, type: "trainer_credit_recovery", status: "approved" },
    select: { id: true },
  });
  if (existing) return { ok: true, notice: "Удержание кредита тренера уже оформлено." };

  const now = new Date();
  const closed = await monthClosedError(scope.companyId, scope.calc.clubId, now);
  if (closed) return fail(closed);

  await prisma.payrollAdjustment.create({
    data: {
      companyId: scope.companyId,
      payrollCalculationId: calculationId,
      employeeId: scope.calc.employeeId,
      clubId: scope.calc.clubId,
      type: "trainer_credit_recovery",
      direction: "debit",
      amountKopeks: summary.creditKopeks,
      reason: "trainer_credit_recovery",
      comment: "Окончательный расчёт при увольнении: удержание кредита тренера (непроведённые занятия).",
      status: "approved",
      createdByUserId: scope.ctx.user.id,
      approvedByUserId: scope.ctx.user.id,
    },
  });
  await recomputeCalculationTotals(calculationId);
  try {
    await recordAudit({ action: "payroll.trainer_final_settlement", entityType: "PayrollCalculation", entityId: calculationId, companyId: scope.companyId, clubId: scope.calc.clubId, userId: scope.ctx.user.id, metadata: { creditKopeks: summary.creditKopeks } });
  } catch { /* ignore */ }
  revalidatePath(`/payroll/periods/${scope.calc.payrollPeriodId}`);
  return { ok: true, notice: "Кредит тренера удержан из доступной зарплаты; остаток станет долгом сотрудника при закрытии." };
}
