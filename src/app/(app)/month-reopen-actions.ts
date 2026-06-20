"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import {
  canRequestMonthReopen,
  canApproveMonthReopen,
  canExecuteMonthReopen,
} from "@/lib/auth";
import { isValidMonth, isMonthClosed } from "@/lib/month-close";
import { getActiveReopenRequest, REOPEN_ACTIVE_STATUSES } from "@/lib/month-reopen";

export type ReopenState = { ok: boolean; error?: string };

// The reopen workflow is company-wide (clubId null), matching closeMonth.
const SCOPE_CLUB_ID: string | null = null;

function revalidateMonthSurfaces() {
  revalidatePath("/workspace");
  revalidatePath("/dashboard");
  revalidatePath("/expenses");
  revalidatePath("/invoices");
  revalidatePath("/sales");
}

/**
 * Chief Accountant requests reopening of a CLOSED month, with a reason. Blocked
 * if the month is open or an active (pending/approved) request already exists.
 */
export async function requestMonthReopen(_prev: ReopenState | undefined, formData: FormData): Promise<ReopenState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа" };
  if (!canRequestMonthReopen(ctx.effectiveRoles)) {
    return { ok: false, error: "Запросить переоткрытие может только главный бухгалтер" };
  }
  const companyId = ctx.selectedCompanyId;

  const month = String(formData.get("month") ?? "").trim();
  if (!isValidMonth(month)) return { ok: false, error: "Укажите месяц в формате ГГГГ-ММ" };
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { ok: false, error: "Укажите причину переоткрытия" };

  // Only a currently-closed month can be reopened.
  if (!(await isMonthClosed(companyId, SCOPE_CLUB_ID, month))) {
    return { ok: false, error: "Месяц уже открыт" };
  }
  // At most one active request per scope + month.
  if (await getActiveReopenRequest(companyId, SCOPE_CLUB_ID, month)) {
    return { ok: false, error: "По этому месяцу уже есть активный запрос" };
  }

  const request = await prisma.monthReopenRequest.create({
    data: {
      companyId,
      clubId: SCOPE_CLUB_ID,
      month,
      status: "pending",
      reason,
      requestedByUserId: ctx.user.id,
    },
  });

  await recordAudit({
    action: "month.reopen_requested",
    entityType: "MonthReopenRequest",
    entityId: request.id,
    companyId,
    userId: ctx.user.id,
    metadata: { month, reason },
  });

  revalidateMonthSurfaces();
  return { ok: true };
}

/** Loads a request and verifies it belongs to the caller's selected company. */
async function loadScopedRequest(companyId: string, requestId: string) {
  if (!requestId) return null;
  const req = await prisma.monthReopenRequest.findUnique({ where: { id: requestId } });
  if (!req || req.companyId !== companyId) return null; // cross-company access denied
  return req;
}

/** Owner approves a pending reopening request. Does NOT reopen the month. */
export async function approveMonthReopen(_prev: ReopenState | undefined, formData: FormData): Promise<ReopenState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа" };
  if (!canApproveMonthReopen(ctx.effectiveRoles)) {
    return { ok: false, error: "Согласовать переоткрытие может только собственник" };
  }
  const companyId = ctx.selectedCompanyId;
  const req = await loadScopedRequest(companyId, String(formData.get("requestId") ?? "").trim());
  if (!req) return { ok: false, error: "Запрос не найден" };
  if (req.status !== "pending") return { ok: false, error: "Запрос уже обработан" };
  // A requester can never approve their own request.
  if (req.requestedByUserId === ctx.user.id) {
    return { ok: false, error: "Нельзя согласовать собственный запрос" };
  }

  const comment = String(formData.get("comment") ?? "").trim() || null;
  await prisma.monthReopenRequest.update({
    where: { id: req.id },
    data: { status: "approved", reviewedByUserId: ctx.user.id, reviewedAt: new Date(), reviewComment: comment },
  });
  await recordAudit({
    action: "month.reopen_approved",
    entityType: "MonthReopenRequest",
    entityId: req.id,
    companyId,
    userId: ctx.user.id,
    metadata: { month: req.month, ...(comment ? { comment } : {}) },
  });

  revalidateMonthSurfaces();
  return { ok: true };
}

/** Owner rejects a pending reopening request (comment required). */
export async function rejectMonthReopen(_prev: ReopenState | undefined, formData: FormData): Promise<ReopenState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа" };
  if (!canApproveMonthReopen(ctx.effectiveRoles)) {
    return { ok: false, error: "Отклонить переоткрытие может только собственник" };
  }
  const companyId = ctx.selectedCompanyId;
  const req = await loadScopedRequest(companyId, String(formData.get("requestId") ?? "").trim());
  if (!req) return { ok: false, error: "Запрос не найден" };
  if (req.status !== "pending") return { ok: false, error: "Запрос уже обработан" };
  if (req.requestedByUserId === ctx.user.id) {
    return { ok: false, error: "Нельзя отклонить собственный запрос" };
  }
  const comment = String(formData.get("comment") ?? "").trim();
  if (!comment) return { ok: false, error: "Укажите причину отклонения" };

  await prisma.monthReopenRequest.update({
    where: { id: req.id },
    data: { status: "rejected", reviewedByUserId: ctx.user.id, reviewedAt: new Date(), reviewComment: comment },
  });
  await recordAudit({
    action: "month.reopen_rejected",
    entityType: "MonthReopenRequest",
    entityId: req.id,
    companyId,
    userId: ctx.user.id,
    metadata: { month: req.month, comment },
  });

  revalidateMonthSurfaces();
  return { ok: true };
}

/**
 * Chief Accountant executes an APPROVED request: reopens the MonthClose and marks
 * the request executed, atomically. Fails safely if the month is already open or
 * the request is not approved — a request can never be executed twice.
 */
export async function executeMonthReopen(_prev: ReopenState | undefined, formData: FormData): Promise<ReopenState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа" };
  if (!canExecuteMonthReopen(ctx.effectiveRoles)) {
    return { ok: false, error: "Переоткрыть месяц может только главный бухгалтер" };
  }
  const companyId = ctx.selectedCompanyId;
  const req = await loadScopedRequest(companyId, String(formData.get("requestId") ?? "").trim());
  if (!req) return { ok: false, error: "Запрос не найден" };

  if (req.status !== "approved") {
    await recordAudit({
      action: "month.reopen_execution_blocked",
      entityType: "MonthReopenRequest",
      entityId: req.id,
      companyId,
      userId: ctx.user.id,
      metadata: { month: req.month, reason: "not_approved", status: req.status },
    });
    return { ok: false, error: "Переоткрытие не согласовано или уже выполнено" };
  }

  // Atomic: re-check the close inside the transaction, flip MonthClose -> open,
  // and mark the request executed in one go. The conditional updateMany guards
  // against a concurrent execution (status must still be "approved").
  let blocked: string | null = null;
  await prisma.$transaction(async (tx) => {
    const closeRow = await tx.monthClose.findFirst({
      where: { companyId, clubId: SCOPE_CLUB_ID, month: req.month, status: "closed" },
    });
    if (!closeRow) {
      blocked = "Месяц уже открыт";
      return;
    }
    const claimed = await tx.monthReopenRequest.updateMany({
      where: { id: req.id, status: "approved" },
      data: { status: "executed", executedByUserId: ctx.user.id, executedAt: new Date() },
    });
    if (claimed.count === 0) {
      blocked = "Запрос уже выполнен";
      return;
    }
    await tx.monthClose.update({ where: { id: closeRow.id }, data: { status: "open" } });
  });

  if (blocked) {
    await recordAudit({
      action: "month.reopen_execution_blocked",
      entityType: "MonthReopenRequest",
      entityId: req.id,
      companyId,
      userId: ctx.user.id,
      metadata: { month: req.month, reason: blocked },
    });
    return { ok: false, error: blocked };
  }

  await recordAudit({
    action: "month.reopened",
    entityType: "MonthReopenRequest",
    entityId: req.id,
    companyId,
    userId: ctx.user.id,
    metadata: { month: req.month },
  });

  revalidateMonthSurfaces();
  return { ok: true };
}
