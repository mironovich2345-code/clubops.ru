"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, getUserClubs, canAccessClub, recordAudit } from "@/lib/access";
import { monthClosedError } from "@/lib/month-close";
import { getEmployeeForScope } from "@/lib/club-employees";
import { canManagePayrollAssignments, canManagePaySchemes, canActivateScheme } from "@/lib/payroll/access";
import { validateAssignmentDraft } from "@/lib/payroll/assignments";
import { validateSchemeParams } from "@/lib/payroll/scheme";
import { collectSchemeRawParams } from "@/lib/payroll/scheme-form";
import { createCommittedVersion } from "@/lib/payroll/scheme-service";
import { nextVersion, categoryOfPosition } from "@/lib/payroll/scheme-version";
import { PAYROLL_SCHEME_TYPES, isKnown } from "@/lib/payroll/enums";

export type PayrollFormState = { ok: boolean; error?: string; fieldErrors?: Record<string, string> };

async function accessibleClubIds(userId: string, companyId: string): Promise<string[]> {
  return (await getUserClubs(userId, companyId)).map((c) => c.id);
}

function fail(error: string): PayrollFormState {
  return { ok: false, error };
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
    select: { id: true, effectiveFrom: true, version: true },
  });
  // Guard 2: append-forward only — never insert into or before existing history.
  const latest = existing.reduce<number>((max, s) => Math.max(max, s.effectiveFrom.getTime()), -Infinity);
  if (existing.length > 0 && effectiveFrom.getTime() <= latest) {
    return fail("Новая схема должна вступать в силу позже всех существующих. Закрытые месяцы не пересчитываются.");
  }

  const now = new Date();
  // STAGE 12 (§14): a regional director may only AUTHOR a draft version; owner/GD/chief
  // accountant activate it live. A draft is not resolver-live and affects nothing until
  // approved+materialized. Activators commit the version immediately (append-forward,
  // closing the previous open interval).
  const employeePosition = scope.employee?.position ?? null;
  if (canActivateScheme(scope.ctx.effectiveRoles)) {
    await prisma.$transaction(async (tx) => {
      await createCommittedVersion(tx, {
        scope: { companyId: scope.companyId, clubId, employeeId, position: null },
        schemeType,
        params: validated.scheme.params,
        effectiveFrom,
        at: now,
        approvedById: scope.ctx.user.id,
        createdByUserId: scope.ctx.user.id,
      });
    });
  } else {
    await prisma.employeePayScheme.create({
      data: {
        companyId: scope.companyId,
        clubId,
        employeeId,
        payrollCategory: categoryOfPosition(employeePosition),
        schemeType,
        paramsJson: JSON.stringify(validated.scheme.params),
        effectiveFrom,
        effectiveTo: null,
        version: nextVersion(existing),
        status: "draft",
        submittedById: null,
        createdByUserId: scope.ctx.user.id,
      },
    });
  }
  try {
    await recordAudit({
      action: "payroll.scheme_saved",
      entityType: "EmployeePayScheme",
      entityId: employeeId,
      companyId: scope.companyId,
      clubId,
      userId: scope.ctx.user.id,
      metadata: { schemeType, effectiveFrom: effectiveFrom.toISOString(), committed: canActivateScheme(scope.ctx.effectiveRoles) },
    });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/employees/${employeeId}`);
  revalidatePath("/payroll/schemes");
  return { ok: true };
}
