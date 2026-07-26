"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, getUserClubs, canAccessClub, recordAudit } from "@/lib/access";
import { monthClosedError } from "@/lib/month-close";
import { rublesToKopeks } from "@/lib/money";
import { canManagePayrollAssignments, canAddPayrollAdjustment } from "@/lib/payroll/access";
import { getEffectiveSchemeForEmployee, resolveSchemeForCalc } from "@/lib/payroll/schemes";
import { isRoleCategoryScheme } from "@/lib/payroll/enums";
import { makeSchemeSnapshot, snapshotToSchemeParams, getPeriodForScope } from "@/lib/payroll/periods";
import { computeScheme, type PeriodInput } from "@/lib/payroll/compute";
import { recomputeCalculationTotals } from "@/lib/payroll/aggregate";
import { obligationFromRemaining } from "@/lib/payroll/obligations";
import { getClubPlanFactBases } from "@/lib/payroll/sales-bases";
import { notifyRegionalReview, notifyAuthor } from "@/lib/notifications/events";
import { resolveActiveIpForClub } from "@/lib/expense-simplified";
import { ensureClubCashWallet, ensureRegionalCashWallet } from "@/lib/cash-wallets";
import { getActiveClubLegalEntities } from "@/lib/legal-entities";
import { advanceWithinEarned } from "@/lib/payroll/payments";
import { createSalaryExpense, cancelSalaryExpense } from "@/lib/payroll/salary-expense";
import { recomputeGymTrainerCalculation } from "@/app/(app)/payroll/periods/trainer-actions";
import { applyPayrollAction, isPayrollPeriodLocked, isPayrollPeriodClosed, PAYROLL_ACTION_AUDIT, type PayrollAction } from "@/lib/payroll/period";
import {
  BP_PER_100_PERCENT,
  PAYROLL_ADJUSTMENT_TYPES,
  ADJUSTMENT_DIRECTIONS,
  isKnown,
  type PayrollAdjustmentType,
} from "@/lib/payroll/enums";

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

  // Club-level plan/fact from OFD + sales plans (spec §13). Shared across employees.
  const bases = await getClubPlanFactBases(companyId, period.clubId, period.year, period.month);

  let created = 0;
  for (const [employeeId, position] of byEmployee) {
    const employee = await prisma.clubEmployee.findUnique({ where: { id: employeeId } });
    if (!employee || employee.companyId !== companyId || employee.status !== "active") continue;

    // Priority resolver (spec §4): employee → club-category → conflict/not-configured.
    const resolution = await resolveSchemeForCalc({ companyId, clubId: period.clubId, employeeId, position, at: firstDay });
    const scheme = resolution.ok ? resolution.scheme : null;
    const snapshot = scheme ? makeSchemeSnapshot(scheme) : null;
    const engineVersion = scheme && isRoleCategoryScheme(scheme.schemeType) ? "role_categories_v2" : "legacy_v1";
    const conflictWarning = !resolution.ok && resolution.reason === "conflict" ? resolution.message : null;

    // Idempotent: an existing calculation keeps its entered inputs; only the scheme
    // snapshot is refreshed while it is still a draft. New calculations are created and,
    // for the club-level schemes, PRE-FILLED from sales data (preliminary ФОТ).
    const existing = await prisma.payrollCalculation.findUnique({
      where: { payrollPeriodId_employeeId: { payrollPeriodId: period.id, employeeId } },
      select: { id: true, status: true },
    });
    if (existing) {
      if (scheme && existing.status === "draft") {
        await prisma.payrollCalculation.update({ where: { id: existing.id }, data: { schemeSnapshotJson: JSON.stringify(snapshot), calculationEngineVersion: engineVersion } });
      }
      created += 1;
      continue;
    }

    const typed = snapshot ? snapshotToSchemeParams(JSON.stringify(snapshot)) : null;
    // Manager plan-fact (legacy or v2) prefills АБ/ПТ from OFD/plan; revenue-% prefills fact.
    const isManagerPlanFact = typed != null && (typed.type === "plan_adjusted_salary" || typed.type === "role_club_manager");
    const prefill = typed != null && (isManagerPlanFact || typed.type === "revenue_percentage") && (bases.hasPlan || bases.hasFact);
    const baseWarnings = conflictWarning ? [conflictWarning] : scheme ? [] : ["Схема оплаты не задана на этот месяц."];

    let data: Record<string, unknown> = {
      companyId,
      payrollPeriodId: period.id,
      employeeId,
      clubId: period.clubId,
      legalEntityId: employee.defaultLegalEntityId ?? null,
      roleSnapshot: position,
      schemeSnapshotJson: snapshot ? JSON.stringify(snapshot) : null,
      calculationEngineVersion: engineVersion,
      status: "draft",
      detailsJson: JSON.stringify({ breakdown: [], flags: conflictWarning ? { needsManualReview: true } : {}, warnings: baseWarnings }),
    };

    if (prefill && typed) {
      const input = isManagerPlanFact
        ? { subscriptions: bases.subscriptions, personalTraining: bases.personalTraining }
        : { subscriptionsRevenueKopeks: bases.subscriptions.factKopeks, ptRevenueKopeks: bases.personalTraining.factKopeks };
      const result = computeScheme(typed, input);
      const planKopeks = bases.subscriptions.planKopeks + bases.personalTraining.planKopeks;
      const actualKopeks = bases.subscriptions.factKopeks + bases.personalTraining.factKopeks;
      data = {
        ...data,
        status: "calculated",
        calculatedAt: new Date(),
        automaticAmountKopeks: result.amountKopeks,
        salesBaseKopeks: bases.personalTraining.factKopeks,
        revenueBaseKopeks: actualKopeks,
        planKopeks: isManagerPlanFact ? planKopeks : null,
        actualKopeks: isManagerPlanFact ? actualKopeks : null,
        completionBp: isManagerPlanFact && planKopeks > 0 ? Math.round((actualKopeks / planKopeks) * BP_PER_100_PERCENT) : null,
        detailsJson: JSON.stringify({ breakdown: result.breakdown, flags: result.flags, warnings: [...result.warnings, "Данные подставлены из ОФД/плана продаж — проверьте перед согласованием."] }),
      };
    }

    const createdCalc = await prisma.payrollCalculation.create({ data: data as never });
    if (prefill) await recomputeCalculationTotals(createdCalc.id);
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

    // --- role-categories engine v2 inputs (STAGE 3–8) ---
    case "role_club_manager":
      return {
        subscriptions: { planKopeks: rub(fd, "subsPlan"), factKopeks: rub(fd, "subsFact") },
        personalTraining: { planKopeks: rub(fd, "ptPlan"), factKopeks: rub(fd, "ptFact") },
        normShifts: int(fd, "normShifts"),
        actualShifts: int(fd, "actualShifts"),
      };
    case "role_administrator":
      return { actualShifts: int(fd, "actualShifts"), normShifts: int(fd, "normShifts") };
    case "role_sales_manager":
    case "role_night_manager":
      return {
        actualShifts: int(fd, "actualShifts"),
        clubPlanCompletionBp: pctBp(fd, "clubPlanCompletion"),
        personalSalesKopeks: rub(fd, "personalSales"),
        returnsKopeks: rub(fd, "returns"),
      };
    case "role_gym_trainer":
      return { newSalesKopeks: rub(fd, "newSales"), renewalSalesKopeks: rub(fd, "renewalSales"), trainerCreditKopeks: rub(fd, "trainerCredit") };
    case "role_gym_head_trainer":
      return { newSalesKopeks: rub(fd, "newSales"), renewalSalesKopeks: rub(fd, "renewalSales"), clubPtCompletionBp: pctBp(fd, "clubPtCompletion"), trainerCreditKopeks: rub(fd, "trainerCredit") };
    case "role_group_trainer":
      return { hours: int(fd, "hours"), personalSalesKopeks: rub(fd, "personalSales") };
    case "role_group_head_trainer":
      return { hours: int(fd, "hours"), personalSalesKopeks: rub(fd, "personalSales"), clubGroupSalesKopeks: rub(fd, "clubGroupSales") };

    default:
      return {};
  }
}

/** Percent field (e.g. "95" or "95.5") → basis points. Empty → 0. */
function pctBp(fd: FormData, name: string): number {
  const raw = String(fd.get(name) ?? "").trim().replace(",", ".");
  if (raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
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

  // Gym trainer: inputs are the per-package rows (entered separately) + the this-month
  // plan-completion gate (70%). Persist the gate, then recompute from packages.
  if (scheme.type === "gym_trainer") {
    const planCompletionBp = Math.max(0, Math.round(Number(String(formData.get("planCompletionPercent") ?? "").replace(",", ".")) * 100) || 0);
    await prisma.payrollCalculation.update({ where: { id: calc.id }, data: { completionBp: planCompletionBp } });
    await recomputeGymTrainerCalculation(calc.id);
    try {
      await recordAudit({ action: "payroll.calculation_computed", entityType: "PayrollCalculation", entityId: calc.id, companyId: scope.companyId, clubId: calc.clubId, userId: scope.ctx.user.id, metadata: { schemeType: "gym_trainer", planCompletionBp } });
    } catch { /* ignore */ }
    revalidatePath(`/payroll/periods/${calc.payrollPeriodId}`);
    return { ok: true, periodId: calc.payrollPeriodId };
  }

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
      status: "calculated",
      calculatedAt: new Date(),
      detailsJson: JSON.stringify({ breakdown: result.breakdown, flags: result.flags, warnings: result.warnings }),
    },
  });
  // Fold the new automatic amount together with any existing adjustments/payments.
  await recomputeCalculationTotals(calc.id);
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

// --- workflow transitions (spec §5) -----------------------------------------
export type PayrollWorkflowState = { ok: boolean; error?: string };

const TS_FIELD: Partial<Record<string, "submittedAt" | "regionalApprovedAt" | "accountingApprovedAt" | "closedAt">> = {
  manager_submitted: "submittedAt",
  regional_approved: "regionalApprovedAt",
  approved: "accountingApprovedAt",
  closed: "closedAt",
};

/**
 * Move a period through the status machine. The pure guard (applyPayrollAction) checks
 * role + legal transition; here we add business guards: a period cannot be approved
 * while any calculation is still a draft (no unapproved calculations). On approval the
 * calculations are locked (status → approved) — direct edits are blocked thereafter.
 */
export async function transitionPeriod(
  _prev: PayrollWorkflowState | undefined,
  formData: FormData,
): Promise<PayrollWorkflowState> {
  const periodId = String(formData.get("periodId") ?? "").trim();
  const action = String(formData.get("action") ?? "").trim() as PayrollAction;
  const comment = String(formData.get("comment") ?? "").trim() || null;
  const scope = await resolvePeriodScope(periodId);
  if (!scope.ok) return { ok: false, error: scope.error };

  const decision = applyPayrollAction(action, scope.period.status, scope.ctx.effectiveRoles);
  if (!decision.ok) return { ok: false, error: decision.error };

  if (action === "regional_approve" || action === "accounting_approve") {
    const drafts = await prisma.payrollCalculation.count({ where: { payrollPeriodId: periodId, status: "draft" } });
    if (drafts > 0) return { ok: false, error: "Нельзя согласовать: есть нерассчитанные позиции. Сначала рассчитайте всех сотрудников." };
  }
  if (action === "close") {
    // No unconfirmed cash payments may be left dangling before closing.
    const pendingPay = await prisma.payrollPayment.count({ where: { payrollCalculationId: { in: (await prisma.payrollCalculation.findMany({ where: { payrollPeriodId: periodId }, select: { id: true } })).map((c) => c.id) }, status: "pending" } });
    if (pendingPay > 0) return { ok: false, error: "Есть неподтверждённые выплаты. Подтвердите или отмените их перед закрытием." };
  }

  const data: Record<string, unknown> = { status: decision.to };
  const tsField = TS_FIELD[decision.to];
  if (tsField) data[tsField] = new Date();

  await prisma.payrollPeriod.update({ where: { id: periodId }, data });
  if (decision.to === "approved") {
    await prisma.payrollCalculation.updateMany({
      where: { payrollPeriodId: periodId, status: "calculated" },
      data: { status: "approved", approvedAt: new Date() },
    });
  }
  if (decision.to === "closed") {
    // Turn every remainder / overpayment into a SPECIFIC obligation (spec §8): unpaid →
    // company_owes_employee, overpaid → employee_owes_company. Never auto-written-off.
    const closeCalcs = await prisma.payrollCalculation.findMany({ where: { payrollPeriodId: periodId } });
    for (const c of closeCalcs) {
      const o = obligationFromRemaining(c.remainingKopeks);
      if (!o) continue;
      const dup = await prisma.employeeFinancialObligation.findFirst({
        where: { companyId: scope.companyId, employeeId: c.employeeId, payrollPeriodId: periodId, reason: o.reason, status: { in: ["open", "partially_settled"] } },
        select: { id: true },
      });
      if (dup) continue;
      await prisma.employeeFinancialObligation.create({
        data: {
          companyId: scope.companyId,
          employeeId: c.employeeId,
          clubId: c.clubId,
          payrollPeriodId: periodId,
          direction: o.direction,
          reason: o.reason,
          originalAmountKopeks: o.amountKopeks,
          outstandingAmountKopeks: o.amountKopeks,
          status: "open",
          createdByUserId: scope.ctx.user.id,
        },
      });
      await prisma.payrollCalculation.update({ where: { id: c.id }, data: { status: "closed" } });
    }
  }
  try {
    await recordAudit({
      action: PAYROLL_ACTION_AUDIT[action],
      entityType: "PayrollPeriod",
      entityId: periodId,
      companyId: scope.companyId,
      clubId: scope.period.clubId,
      userId: scope.ctx.user.id,
      metadata: { from: scope.period.status, to: decision.to, comment },
    });
  } catch {
    /* ignore */
  }
  // Best-effort workflow notifications (never block the transition).
  try {
    const sum = await prisma.payrollCalculation.aggregate({ where: { payrollPeriodId: periodId }, _sum: { grossAccruedKopeks: true } });
    const amountKopeks = sum._sum.grossAccruedKopeks ?? 0;
    const base = { resourceType: "payroll" as const, resourceId: periodId, companyId: scope.companyId, clubId: scope.period.clubId, amountKopeks };
    if (action === "submit") {
      await notifyRegionalReview({ ...base, actorUserId: scope.ctx.user.id, isResubmit: scope.period.status === "needs_correction" });
    } else if (action === "return_for_correction") {
      await notifyAuthor({ ...base, authorUserId: scope.period.createdByUserId, actorUserId: scope.ctx.user.id, event: "returned" });
    } else if (action === "accounting_approve") {
      await notifyAuthor({ ...base, authorUserId: scope.period.createdByUserId, actorUserId: scope.ctx.user.id, event: "approved" });
    }
  } catch {
    /* notifications are best-effort */
  }
  revalidatePath(`/payroll/periods/${periodId}`);
  return { ok: true };
}

// --- adjustments (bonus / penalty / correction — spec §4/§5) ----------------
export type PayrollAdjustmentState = { ok: boolean; error?: string };

/** Direction is fixed for typed adjustments; correction/other take it from the form. */
function adjustmentDirection(type: PayrollAdjustmentType, raw: string): "credit" | "debit" | null {
  switch (type) {
    case "bonus":
      return "credit";
    case "penalty":
    case "overpayment_recovery":
    case "shortage_recovery":
    case "trainer_credit_recovery":
      return "debit";
    case "correction":
    case "other":
      return raw === "credit" || raw === "debit" ? raw : null;
    default:
      return null;
  }
}

/**
 * Add an adjustment to a calculation. Comment is REQUIRED (spec). Before approval the
 * operational band may post bonuses/penalties; after approval only the accounting band
 * may post corrections (period is locked). A closed period is immutable.
 */
export async function addAdjustment(
  _prev: PayrollAdjustmentState | undefined,
  formData: FormData,
): Promise<PayrollAdjustmentState> {
  const calculationId = String(formData.get("calculationId") ?? "").trim();
  const calc = await prisma.payrollCalculation.findUnique({ where: { id: calculationId } });
  if (!calc) return { ok: false, error: "Расчёт не найден" };
  const scope = await resolvePeriodScope(calc.payrollPeriodId);
  if (!scope.ok) return { ok: false, error: scope.error };
  if (isPayrollPeriodClosed(scope.period.status)) return { ok: false, error: "Период закрыт — изменения невозможны" };
  const locked = isPayrollPeriodLocked(scope.period.status);
  if (!canAddPayrollAdjustment(scope.ctx.effectiveRoles, { locked })) {
    return { ok: false, error: locked ? "После утверждения корректировки вносит только бухгалтер" : "Недостаточно прав" };
  }

  const type = String(formData.get("type") ?? "").trim();
  if (!isKnown(PAYROLL_ADJUSTMENT_TYPES, type)) return { ok: false, error: "Выберите тип корректировки" };
  const direction = adjustmentDirection(type, String(formData.get("direction") ?? "").trim());
  if (!direction) return { ok: false, error: "Укажите направление (начисление или удержание)" };
  const amountRaw = String(formData.get("amount") ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const amountKopeks = amountRaw === "" ? 0 : rublesToKopeks(Number(amountRaw));
  if (!Number.isFinite(amountKopeks) || amountKopeks <= 0) return { ok: false, error: "Сумма должна быть больше нуля" };
  const commentText = String(formData.get("comment") ?? "").trim();
  if (!commentText) return { ok: false, error: "Комментарий обязателен" };

  const accounting = scope.ctx.effectiveRoles.some((r) => r === "accountant" || r === "chief_accountant");
  await prisma.payrollAdjustment.create({
    data: {
      companyId: scope.companyId,
      payrollCalculationId: calc.id,
      employeeId: calc.employeeId,
      clubId: calc.clubId,
      type,
      direction,
      amountKopeks,
      reason: type,
      comment: commentText,
      status: "approved", // applied immediately; recorded with author
      createdByUserId: scope.ctx.user.id,
      approvedByUserId: accounting ? scope.ctx.user.id : null,
    },
  });
  await recomputeCalculationTotals(calc.id);
  try {
    await recordAudit({
      action: "payroll.adjustment_added",
      entityType: "PayrollCalculation",
      entityId: calc.id,
      companyId: scope.companyId,
      clubId: calc.clubId,
      userId: scope.ctx.user.id,
      metadata: { type, direction, amountKopeks, afterApproval: locked },
    });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/periods/${calc.payrollPeriodId}`);
  return { ok: true };
}

/** Cancel an adjustment (soft — status canceled) and recompute. Same permission gate. */
export async function cancelAdjustment(formData: FormData): Promise<void> {
  const adjustmentId = String(formData.get("adjustmentId") ?? "").trim();
  if (!adjustmentId) return;
  const adj = await prisma.payrollAdjustment.findUnique({ where: { id: adjustmentId } });
  if (!adj || adj.status !== "approved") return;
  const calc = await prisma.payrollCalculation.findUnique({ where: { id: adj.payrollCalculationId } });
  if (!calc) return;
  const scope = await resolvePeriodScope(calc.payrollPeriodId);
  if (!scope.ok) return;
  if (isPayrollPeriodClosed(scope.period.status)) return;
  const locked = isPayrollPeriodLocked(scope.period.status);
  if (!canAddPayrollAdjustment(scope.ctx.effectiveRoles, { locked })) return;

  await prisma.payrollAdjustment.update({ where: { id: adjustmentId }, data: { status: "canceled" } });
  await recomputeCalculationTotals(calc.id);
  try {
    await recordAudit({
      action: "payroll.adjustment_canceled",
      entityType: "PayrollCalculation",
      entityId: calc.id,
      companyId: scope.companyId,
      clubId: calc.clubId,
      userId: scope.ctx.user.id,
      metadata: { adjustmentId },
    });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/periods/${calc.payrollPeriodId}`);
}

// --- advances & payments (spec §6/§8) ---------------------------------------
export type PayrollPaymentState = { ok: boolean; error?: string };

// Money may only move once the accounting has approved the period (locked) and it is
// not yet closed.
const PAYABLE_STATUSES = new Set(["approved", "partially_paid", "paid"]);
const isAccounting = (roles: readonly string[]) => roles.some((r) => r === "accountant" || r === "chief_accountant");
const isOperational = (roles: readonly string[]) => roles.some((r) => r === "manager" || r === "regional_director");

function rublesFromForm(fd: FormData, name: string): number {
  const raw = String(fd.get(name) ?? "").trim().replace(/\s/g, "").replace(",", ".");
  return raw === "" ? 0 : rublesToKopeks(Number(raw));
}

/** The legal entity for a BANK salary expense: the club's active ООО, else its ИП. */
async function resolveBankLegalEntity(clubId: string): Promise<string | null> {
  const { ooo, ip } = await getActiveClubLegalEntities(clubId);
  return ooo?.id ?? ip?.id ?? null;
}

/**
 * Pick + validate the paying legal entity for one payment (item 5). Cash must be the
 * club's active ИП (and resolves its wallet); bank may be the ООО or the ИП. A chosen
 * id must be an active legal entity of THIS club (belongs to company/club). Returns the
 * legal entity + (cash) wallet, or a user-safe error.
 */
async function pickPaymentLegalEntity(
  companyId: string,
  clubId: string,
  method: string,
  chosenId: string | null,
  roles: readonly string[],
  userId: string,
): Promise<{ legalEntityId: string; walletId: string | null } | { error: string }> {
  const { ooo, ip } = await getActiveClubLegalEntities(clubId);
  if (method === "cash") {
    if (!ip) return { error: "У клуба нет активного ИП для наличной выплаты." };
    if (chosenId && chosenId !== ip.id) return { error: "Наличная выплата возможна только из ИП." };
    const walletId = roles.includes("regional_director")
      ? await ensureRegionalCashWallet(companyId, clubId, ip.id, userId)
      : await ensureClubCashWallet(companyId, clubId, ip.id);
    return { legalEntityId: ip.id, walletId };
  }
  // bank: ООО or ИП of the club
  const allowed = [ooo?.id, ip?.id].filter((x): x is string => Boolean(x));
  if (allowed.length === 0) return { error: "У клуба нет активного юрлица для безналичной выплаты." };
  if (chosenId && !allowed.includes(chosenId)) return { error: "Выбранное юрлицо не относится к клубу." };
  return { legalEntityId: chosenId ?? ooo?.id ?? ip!.id, walletId: null };
}

/** Resolve the paying ИП + the correct wallet for a CASH payout (regional pays from
 * their own wallet; manager/others from the club desk). Never chosen by the client. */
async function resolveCashWallet(companyId: string, clubId: string, userId: string, roles: readonly string[]) {
  const ip = await resolveActiveIpForClub(clubId);
  if (!ip.ok) return { ok: false as const, error: ip.error };
  const walletId = roles.includes("regional_director")
    ? await ensureRegionalCashWallet(companyId, clubId, ip.legalEntityId, userId)
    : await ensureClubCashWallet(companyId, clubId, ip.legalEntityId);
  return { ok: true as const, legalEntityId: ip.legalEntityId, walletId };
}

/**
 * Record a salary payment against a calculation (partial allowed; multiple per salary).
 * Cash → manager/regional, reduces the cash wallet ONCE via a CashMovement outflow.
 * Bank → accounting, no wallet movement (manual confirmation until bank integration).
 */
export async function recordPayment(
  _prev: PayrollPaymentState | undefined,
  formData: FormData,
): Promise<PayrollPaymentState> {
  const calculationId = String(formData.get("calculationId") ?? "").trim();
  const calc = await prisma.payrollCalculation.findUnique({ where: { id: calculationId } });
  if (!calc) return { ok: false, error: "Расчёт не найден" };
  const scope = await resolvePeriodScope(calc.payrollPeriodId);
  if (!scope.ok) return { ok: false, error: scope.error };
  if (!PAYABLE_STATUSES.has(scope.period.status)) return { ok: false, error: "Выплаты возможны только после утверждения периода" };

  const method = String(formData.get("method") ?? "").trim();
  if (method !== "cash" && method !== "bank") return { ok: false, error: "Выберите способ выплаты" };
  const roles = scope.ctx.effectiveRoles;
  if (method === "cash" && !isOperational(roles)) return { ok: false, error: "Наличную выплату проводит управляющий или регионал" };
  if (method === "bank" && !isAccounting(roles)) return { ok: false, error: "Безналичную выплату проводит бухгалтер" };

  const amountKopeks = rublesFromForm(formData, "amount");
  if (!Number.isFinite(amountKopeks) || amountKopeks <= 0) return { ok: false, error: "Сумма должна быть больше нуля" };
  const comment = String(formData.get("comment") ?? "").trim() || null;
  const documentKey = String(formData.get("documentKey") ?? "").trim() || null;
  const paymentDate = new Date();

  const closed = await monthClosedError(scope.companyId, calc.clubId, paymentDate);
  if (closed) return { ok: false, error: closed };

  // Item 5: the payer MAY choose the legal entity per payment (validated). Cash must be
  // the club's ИП (and its wallet); bank may be the ООО or the ИП. This supports one
  // accrual paid part-cash (ИП) + part-bank (ООО) without double aggregation.
  const chosenLe = String(formData.get("legalEntityId") ?? "").trim() || null;
  const picked = await pickPaymentLegalEntity(scope.companyId, calc.clubId, method, chosenLe, roles, scope.ctx.user.id);
  if ("error" in picked) return { ok: false, error: picked.error };
  const legalEntityId = picked.legalEntityId;
  const cash = method === "cash" ? { legalEntityId, walletId: picked.walletId as string } : null;

  const employeeName = (await prisma.clubEmployee.findUnique({ where: { id: calc.employeeId }, select: { fullName: true } }))?.fullName ?? calc.employeeId;

  const payment = await prisma.payrollPayment.create({
    data: {
      companyId: scope.companyId,
      payrollCalculationId: calc.id,
      employeeId: calc.employeeId,
      clubId: calc.clubId,
      legalEntityId,
      amountKopeks,
      paymentDate,
      paymentMethod: method,
      sourceType: method === "cash" ? (roles.includes("regional_director") ? "regional_cash" : "club_cash") : "bank_account",
      status: "confirmed",
      documentKey,
      comment,
      paidByUserId: scope.ctx.user.id,
    },
  });

  // The payout IS the salary expense: ONE Expense (P&L + fact balance) + ONE cash
  // movement for cash. No separate payroll CashMovement (no double deduction).
  const { expenseId } = await createSalaryExpense({
    companyId: scope.companyId,
    clubId: calc.clubId,
    legalEntityId,
    method,
    amountKopeks,
    paidByUserId: scope.ctx.user.id,
    cashWalletId: cash?.walletId ?? null,
    employeeId: calc.employeeId,
    employeeName,
    payrollPeriodId: calc.payrollPeriodId,
    kind: "payment",
  });
  await prisma.payrollPayment.update({ where: { id: payment.id }, data: { expenseId } });

  await recomputeCalculationTotals(calc.id);
  try {
    await recordAudit({
      action: "payroll.payment_recorded",
      entityType: "PayrollCalculation",
      entityId: calc.id,
      companyId: scope.companyId,
      clubId: calc.clubId,
      userId: scope.ctx.user.id,
      metadata: { paymentId: payment.id, method, amountKopeks },
    });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/periods/${calc.payrollPeriodId}`);
  return { ok: true };
}

/** Cancel a payment. A confirmed cash movement is reversed with a compensating inflow
 * (the balance is restored once); the payment is marked canceled and totals recomputed. */
export async function cancelPayment(formData: FormData): Promise<void> {
  const paymentId = String(formData.get("paymentId") ?? "").trim();
  if (!paymentId) return;
  const payment = await prisma.payrollPayment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.status !== "confirmed") return;
  const calc = await prisma.payrollCalculation.findUnique({ where: { id: payment.payrollCalculationId } });
  if (!calc) return;
  const scope = await resolvePeriodScope(calc.payrollPeriodId);
  if (!scope.ok || isPayrollPeriodClosed(scope.period.status)) return;
  const roles = scope.ctx.effectiveRoles;
  if (payment.paymentMethod === "cash" ? !isOperational(roles) : !isAccounting(roles)) return;

  // Cancel the salary expense (drops from P&L / fact balance) + reverse its cash movement.
  await cancelSalaryExpense(payment.expenseId, scope.ctx.user.id, "Отмена выплаты зарплаты");
  await prisma.payrollPayment.update({ where: { id: payment.id }, data: { status: "canceled" } });
  await recomputeCalculationTotals(calc.id);
  try {
    await recordAudit({
      action: "payroll.payment_canceled",
      entityType: "PayrollCalculation",
      entityId: calc.id,
      companyId: scope.companyId,
      clubId: calc.clubId,
      userId: scope.ctx.user.id,
      metadata: { paymentId: payment.id },
    });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/periods/${calc.payrollPeriodId}`);
}

/**
 * Record an advance for a calculation's employee+month (one per month — unique). Cash
 * reduces the wallet immediately; counted as part of paid (never double-counted). The
 * amount may not exceed the earned-to-date (net payable so far).
 */
export async function recordAdvance(
  _prev: PayrollPaymentState | undefined,
  formData: FormData,
): Promise<PayrollPaymentState> {
  const calculationId = String(formData.get("calculationId") ?? "").trim();
  const calc = await prisma.payrollCalculation.findUnique({ where: { id: calculationId } });
  if (!calc) return { ok: false, error: "Расчёт не найден" };
  const scope = await resolvePeriodScope(calc.payrollPeriodId);
  if (!scope.ok) return { ok: false, error: scope.error };
  if (!PAYABLE_STATUSES.has(scope.period.status)) return { ok: false, error: "Аванс возможен только после утверждения расчёта" };

  const method = String(formData.get("method") ?? "").trim();
  if (method !== "cash" && method !== "bank") return { ok: false, error: "Выберите способ выплаты" };
  const roles = scope.ctx.effectiveRoles;
  if (method === "cash" && !isOperational(roles)) return { ok: false, error: "Наличный аванс проводит управляющий или регионал" };
  if (method === "bank" && !isAccounting(roles)) return { ok: false, error: "Безналичный аванс проводит бухгалтер" };

  const amountKopeks = rublesFromForm(formData, "amount");
  const earnedToDate = calc.netPayableKopeks;
  if (!advanceWithinEarned(amountKopeks, earnedToDate)) {
    return { ok: false, error: "Аванс должен быть больше нуля и не превышать заработанное к дате" };
  }
  const comment = String(formData.get("comment") ?? "").trim() || null;
  const documentKey = String(formData.get("documentKey") ?? "").trim() || null;
  const now = new Date();
  const closed = await monthClosedError(scope.companyId, calc.clubId, now);
  if (closed) return { ok: false, error: closed };

  const existing = await prisma.payrollAdvance.findFirst({
    where: { employeeId: calc.employeeId, clubId: calc.clubId, periodYear: scope.period.year, periodMonth: scope.period.month, status: { in: ["paid", "approved", "requested"] } },
    select: { id: true },
  });
  if (existing) return { ok: false, error: "Аванс за этот месяц уже оформлен" };

  let cash: { legalEntityId: string; walletId: string } | null = null;
  let legalEntityId: string;
  if (method === "cash") {
    const w = await resolveCashWallet(scope.companyId, calc.clubId, scope.ctx.user.id, roles);
    if (!w.ok) return { ok: false, error: w.error };
    cash = { legalEntityId: w.legalEntityId, walletId: w.walletId };
    legalEntityId = w.legalEntityId;
  } else {
    const bankLe = calc.legalEntityId ?? (await resolveBankLegalEntity(calc.clubId));
    if (!bankLe) return { ok: false, error: "Не удалось определить юрлицо для безналичного аванса." };
    legalEntityId = bankLe;
  }
  const employeeName = (await prisma.clubEmployee.findUnique({ where: { id: calc.employeeId }, select: { fullName: true } }))?.fullName ?? calc.employeeId;

  const advance = await prisma.payrollAdvance.create({
    data: {
      companyId: scope.companyId,
      employeeId: calc.employeeId,
      clubId: calc.clubId,
      periodYear: scope.period.year,
      periodMonth: scope.period.month,
      earnedToDateKopeks: earnedToDate,
      amountKopeks,
      paymentMethod: method,
      cashSource: method === "cash" ? (roles.includes("regional_director") ? "regional_cash" : "club_cash") : null,
      documentKey,
      status: "paid",
      approvedByUserId: scope.ctx.user.id,
      paidByUserId: scope.ctx.user.id,
      paidAt: now,
    },
  });

  // The advance is part of the actual payout → one salary Expense + one cash movement.
  const { expenseId } = await createSalaryExpense({
    companyId: scope.companyId,
    clubId: calc.clubId,
    legalEntityId,
    method,
    amountKopeks,
    paidByUserId: scope.ctx.user.id,
    cashWalletId: cash?.walletId ?? null,
    employeeId: calc.employeeId,
    employeeName,
    payrollPeriodId: calc.payrollPeriodId,
    kind: "advance",
  });
  await prisma.payrollAdvance.update({ where: { id: advance.id }, data: { expenseId } });

  await recomputeCalculationTotals(calc.id);
  try {
    await recordAudit({
      action: "payroll.advance_recorded",
      entityType: "PayrollCalculation",
      entityId: calc.id,
      companyId: scope.companyId,
      clubId: calc.clubId,
      userId: scope.ctx.user.id,
      metadata: { advanceId: advance.id, method, amountKopeks },
    });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/periods/${calc.payrollPeriodId}`);
  return { ok: true };
}

/** Cancel an advance (compensating inflow if cash) and recompute. */
export async function cancelAdvance(formData: FormData): Promise<void> {
  const advanceId = String(formData.get("advanceId") ?? "").trim();
  if (!advanceId) return;
  const advance = await prisma.payrollAdvance.findUnique({ where: { id: advanceId } });
  if (!advance || advance.status !== "paid") return;
  // Find the calculation via the period matching the advance month.
  const period = await prisma.payrollPeriod.findFirst({
    where: { companyId: advance.companyId, clubId: advance.clubId, year: advance.periodYear, month: advance.periodMonth },
    select: { id: true, status: true },
  });
  if (!period) return;
  const scope = await resolvePeriodScope(period.id);
  if (!scope.ok || isPayrollPeriodClosed(scope.period.status)) return;
  const roles = scope.ctx.effectiveRoles;
  if (advance.paymentMethod === "cash" ? !isOperational(roles) : !isAccounting(roles)) return;

  // Cancel the linked salary expense (drops from P&L / fact balance) + reverse its movement.
  await cancelSalaryExpense(advance.expenseId, scope.ctx.user.id, "Отмена аванса");
  await prisma.payrollAdvance.update({ where: { id: advance.id }, data: { status: "canceled" } });
  const target = await prisma.payrollCalculation.findFirst({
    where: { payrollPeriodId: period.id, employeeId: advance.employeeId },
    select: { id: true },
  });
  if (target) await recomputeCalculationTotals(target.id);
  try {
    await recordAudit({
      action: "payroll.advance_canceled",
      entityType: "PayrollAdvance",
      entityId: advance.id,
      companyId: scope.companyId,
      clubId: advance.clubId,
      userId: scope.ctx.user.id,
    });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/periods/${period.id}`);
}
