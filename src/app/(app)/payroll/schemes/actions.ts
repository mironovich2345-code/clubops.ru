"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, getUserClubs, canAccessClub, recordAudit } from "@/lib/access";
import { monthClosedError } from "@/lib/month-close";
import { canManagePaySchemes, canActivateScheme } from "@/lib/payroll/access";
import { validateSchemeParams } from "@/lib/payroll/scheme";
import { collectSchemeRawParams } from "@/lib/payroll/scheme-form";
import { canSchemeTransition, nextVersion, committedStatusFor, FROZEN_STATUSES } from "@/lib/payroll/scheme-version";
import { notifyPayrollChangeReview } from "@/lib/notifications/events";

export type SchemeActionState = { ok: boolean; error?: string; notice?: string };
const fail = (e: string): SchemeActionState => ({ ok: false, error: e });

/** Load a scheme row within the caller's tenant + accessible clubs (IDOR guard, §19). */
async function resolveSchemeScope(schemeId: string) {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false as const, error: "Нет доступа" };
  const companyId = ctx.selectedCompanyId;
  const clubIds = (await getUserClubs(ctx.user.id, companyId)).map((c) => c.id);
  const scheme = await prisma.employeePayScheme.findUnique({ where: { id: schemeId } });
  if (!scheme || scheme.companyId !== companyId || !clubIds.includes(scheme.clubId)) return { ok: false as const, error: "Схема не найдена" };
  return { ok: true as const, ctx, companyId, clubIds, scheme };
}

/** True if this scheme version is referenced by any calculation snapshot (→ immutable). */
async function isSchemeUsed(schemeId: string): Promise<boolean> {
  const hit = await prisma.payrollCalculation.findFirst({ where: { schemeSnapshotJson: { contains: `"schemeId":"${schemeId}"` } }, select: { id: true } });
  return Boolean(hit);
}

/** Regional/author: edit a DRAFT (or returned) version in place. Frozen versions rejected. */
export async function editSchemeDraft(_prev: SchemeActionState | undefined, formData: FormData): Promise<SchemeActionState> {
  const schemeId = String(formData.get("schemeId") ?? "").trim();
  const scope = await resolveSchemeScope(schemeId);
  if (!scope.ok) return fail(scope.error);
  if (!canManagePaySchemes(scope.ctx.effectiveRoles)) return fail("Недостаточно прав");
  const { scheme } = scope;
  // Immutability (§18): only a draft may be edited; used/active/superseded are frozen.
  if (scheme.status !== "draft") return fail("Редактировать можно только черновик версии.");
  if (FROZEN_STATUSES.has(scheme.status) || (await isSchemeUsed(scheme.id))) return fail("Версия уже использована — параметры неизменяемы.");

  const validated = validateSchemeParams(scheme.schemeType, collectSchemeRawParams(scheme.schemeType, formData));
  if (!validated.ok) return fail(validated.error);
  const monthRaw = String(formData.get("effectiveMonth") ?? "").trim();
  const m = /^(\d{4})-(\d{2})$/.exec(monthRaw);
  const data: Record<string, unknown> = { paramsJson: JSON.stringify(validated.scheme.params), comment: String(formData.get("comment") ?? "").trim() || scheme.comment };
  if (m) {
    const effectiveFrom = new Date(Number(m[1]), Number(m[2]) - 1, 1, 0, 0, 0, 0);
    const closed = await monthClosedError(scope.companyId, scheme.clubId, effectiveFrom);
    if (closed) return fail(closed);
    data.effectiveFrom = effectiveFrom;
  }
  await prisma.employeePayScheme.update({ where: { id: scheme.id }, data });
  await audit("payroll.scheme_draft_edited", scope, scheme.id);
  revalidatePath("/payroll/schemes");
  return { ok: true, notice: "Черновик обновлён." };
}

/** Author submits a draft for approval (draft → pending_approval); notifies approvers. */
export async function submitSchemeDraft(_prev: SchemeActionState | undefined, formData: FormData): Promise<SchemeActionState> {
  const scope = await resolveSchemeScope(String(formData.get("schemeId") ?? "").trim());
  if (!scope.ok) return fail(scope.error);
  if (!canManagePaySchemes(scope.ctx.effectiveRoles)) return fail("Недостаточно прав");
  const { scheme } = scope;
  if (!canSchemeTransition(scheme.status, "submit")) return fail("Отправить на согласование можно только черновик.");
  await prisma.employeePayScheme.update({ where: { id: scheme.id }, data: { status: "pending_approval", submittedById: scope.ctx.user.id, submittedAt: new Date() } });
  await audit("payroll.scheme_submitted", scope, scheme.id);
  try {
    await notifyPayrollChangeReview({ resourceId: scheme.id, companyId: scope.companyId, clubId: scheme.clubId, amountKopeks: 0, actorUserId: scope.ctx.user.id, isResubmit: false });
  } catch {
    /* best-effort */
  }
  revalidatePath("/payroll/schemes");
  return { ok: true, notice: "Версия отправлена на согласование." };
}

/** Reviewer returns a pending version to draft for rework. */
export async function returnSchemeDraft(_prev: SchemeActionState | undefined, formData: FormData): Promise<SchemeActionState> {
  const scope = await resolveSchemeScope(String(formData.get("schemeId") ?? "").trim());
  if (!scope.ok) return fail(scope.error);
  if (!canActivateScheme(scope.ctx.effectiveRoles)) return fail("Согласование доступно только ГД / собственнику / гл. бухгалтеру.");
  const { scheme } = scope;
  if (!canSchemeTransition(scheme.status, "return")) return fail("Вернуть можно только версию на согласовании.");
  await prisma.employeePayScheme.update({ where: { id: scheme.id }, data: { status: "draft", comment: String(formData.get("comment") ?? "").trim() || scheme.comment } });
  await audit("payroll.scheme_returned", scope, scheme.id);
  revalidatePath("/payroll/schemes");
  return { ok: true, notice: "Версия возвращена на доработку." };
}

/** Reviewer rejects a pending version (terminal). */
export async function rejectSchemeDraft(_prev: SchemeActionState | undefined, formData: FormData): Promise<SchemeActionState> {
  const scope = await resolveSchemeScope(String(formData.get("schemeId") ?? "").trim());
  if (!scope.ok) return fail(scope.error);
  if (!canActivateScheme(scope.ctx.effectiveRoles)) return fail("Согласование доступно только ГД / собственнику / гл. бухгалтеру.");
  const { scheme } = scope;
  if (!canSchemeTransition(scheme.status, "reject")) return fail("Отклонить можно только версию на согласовании.");
  await prisma.employeePayScheme.update({ where: { id: scheme.id }, data: { status: "rejected", comment: String(formData.get("comment") ?? "").trim() || scheme.comment } });
  await audit("payroll.scheme_rejected", scope, scheme.id);
  revalidatePath("/payroll/schemes");
  return { ok: true, notice: "Версия отклонена." };
}

/**
 * Reviewer approves + ACTIVATES a pending version (spec §6/§14). Recomputes the version
 * number within the logical key, commits the row (active/scheduled by date), and closes
 * the previously-open interval. Idempotent-ish: a second call on a non-pending row is a
 * no-op. Append-forward guard preserved.
 */
export async function approveSchemeDraft(_prev: SchemeActionState | undefined, formData: FormData): Promise<SchemeActionState> {
  const scope = await resolveSchemeScope(String(formData.get("schemeId") ?? "").trim());
  if (!scope.ok) return fail(scope.error);
  if (!canActivateScheme(scope.ctx.effectiveRoles)) return fail("Активировать версию может только ГД / собственник / гл. бухгалтер.");
  const { scheme } = scope;
  if (scheme.status !== "pending_approval") return fail("Активировать можно только версию на согласовании.");
  if (scheme.submittedById === scope.ctx.user.id) {
    // A user may submit and, being an activator, also activate — allowed; но собственную
    // заявку в change-request нельзя. Здесь разрешаем (схема — не change request).
  }
  const now = new Date();
  const closed = await monthClosedError(scope.companyId, scheme.clubId, scheme.effectiveFrom);
  if (closed) return fail(closed);

  const siblings = await prisma.employeePayScheme.findMany({
    where: { companyId: scheme.companyId, clubId: scheme.clubId, employeeId: scheme.employeeId, position: scheme.position, id: { not: scheme.id } },
    orderBy: [{ effectiveFrom: "desc" }],
  });
  const latest = siblings.reduce<number>((max, s) => Math.max(max, s.effectiveFrom.getTime()), -Infinity);
  if (siblings.length > 0 && scheme.effectiveFrom.getTime() <= latest) {
    return fail("Дата вступления в силу не позже существующих версий — история не перезаписывается. Измените дату черновика.");
  }
  const openPrev = siblings.find((s) => s.effectiveTo == null && ["active", "scheduled", "approved"].includes(s.status));
  const status = committedStatusFor(scheme.effectiveFrom, now);
  try {
    await prisma.$transaction(async (tx) => {
      if (openPrev) await tx.employeePayScheme.update({ where: { id: openPrev.id }, data: { effectiveTo: scheme.effectiveFrom, status: "superseded" } });
      await tx.employeePayScheme.update({
        where: { id: scheme.id },
        data: { status, version: nextVersion(siblings), supersedesSchemeId: openPrev?.id ?? null, approvedById: scope.ctx.user.id, approvedAt: now, activatedAt: status === "active" ? now : null },
      });
    });
  } catch (e) {
    return fail(`Не удалось активировать версию: ${(e as Error).message}`);
  }
  await audit("payroll.scheme_activated", scope, scheme.id, { status, version: nextVersion(siblings) });
  revalidatePath("/payroll/schemes");
  return { ok: true, notice: status === "scheduled" ? "Версия согласована и запланирована." : "Версия согласована и активирована." };
}

/** Archive a non-committed / superseded version (user hiding only). Used/active blocked. */
export async function archiveScheme(_prev: SchemeActionState | undefined, formData: FormData): Promise<SchemeActionState> {
  const scope = await resolveSchemeScope(String(formData.get("schemeId") ?? "").trim());
  if (!scope.ok) return fail(scope.error);
  if (!canManagePaySchemes(scope.ctx.effectiveRoles)) return fail("Недостаточно прав");
  const { scheme } = scope;
  if (!canSchemeTransition(scheme.status, "archive")) return fail("Архивировать можно только черновик, отклонённую, отменённую или заменённую версию.");
  if (scheme.status === "active") return fail("Активную версию архивировать нельзя.");
  await prisma.employeePayScheme.update({ where: { id: scheme.id }, data: { status: "archived", archivedAt: new Date() } });
  await audit("payroll.scheme_archived", scope, scheme.id);
  revalidatePath("/payroll/schemes");
  return { ok: true, notice: "Версия архивирована." };
}

async function audit(action: string, scope: { companyId: string; ctx: { user: { id: string } }; scheme?: { clubId: string } }, schemeId: string, metadata?: Record<string, unknown>) {
  try {
    await recordAudit({ action, entityType: "EmployeePayScheme", entityId: schemeId, companyId: scope.companyId, clubId: (scope as { scheme?: { clubId: string } }).scheme?.clubId ?? undefined, userId: scope.ctx.user.id, metadata });
  } catch {
    /* ignore */
  }
}
