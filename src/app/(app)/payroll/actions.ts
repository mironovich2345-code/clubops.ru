"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, getUserClubs, canAccessClub, recordAudit } from "@/lib/access";
import { monthClosedError } from "@/lib/month-close";
import { rublesToKopeks } from "@/lib/money";
import { getEmployeeForScope } from "@/lib/club-employees";
import { canManagePayrollAssignments, canManagePaySchemes } from "@/lib/payroll/access";
import { validateAssignmentDraft } from "@/lib/payroll/assignments";
import { schemesToSupersede } from "@/lib/payroll/schemes";
import { validateSchemeParams } from "@/lib/payroll/scheme";
import { PAYROLL_SCHEME_TYPES, isKnown } from "@/lib/payroll/enums";

export type PayrollFormState = { ok: boolean; error?: string; fieldErrors?: Record<string, string> };

async function accessibleClubIds(userId: string, companyId: string): Promise<string[]> {
  return (await getUserClubs(userId, companyId)).map((c) => c.id);
}

function fail(error: string): PayrollFormState {
  return { ok: false, error };
}

// --- rubles/percent → kopeks/bp -------------------------------------------------
const rubField = (fd: FormData, name: string): number | null => {
  const raw = String(fd.get(name) ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? rublesToKopeks(n) : null;
};
const pctField = (fd: FormData, name: string): number | null => {
  const raw = String(fd.get(name) ?? "").trim().replace(",", ".");
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : null; // percent → basis points
};
const numField = (fd: FormData, name: string): number | null => {
  const raw = String(fd.get(name) ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** Map form inputs (rubles / percent) to the raw kopeks/bp params for a scheme type. */
function collectSchemeRawParams(schemeType: string, fd: FormData): Record<string, unknown> {
  switch (schemeType) {
    case "fixed_salary":
      return { baseKopeks: rubField(fd, "baseRubles") };
    case "salary_by_shifts":
      return { baseKopeks: rubField(fd, "baseRubles"), shiftNorm: numField(fd, "shiftNorm") };
    case "salary_plus_percentage":
      return {
        baseKopeks: rubField(fd, "baseRubles"),
        shiftNorm: numField(fd, "shiftNorm"),
        belowPlanRateBp: pctField(fd, "belowPlanPercent"),
        atPlanRateBp: pctField(fd, "atPlanPercent"),
      };
    case "sales_percentage":
      return { rateBp: pctField(fd, "ratePercent") };
    case "hourly":
      return { hourlyRateKopeks: rubField(fd, "hourlyRateRubles") };
    case "plan_adjusted_salary":
      return {
        subscriptionsBaseKopeks: rubField(fd, "subscriptionsBaseRubles"),
        ptBaseKopeks: rubField(fd, "ptBaseRubles"),
        maxAdjustmentBp: pctField(fd, "maxAdjustmentPercent"),
        manualReviewDeviationBp: pctField(fd, "manualReviewDeviationPercent"),
      };
    case "revenue_percentage":
      return {
        fixedKopeks: rubField(fd, "fixedRubles"),
        subsPercentBp: pctField(fd, "subsPercent"),
        ptPercentBp: pctField(fd, "ptPercent"),
      };
    case "profit_percentage":
      return { percentBp: pctField(fd, "profitPercent") };
    default:
      return {};
  }
}

/** Resolve the caller + verify they can access the employee's club. */
async function resolveEmployeeScope(employeeId: string, clubId?: string) {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false as const, error: "Нет доступа" };
  const companyId = ctx.selectedCompanyId;
  const clubIds = await accessibleClubIds(ctx.user.id, companyId);
  const employee = await getEmployeeForScope(companyId, clubIds, employeeId);
  if (!employee) return { ok: false as const, error: "Сотрудник не найден или вне зоны доступа" };
  const targetClub = clubId ?? employee.clubId;
  if (!clubIds.includes(targetClub) || !(await canAccessClub(ctx.user.id, targetClub))) {
    return { ok: false as const, error: "Нет доступа к выбранному клубу" };
  }
  return { ok: true as const, ctx, companyId, employee, targetClub };
}

/** Edit an employee's payroll profile (hire date, preferred payment, official flag,
 *  default legal entity). Regional/manager, own scope. */
export async function updatePayrollProfile(
  _prev: PayrollFormState | undefined,
  formData: FormData,
): Promise<PayrollFormState> {
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const scope = await resolveEmployeeScope(employeeId);
  if (!scope.ok) return fail(scope.error);
  if (!canManagePayrollAssignments(scope.ctx.effectiveRoles)) return fail("Недостаточно прав");

  const hireRaw = String(formData.get("hireDate") ?? "").trim();
  const hireDate = hireRaw ? new Date(hireRaw) : null;
  if (hireRaw && Number.isNaN(hireDate!.getTime())) return { ok: false, fieldErrors: { hireDate: "Неверная дата" } };
  const preferredPaymentMethod = String(formData.get("preferredPaymentMethod") ?? "").trim() || null;
  if (preferredPaymentMethod && !["cash", "bank"].includes(preferredPaymentMethod)) {
    return { ok: false, fieldErrors: { preferredPaymentMethod: "Неверный способ выплаты" } };
  }
  const isOfficial = String(formData.get("isOfficial") ?? "") === "on";
  const defaultLegalEntityId = String(formData.get("defaultLegalEntityId") ?? "").trim() || null;
  if (defaultLegalEntityId) {
    const le = await prisma.legalEntity.findFirst({
      where: { id: defaultLegalEntityId, companyId: scope.companyId },
      select: { id: true },
    });
    if (!le) return { ok: false, fieldErrors: { defaultLegalEntityId: "Юрлицо не найдено" } };
  }

  await prisma.clubEmployee.update({
    where: { id: scope.employee.id },
    data: { hireDate, preferredPaymentMethod, isOfficial, defaultLegalEntityId },
  });
  try {
    await recordAudit({
      action: "payroll.employee_profile_updated",
      entityType: "ClubEmployee",
      entityId: scope.employee.id,
      companyId: scope.companyId,
      clubId: scope.employee.clubId,
      userId: scope.ctx.user.id,
      metadata: { isOfficial, preferredPaymentMethod, defaultLegalEntityId },
    });
  } catch {
    /* audit must never block the mutation */
  }
  revalidatePath(`/payroll/employees/${scope.employee.id}`);
  return { ok: true };
}

/** Create/update a club assignment (unique per employee+club+position). */
export async function saveClubAssignment(
  _prev: PayrollFormState | undefined,
  formData: FormData,
): Promise<PayrollFormState> {
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const clubId = String(formData.get("clubId") ?? "").trim();
  const scope = await resolveEmployeeScope(employeeId, clubId);
  if (!scope.ok) return fail(scope.error);
  if (!canManagePayrollAssignments(scope.ctx.effectiveRoles)) return fail("Недостаточно прав");

  const shareRaw = String(formData.get("earningSharePercent") ?? "").trim();
  const draft = validateAssignmentDraft({
    clubId,
    position: String(formData.get("position") ?? "").trim(),
    earningShareBasisPoints: shareRaw === "" ? null : Math.round(Number(shareRaw.replace(",", ".")) * 100),
  });
  if (!draft.ok) return fail(draft.error);

  await prisma.employeeClubAssignment.upsert({
    where: {
      employeeId_clubId_position: { employeeId, clubId: draft.value.clubId, position: draft.value.position },
    },
    create: {
      companyId: scope.companyId,
      employeeId,
      clubId: draft.value.clubId,
      position: draft.value.position,
      earningShareBasisPoints: draft.value.earningShareBasisPoints,
      isActive: true,
    },
    update: { earningShareBasisPoints: draft.value.earningShareBasisPoints, isActive: true },
  });
  try {
    await recordAudit({
      action: "payroll.assignment_saved",
      entityType: "EmployeeClubAssignment",
      entityId: employeeId,
      companyId: scope.companyId,
      clubId: draft.value.clubId,
      userId: scope.ctx.user.id,
      metadata: { position: draft.value.position, earningShareBasisPoints: draft.value.earningShareBasisPoints },
    });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/employees/${employeeId}`);
  return { ok: true };
}

/** Deactivate a club assignment (soft — never hard-deleted). */
export async function removeClubAssignment(formData: FormData): Promise<void> {
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const assignmentId = String(formData.get("assignmentId") ?? "").trim();
  if (!assignmentId) return;
  const scope = await resolveEmployeeScope(employeeId);
  if (!scope.ok) return;
  if (!canManagePayrollAssignments(scope.ctx.effectiveRoles)) return;
  const a = await prisma.employeeClubAssignment.findUnique({ where: { id: assignmentId } });
  if (!a || a.companyId !== scope.companyId || a.employeeId !== employeeId) return;

  await prisma.employeeClubAssignment.update({ where: { id: assignmentId }, data: { isActive: false } });
  try {
    await recordAudit({
      action: "payroll.assignment_removed",
      entityType: "EmployeeClubAssignment",
      entityId: assignmentId,
      companyId: scope.companyId,
      clubId: a.clubId,
      userId: scope.ctx.user.id,
    });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/employees/${employeeId}`);
}

/**
 * Append a new effective-dated pay scheme. Money-sensitive (canManagePaySchemes).
 * Guards: (1) effective month must not be closed; (2) append-forward only — the new
 * effectiveFrom must be later than every existing scheme, so history (and any closed
 * month it covers) is never rewritten. The previously-open scheme is closed at the
 * new boundary in the same transaction.
 */
export async function savePayScheme(
  _prev: PayrollFormState | undefined,
  formData: FormData,
): Promise<PayrollFormState> {
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const clubId = String(formData.get("clubId") ?? "").trim();
  const scope = await resolveEmployeeScope(employeeId, clubId);
  if (!scope.ok) return fail(scope.error);
  if (!canManagePaySchemes(scope.ctx.effectiveRoles)) return fail("Недостаточно прав для настройки схем оплаты");

  const schemeType = String(formData.get("schemeType") ?? "").trim();
  if (!isKnown(PAYROLL_SCHEME_TYPES, schemeType)) return { ok: false, fieldErrors: { schemeType: "Выберите тип схемы" } };

  const monthRaw = String(formData.get("effectiveMonth") ?? "").trim(); // "YYYY-MM"
  const m = /^(\d{4})-(\d{2})$/.exec(monthRaw);
  if (!m) return { ok: false, fieldErrors: { effectiveMonth: "Укажите месяц вступления в силу" } };
  const effectiveFrom = new Date(Number(m[1]), Number(m[2]) - 1, 1, 0, 0, 0, 0);
  if (Number.isNaN(effectiveFrom.getTime())) return { ok: false, fieldErrors: { effectiveMonth: "Неверный месяц" } };

  // Guard 1: the effective month must not be closed.
  const closed = await monthClosedError(scope.companyId, clubId, effectiveFrom);
  if (closed) return fail(closed);

  const validated = validateSchemeParams(schemeType, collectSchemeRawParams(schemeType, formData));
  if (!validated.ok) return fail(validated.error);

  const existing = await prisma.employeePayScheme.findMany({
    where: { companyId: scope.companyId, clubId, employeeId },
    select: { id: true, effectiveFrom: true, effectiveTo: true },
  });
  // Guard 2: append-forward only — never insert into or before existing history.
  const latest = existing.reduce<number>((max, s) => Math.max(max, s.effectiveFrom.getTime()), -Infinity);
  if (existing.length > 0 && effectiveFrom.getTime() <= latest) {
    return fail("Новая схема должна вступать в силу позже всех существующих. Закрытые месяцы не пересчитываются.");
  }
  const supersede = schemesToSupersede(existing, effectiveFrom);

  await prisma.$transaction([
    ...supersede.map((s) =>
      prisma.employeePayScheme.update({ where: { id: s.id }, data: { effectiveTo: s.effectiveTo } }),
    ),
    prisma.employeePayScheme.create({
      data: {
        companyId: scope.companyId,
        clubId,
        employeeId,
        schemeType,
        paramsJson: JSON.stringify(validated.scheme.params),
        effectiveFrom,
        effectiveTo: null,
        createdByUserId: scope.ctx.user.id,
      },
    }),
  ]);
  try {
    await recordAudit({
      action: "payroll.scheme_saved",
      entityType: "EmployeePayScheme",
      entityId: employeeId,
      companyId: scope.companyId,
      clubId,
      userId: scope.ctx.user.id,
      metadata: { schemeType, effectiveFrom: effectiveFrom.toISOString(), superseded: supersede.map((s) => s.id) },
    });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/employees/${employeeId}`);
  return { ok: true };
}
