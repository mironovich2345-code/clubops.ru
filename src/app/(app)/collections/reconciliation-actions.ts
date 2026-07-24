"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { monthClosedError } from "@/lib/month-close";
import { notifyReconciliation } from "@/lib/notifications/events";
import {
  buildReconciliationTargets,
  getReconciliationForScope,
  canSubmitReconciliation,
  canRegionalReview,
  canAccountingReview,
  submittedOnTime,
  reconciliationDifference,
  yesterdayLocal,
  RECON_REASON_CODES,
} from "@/lib/cash-reconciliation";

export type ReconState = { ok: boolean; error?: string; notice?: string };

const fail = (error: string): ReconState => ({ ok: false, error });

/** Parse a counted-cash amount in rubles → kopeks. Allows 0 (an empty till). */
function parseActualKopeks(raw: string | null): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(String(raw).replace(",", ".").replace(/\s/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/**
 * Manager (or regional) confirms the physically counted cash for the previous day, per
 * legal entity. Expected balance + OFD cash are recomputed server-side from the existing
 * fact-balance math — NO money is moved and OFD is NOT rewritten. A non-zero difference
 * requires a reason + comment and raises a regional task.
 */
export async function submitDailyCashReconciliation(
  _prev: ReconState | undefined,
  formData: FormData,
): Promise<ReconState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return fail("Нет доступа.");
  if (!canSubmitReconciliation(ctx.effectiveRoles)) return fail("Недостаточно прав.");
  const companyId = ctx.selectedCompanyId;
  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId || !ctx.allowedClubIds.includes(clubId)) return fail("Клуб недоступен.");

  const now = new Date();
  const businessDate = yesterdayLocal(now);
  const closed = await monthClosedError(companyId, clubId, businessDate);
  if (closed) return fail(closed);

  const { entities } = await buildReconciliationTargets(companyId, clubId, now);
  if (entities.length === 0) return fail("У клуба нет активного юрлица.");

  const onTime = submittedOnTime(businessDate, now);
  let submittedCount = 0;
  let discrepancyTotal = 0;

  for (const e of entities) {
    const actual = parseActualKopeks(String(formData.get(`${e.legalEntityType}_actual`) ?? ""));
    if (actual == null) continue; // entity not filled in this submission
    const difference = reconciliationDifference(actual, e.expectedCashBalanceKopeks);
    const reasonCode = String(formData.get(`${e.legalEntityType}_reason`) ?? "").trim() || null;
    const comment = String(formData.get(`${e.legalEntityType}_comment`) ?? "").trim() || null;
    if (difference !== 0) {
      if (!reasonCode || !(RECON_REASON_CODES as readonly string[]).includes(reasonCode)) {
        return fail(`Укажите причину расхождения для ${e.name}.`);
      }
      if (!comment) return fail(`Комментарий обязателен при расхождении для ${e.name}.`);
      discrepancyTotal += Math.abs(difference);
    }
    const status = difference === 0 ? "submitted" : "discrepancy";
    await prisma.dailyCashReconciliation.upsert({
      where: { clubId_legalEntityId_businessDate: { clubId, legalEntityId: e.legalEntityId, businessDate } },
      create: {
        companyId,
        clubId,
        legalEntityId: e.legalEntityId,
        legalEntityType: e.legalEntityType,
        businessDate,
        ofdCashRevenueKopeks: e.ofdCashRevenueKopeks,
        expectedCashBalanceKopeks: e.expectedCashBalanceKopeks,
        actualCashBalanceKopeks: actual,
        differenceKopeks: difference,
        reasonCode: difference === 0 ? null : reasonCode,
        comment: difference === 0 ? comment : comment,
        status,
        submittedById: ctx.user.id,
        submittedAt: now,
        submittedOnTime: onTime,
      },
      update: {
        ofdCashRevenueKopeks: e.ofdCashRevenueKopeks,
        expectedCashBalanceKopeks: e.expectedCashBalanceKopeks,
        actualCashBalanceKopeks: actual,
        differenceKopeks: difference,
        reasonCode: difference === 0 ? null : reasonCode,
        comment,
        status,
        submittedById: ctx.user.id,
        submittedAt: now,
        submittedOnTime: onTime,
      },
    });
    submittedCount += 1;
  }

  if (submittedCount === 0) return fail("Введите пересчитанные наличные хотя бы для одного юрлица.");

  try {
    await recordAudit({
      action: "cash_recon.submitted",
      entityType: "DailyCashReconciliation",
      entityId: clubId,
      companyId,
      clubId,
      userId: ctx.user.id,
      metadata: { businessDate: businessDate.toISOString().slice(0, 10), entities: submittedCount, discrepancyTotalKopeks: discrepancyTotal, onTime },
    });
  } catch {
    /* audit must never block */
  }
  if (discrepancyTotal > 0) {
    await notifyReconciliation({ event: "discrepancy", clubId, companyId, amountKopeks: discrepancyTotal, actorUserId: ctx.user.id });
  }

  revalidatePath("/collections");
  revalidatePath("/dashboard");
  return { ok: true, notice: discrepancyTotal > 0 ? "Расхождение зафиксировано, отправлено на разбор." : "Наличные подтверждены." };
}

/**
 * Regional confirms the discrepancy reason/decision; accountant confirms the financial
 * closing. A discrepancy needs both before it closes; a clean submission closes on the
 * accounting confirmation.
 */
export async function reviewDailyCashReconciliation(
  _prev: ReconState | undefined,
  formData: FormData,
): Promise<ReconState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return fail("Нет доступа.");
  const companyId = ctx.selectedCompanyId;
  const id = String(formData.get("reconciliationId") ?? "").trim();
  const decision = String(formData.get("decision") ?? "").trim();
  const resolution = String(formData.get("resolution") ?? "").trim() || null;

  const r = await getReconciliationForScope(companyId, ctx.allowedClubIds, id);
  if (!r) return fail("Сверка не найдена.");
  if (r.status === "closed") return fail("Сверка уже закрыта.");

  const now = new Date();
  const data: Record<string, unknown> = {};
  let auditAction = "cash_recon.reviewed";

  if (decision === "start_review") {
    if (!canRegionalReview(ctx.effectiveRoles) && !canAccountingReview(ctx.effectiveRoles)) return fail("Недостаточно прав.");
    if (r.status !== "discrepancy") return fail("Разбор доступен только для расхождения.");
    data.status = "under_review";
  } else if (decision === "regional_confirm") {
    if (!canRegionalReview(ctx.effectiveRoles)) return fail("Подтверждает региональный директор.");
    if (!["discrepancy", "under_review"].includes(r.status)) return fail("Неверный статус для подтверждения регионалом.");
    if (!resolution) return fail("Укажите решение по расхождению.");
    data.status = "regional_confirmed";
    data.regionalReviewedById = ctx.user.id;
    data.regionalReviewedAt = now;
    data.resolution = resolution;
    auditAction = "cash_recon.regional_confirmed";
  } else if (decision === "accounting_confirm") {
    if (!canAccountingReview(ctx.effectiveRoles)) return fail("Подтверждает бухгалтер.");
    const wasDiscrepancy = r.differenceKopeks !== 0;
    if (wasDiscrepancy && !r.regionalReviewedById) return fail("Сначала расхождение подтверждает региональный директор.");
    data.accountingReviewedById = ctx.user.id;
    data.accountingReviewedAt = now;
    data.status = "closed";
    data.closedAt = now;
    if (resolution) data.resolution = resolution;
    auditAction = "cash_recon.closed";
  } else {
    return fail("Неверное действие.");
  }

  await prisma.dailyCashReconciliation.update({ where: { id: r.id }, data });
  try {
    await recordAudit({
      action: auditAction,
      entityType: "DailyCashReconciliation",
      entityId: r.id,
      companyId,
      clubId: r.clubId,
      userId: ctx.user.id,
      metadata: { decision, differenceKopeks: r.differenceKopeks },
    });
  } catch {
    /* ignore */
  }
  revalidatePath("/collections");
  revalidatePath("/dashboard");
  return { ok: true, notice: "Готово." };
}
