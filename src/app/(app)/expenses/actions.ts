"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage, canCreateOperational } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { getCurrentAccessContext, canAccessClub, recordAudit } from "@/lib/access";
import { getExpenseForContext, EXPENSE_STATUS_CANCELED, EXPENSE_ACTIVE_STATUSES, isExpenseCancelable } from "@/lib/expenses";
import { revertExpenseBatchIfAllInactive } from "@/lib/import-batches";
import { monthClosedError, isMonthClosed, MONTH_CLOSED_ERROR } from "@/lib/month-close";
import {
  evaluateExpenseBudget,
  currentMonthKey,
  SOURCE_STATUS_WAITING,
} from "@/lib/budgets";
import { PAYMENT_METHOD_KEYS } from "@/lib/expenses";
import { getClubEntityByType, getClubLegalEntities } from "@/lib/legal-entities";
import {
  analyzeExpenseDocument,
  manualExpenseExtraction,
  type ExpenseExtraction,
} from "@/lib/ai/expense-analyzer";
import { validateExpenseFile, persistExpenseFile } from "@/lib/expense-storage";
import { isUploadedFile } from "@/lib/uploaded-file";
import {
  UPLOAD_ERROR_MESSAGES,
  logUploadFailure,
  newRequestId,
  type UploadErrorCode,
  type UploadStage,
} from "@/lib/upload-errors";

type AnalyzeState = {
  ok: boolean;
  errorCode?: UploadErrorCode;
  clubId?: string;
  storageKey?: string;
  fileName?: string;
  fileMime?: string;
  fileSize?: number;
  extraction?: ExpenseExtraction;
  /** True when the file uploaded but AI recognition failed (recoverable). */
  analysisFailed?: boolean;
};

type SaveState = { ok: boolean; error?: string; expenseId?: string; budgetPending?: boolean };

const EXPENSE_TYPES = new Set(["receipt", "transfer", "manual", "payroll_statement"]);

function str(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? "").trim();
  return v || null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

type ParsedFields = {
  type: string;
  category: string;
  vendorName: string | null;
  recipientName: string | null;
  transferComment: string | null;
  amountKopeks: number;
  currency: string;
  expenseDate: Date;
  address: string | null;
  itemsJson: string | null;
  notes: string | null;
  paymentMethod: string | null;
};

function parseExpenseFields(formData: FormData): { data?: ParsedFields; error?: string } {
  const category = str(formData, "category");
  if (!category) return { error: "Выберите статью расходов" };

  const amountRaw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const amount = amountRaw === "" ? 0 : Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: "Сумма должна быть неотрицательным числом" };
  }

  const typeRaw = String(formData.get("type") ?? "manual").trim();
  const type = EXPENSE_TYPES.has(typeRaw) ? typeRaw : "manual";

  const items = String(formData.get("items") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    data: {
      type,
      category,
      vendorName: str(formData, "vendorName"),
      recipientName: str(formData, "recipientName"),
      transferComment: str(formData, "transferComment"),
      amountKopeks: rublesToKopeks(amount),
      currency: str(formData, "currency") ?? "RUB",
      expenseDate: parseDate(str(formData, "purchaseDate")) ?? new Date(),
      address: str(formData, "address"),
      itemsJson: items.length > 0 ? JSON.stringify(items) : null,
      notes: str(formData, "notes"),
      paymentMethod: PAYMENT_METHOD_KEYS.includes(String(formData.get("paymentMethod") ?? "")) ? String(formData.get("paymentMethod")) : null,
    },
  };
}

async function clubCompanyId(clubId: string): Promise<string | null> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  return club?.companyId ?? null;
}

export async function uploadAndAnalyzeExpense(
  _prev: AnalyzeState | undefined,
  formData: FormData,
): Promise<AnalyzeState> {
  let ctx: Awaited<ReturnType<typeof getCurrentAccessContext>> = null;
  const requestId = newRequestId();
  const clubId = String(formData.get("clubId") ?? "").trim();
  const fileEntry = formData.get("file");
  const file = isUploadedFile(fileEntry) && fileEntry.size > 0 ? fileEntry : null;
  const fileInfo = {
    fileName: file?.name ?? null,
    fileMime: file?.type ?? null,
    fileSize: file?.size ?? null,
  };

  function fail(code: UploadErrorCode, stage: UploadStage, message = ""): AnalyzeState {
    logUploadFailure("expense", {
      code,
      message,
      requestId,
      stage,
      userId: ctx?.user.id ?? null,
      companyId: ctx?.selectedCompanyId ?? null,
      clubId: clubId || null,
      ...fileInfo,
    });
    return { ok: false, errorCode: code, clubId: clubId || undefined };
  }

  try {
    ctx = await getCurrentAccessContext();
    if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "expenses")) return fail("ACCESS_DENIED", "validate");
    if (!canCreateOperational(ctx.effectiveRoles)) return fail("ACCESS_DENIED", "validate");

    if (!clubId) return fail("CLUB_REQUIRED", "validate");
    if (!ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
      return fail("ACCESS_DENIED", "validate");
    }

    if (!file) {
      // Manual entry (no file): return empty structure to fill by hand.
      return { ok: true, clubId, extraction: manualExpenseExtraction() };
    }

    const fileCode = validateExpenseFile(file);
    if (fileCode) return fail(fileCode, "validate");

    let buffer: Buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch (readError) {
      return fail("FILE_READ_FAILED", "upload", readError instanceof Error ? readError.message : "read failed");
    }

    // Best-effort persist: recognition still works from the in-memory buffer.
    let storageKey: string | undefined;
    let size = file.size;
    let storageFailed = false;
    try {
      const stored = await persistExpenseFile(buffer, file.type, file.name);
      storageKey = stored.storageKey;
      size = stored.size;
    } catch (storeError) {
      storageFailed = true;
      logUploadFailure("expense", {
        code: "STORAGE_FAILED",
        message: storeError instanceof Error ? storeError.message : "store failed",
        requestId,
        stage: "upload",
        userId: ctx.user.id,
        companyId: ctx.selectedCompanyId,
        clubId,
        ...fileInfo,
      });
    }

    const { extraction, analysisFailed } = await analyzeExpenseDocument({ buffer, mime: file.type, fileName: file.name });
    if (analysisFailed) {
      logUploadFailure("expense", {
        code: "AI_PROVIDER_FAILED",
        message: "analysis failed; recoverable",
        requestId,
        stage: "analyze",
        userId: ctx.user.id,
        companyId: ctx.selectedCompanyId,
        clubId,
        ...fileInfo,
      });
    }
    if (storageFailed) {
      extraction.warnings = [UPLOAD_ERROR_MESSAGES.STORAGE_FAILED, ...extraction.warnings];
    }

    try {
      await recordAudit({
        action: "expense.uploaded",
        entityType: "Expense",
        companyId: ctx.selectedCompanyId,
        clubId,
        userId: ctx.user.id,
        metadata: { fileName: file.name, mime: file.type, size },
      });
      await recordAudit({
        action: "expense.extracted",
        entityType: "Expense",
        companyId: ctx.selectedCompanyId,
        clubId,
        userId: ctx.user.id,
        metadata: { confidence: extraction.confidence, mode: extraction.mode },
      });
    } catch (auditError) {
      console.error("expense audit failed", auditError instanceof Error ? auditError.message : auditError);
    }

    return {
      ok: true,
      clubId,
      storageKey,
      fileName: file.name,
      fileMime: file.type,
      fileSize: size,
      extraction,
      analysisFailed,
    };
  } catch (error) {
    return fail("UNKNOWN_ERROR", "render-response", error instanceof Error ? error.message : "unknown");
  }
}

/**
 * Public save action. Wraps the implementation so an unexpected runtime/DB error
 * surfaces as a clean inline message instead of bubbling to the global error
 * boundary (which would blank the whole page). All financial/permission/scope
 * checks live in saveExpenseImpl and are unchanged.
 */
export async function saveExpense(
  prev: SaveState | undefined,
  formData: FormData,
): Promise<SaveState> {
  try {
    return await saveExpenseImpl(prev, formData);
  } catch (error) {
    // Sanitized: no stack trace / payload reaches the client.
    console.error("[expense:save]", error instanceof Error ? error.message : "unknown save error");
    return { ok: false, error: "Не удалось сохранить расход. Проверьте поля и повторите." };
  }
}

async function saveExpenseImpl(
  _prev: SaveState | undefined,
  formData: FormData,
): Promise<SaveState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "expenses")) {
    return { ok: false, error: "Нет доступа" };
  }
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return { ok: false, error: "Создавать расходы могут управляющие и региональные директора" };
  }

  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }
  const companyId = await clubCompanyId(clubId);
  if (!companyId || companyId !== ctx.selectedCompanyId) {
    return { ok: false, error: "Клуб не найден" };
  }

  const parsed = parseExpenseFields(formData);
  if (parsed.error || !parsed.data) return { ok: false, error: parsed.error ?? "Ошибка данных" };

  const closedSave = await monthClosedError(companyId, clubId, parsed.data.expenseDate);
  if (closedSave) return { ok: false, error: closedSave };

  // Legal-entity routing. Cash expenses MUST belong to the club's active ИП
  // (auto-assigned, ООО blocked); non-cash may use any active club entity.
  let legalEntityId: string | null = null;
  if (parsed.data.paymentMethod === "cash") {
    const ip = await getClubEntityByType(clubId, "ip");
    if (!ip) {
      return { ok: false, error: "Для наличного расхода необходимо привязать ИП к клубу" };
    }
    legalEntityId = ip.id;
  } else {
    const requested = str(formData, "legalEntityId");
    if (requested) {
      const attached = await getClubLegalEntities(clubId);
      legalEntityId = attached.some((e) => e.id === requested) ? requested : null;
    }
  }

  const confidenceRaw = String(formData.get("confidence") ?? "low");
  const confidence = ["low", "medium", "high"].includes(confidenceRaw) ? confidenceRaw : "low";

  // Budget-overrun gate: if this expense would push the category's monthly spend
  // over its budget, it does NOT auto-count. Create it as waiting and raise a
  // budget-approval request; it stays out of dashboards/budgets until approved.
  const month = currentMonthKey(parsed.data.expenseDate);
  const evalBudget = await evaluateExpenseBudget(
    clubId,
    parsed.data.category,
    month,
    parsed.data.amountKopeks,
  );
  const overBudget = evalBudget.hasLimit && evalBudget.projectedKopeks > evalBudget.limitKopeks;

  const expense = await prisma.expense.create({
    data: {
      companyId,
      clubId,
      createdByUserId: ctx.user.id,
      ...parsed.data,
      legalEntityId,
      confidence,
      status: overBudget ? SOURCE_STATUS_WAITING : "confirmed",
      originalFileName: str(formData, "fileName"),
      originalFileMime: str(formData, "fileMime"),
      originalFileSize: Number(formData.get("fileSize")) || null,
      originalFileStorageKey: str(formData, "storageKey"),
      rawExtractedJson: str(formData, "rawExtractedJson"),
    },
  });

  await recordAudit({
    action: "expense.created",
    entityType: "Expense",
    entityId: expense.id,
    companyId,
    clubId,
    userId: ctx.user.id,
    metadata: { type: expense.type, amountKopeks: expense.amountKopeks, status: expense.status },
  });

  if (overBudget) {
    const request = await prisma.budgetApprovalRequest.create({
      data: {
        companyId,
        clubId,
        category: parsed.data.category,
        month,
        sourceType: "expense",
        sourceId: expense.id,
        budgetId: evalBudget.budgetId,
        requestedAmountKopeks: parsed.data.amountKopeks,
        budgetAmountKopeks: evalBudget.limitKopeks,
        currentSpentKopeks: evalBudget.usedKopeks,
        projectedSpentKopeks: evalBudget.projectedKopeks,
        overrunKopeks: evalBudget.overrunKopeks,
        reason: parsed.data.notes,
        status: "pending",
        requestedByUserId: ctx.user.id,
        // Legacy (non-null) columns kept consistent with the new fields.
        currentLimitAmountKopeks: evalBudget.limitKopeks,
        overByAmountKopeks: evalBudget.overrunKopeks,
        overByPercent:
          evalBudget.limitKopeks > 0 ? (evalBudget.overrunKopeks / evalBudget.limitKopeks) * 100 : 0,
      },
    });
    await recordAudit({
      action: "budget_approval.created",
      entityType: "BudgetApprovalRequest",
      entityId: request.id,
      companyId,
      clubId,
      userId: ctx.user.id,
      metadata: {
        sourceType: "expense",
        sourceId: expense.id,
        category: parsed.data.category,
        month,
        overrunKopeks: evalBudget.overrunKopeks,
      },
    });
    revalidatePath("/budgets");
    revalidatePath("/dashboard");
  }

  revalidatePath("/expenses");
  return { ok: true, expenseId: expense.id, budgetPending: overBudget };
}

export async function updateExpense(
  _prev: SaveState | undefined,
  formData: FormData,
): Promise<SaveState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "expenses")) {
    return { ok: false, error: "Нет доступа" };
  }

  const expenseId = String(formData.get("expenseId") ?? "").trim();
  const existing = await getExpenseForContext(ctx, expenseId);
  if (!existing) return { ok: false, error: "Расход не найден или нет доступа" };

  const closedUpd = await monthClosedError(existing.companyId, existing.clubId, existing.expenseDate);
  if (closedUpd) return { ok: false, error: closedUpd };

  const parsed = parseExpenseFields(formData);
  if (parsed.error || !parsed.data) return { ok: false, error: parsed.error ?? "Ошибка данных" };

  await prisma.expense.update({ where: { id: expenseId }, data: parsed.data });

  await recordAudit({
    action: "expense.updated",
    entityType: "Expense",
    entityId: expenseId,
    companyId: existing.companyId,
    clubId: existing.clubId,
    userId: ctx.user.id,
  });

  revalidatePath("/expenses");
  revalidatePath(`/expenses/${expenseId}`);
  return { ok: true, expenseId };
}

// --- cancellation (soft delete) --------------------------------------------

type CancelState = { ok: boolean; error?: string };

function revalidateFinancial() {
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  revalidatePath("/budgets");
  revalidatePath("/analytics");
}

/**
 * Soft-cancel a single expense (status -> canceled). It then no longer counts in
 * dashboard / analytics / budgets / exports. A pending budget-approval request,
 * if any, is removed. Manager/regional only; a manager may cancel only their own
 * expense, a regional director any expense in assigned clubs.
 */
export async function cancelExpense(
  _prev: CancelState | undefined,
  formData: FormData,
): Promise<CancelState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "expenses")) return { ok: false, error: "Нет доступа" };
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return { ok: false, error: "Отменять расходы могут управляющие и региональные директора" };
  }

  const expenseId = String(formData.get("expenseId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim() || null;
  const existing = await getExpenseForContext(ctx, expenseId);
  if (!existing) return { ok: false, error: "Расход не найден или нет доступа" };

  const isRegional = ctx.effectiveRoles.includes("regional_director");
  if (!isRegional && existing.createdByUserId !== ctx.user.id) {
    return { ok: false, error: "Управляющий может отменить только свой расход" };
  }
  if (!isExpenseCancelable(existing.status)) {
    return { ok: false, error: "Этот расход нельзя отменить" };
  }
  const closedCancel = await monthClosedError(existing.companyId, existing.clubId, existing.expenseDate);
  if (closedCancel) return { ok: false, error: closedCancel };

  await prisma.budgetApprovalRequest.deleteMany({ where: { sourceType: "expense", sourceId: existing.id, status: "pending" } });
  await prisma.expense.update({ where: { id: existing.id }, data: { status: EXPENSE_STATUS_CANCELED } });

  await recordAudit({
    action: "expense.canceled",
    entityType: "Expense",
    entityId: existing.id,
    companyId: existing.companyId,
    clubId: existing.clubId,
    userId: ctx.user.id,
    metadata: { prevStatus: existing.status, amountKopeks: existing.amountKopeks, category: existing.category, reason },
  });

  // If this was the last active row of its import, mark the batch reverted so the
  // same file can be re-imported (Part 3).
  if (existing.importBatchId) {
    await revertExpenseBatchIfAllInactive(existing.importBatchId, {
      userId: ctx.user.id,
      companyId: existing.companyId,
      clubId: existing.clubId,
      action: "import.reverted_by_expense_cancel",
    });
  }

  revalidateFinancial();
  revalidatePath(`/expenses/${existing.id}`);
  return { ok: true };
}

// --- monthly bulk cancel ---------------------------------------------------

type BulkState = { ok: boolean; error?: string; count?: number; totalKopeks?: number; done?: boolean };

function monthRangeDates(month: string): { start: Date; end: Date } | null {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: new Date(y, mo, 1), end: new Date(y, mo + 1, 1) };
}

type BulkWhere = {
  where: import("@prisma/client").Prisma.ExpenseWhereInput;
  month: string;
  clubId: string;
  category: string | null;
};

/** Scoped WHERE for the bulk cancel — only active rows in one club + month,
 * never trusting client values beyond the user's allowed clubs. */
async function buildBulkWhere(
  ctx: NonNullable<Awaited<ReturnType<typeof getCurrentAccessContext>>>,
  formData: FormData,
): Promise<BulkWhere | { error: string }> {
  const month = String(formData.get("month") ?? "").trim();
  const clubId = String(formData.get("clubId") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const range = monthRangeDates(month);
  if (!range) return { error: "Укажите месяц в формате ГГГГ-ММ" };
  if (!clubId) return { error: "Выберите клуб" };
  if (!ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { error: "Нет доступа к выбранному клубу" };
  }
  const isRegional = ctx.effectiveRoles.includes("regional_director");
  const where: import("@prisma/client").Prisma.ExpenseWhereInput = {
    companyId: ctx.selectedCompanyId!,
    clubId,
    expenseDate: { gte: range.start, lt: range.end },
    // Only active financial rows — never already canceled / rejected / reverted.
    status: { in: [...EXPENSE_ACTIVE_STATUSES] },
    ...(category ? { category } : {}),
    // A manager can bulk-cancel only their own expenses in their own club.
    ...(isRegional ? {} : { createdByUserId: ctx.user.id }),
  };
  return { where, month, clubId, category: category || null };
}

export async function previewBulkCancelExpenses(
  _prev: BulkState | undefined,
  formData: FormData,
): Promise<BulkState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || !canAnyRoleAccessPage(ctx.effectiveRoles, "expenses")) {
    return { ok: false, error: "Нет доступа" };
  }
  if (!canCreateOperational(ctx.effectiveRoles)) return { ok: false, error: "Недостаточно прав" };
  const built = await buildBulkWhere(ctx, formData);
  if ("error" in built) return { ok: false, error: built.error };
  const agg = await prisma.expense.aggregate({ where: built.where, _count: true, _sum: { amountKopeks: true } });
  return { ok: true, count: agg._count, totalKopeks: agg._sum.amountKopeks ?? 0 };
}

export async function cancelExpensesForMonth(
  _prev: BulkState | undefined,
  formData: FormData,
): Promise<BulkState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || !canAnyRoleAccessPage(ctx.effectiveRoles, "expenses")) {
    return { ok: false, error: "Нет доступа" };
  }
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return { ok: false, error: "Массовую отмену могут делать управляющие и региональные директора" };
  }
  if (String(formData.get("confirm") ?? "").trim() !== "ОТМЕНИТЬ") {
    return { ok: false, error: "Введите ОТМЕНИТЬ заглавными буквами для подтверждения" };
  }
  const built = await buildBulkWhere(ctx, formData);
  if ("error" in built) return { ok: false, error: built.error };
  if (await isMonthClosed(ctx.selectedCompanyId, built.clubId, built.month)) {
    return { ok: false, error: MONTH_CLOSED_ERROR };
  }

  const matches = await prisma.expense.findMany({ where: built.where, select: { id: true, amountKopeks: true, importBatchId: true } });
  if (matches.length === 0) {
    return { ok: true, count: 0, totalKopeks: 0, done: true };
  }
  const ids = matches.map((m) => m.id);
  const totalKopeks = matches.reduce((s, m) => s + m.amountKopeks, 0);
  const reason = String(formData.get("reason") ?? "").trim() || null;

  await prisma.budgetApprovalRequest.deleteMany({ where: { sourceType: "expense", sourceId: { in: ids }, status: "pending" } });
  await prisma.expense.updateMany({ where: { id: { in: ids } }, data: { status: EXPENSE_STATUS_CANCELED } });

  await recordAudit({
    action: "expense.bulk_canceled",
    entityType: "Expense",
    companyId: ctx.selectedCompanyId,
    clubId: built.clubId,
    userId: ctx.user.id,
    metadata: { month: built.month, clubId: built.clubId, category: built.category, count: ids.length, totalAmount: totalKopeks, reason },
  });

  // Flip any import batch whose rows are now all inactive so the file can be
  // re-imported (Part 2).
  const batchIds = [...new Set(matches.map((m) => m.importBatchId).filter((b): b is string => !!b))];
  for (const batchId of batchIds) {
    await revertExpenseBatchIfAllInactive(batchId, {
      userId: ctx.user.id,
      companyId: ctx.selectedCompanyId,
      clubId: built.clubId,
      action: "import.reverted_by_bulk_cancel",
    });
  }

  revalidateFinancial();
  return { ok: true, count: ids.length, totalKopeks, done: true };
}
