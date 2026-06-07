"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage, canCreateOperational } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { getCurrentAccessContext, canAccessClub, recordAudit } from "@/lib/access";
import { getExpenseForContext } from "@/lib/expenses";
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
  type UploadErrorCode,
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
  const clubId = String(formData.get("clubId") ?? "").trim();
  const fileEntry = formData.get("file");
  const file = isUploadedFile(fileEntry) && fileEntry.size > 0 ? fileEntry : null;
  const fileInfo = {
    fileName: file?.name ?? null,
    fileMime: file?.type ?? null,
    fileSize: file?.size ?? null,
  };

  function fail(code: UploadErrorCode, message = ""): AnalyzeState {
    logUploadFailure("expense", {
      code,
      message,
      userId: ctx?.user.id ?? null,
      companyId: ctx?.selectedCompanyId ?? null,
      clubId: clubId || null,
      ...fileInfo,
    });
    return { ok: false, errorCode: code, clubId: clubId || undefined };
  }

  try {
    ctx = await getCurrentAccessContext();
    if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "expenses")) return fail("ACCESS_DENIED");
    if (!canCreateOperational(ctx.effectiveRoles)) return fail("ACCESS_DENIED");

    if (!clubId) return fail("CLUB_REQUIRED");
    if (!ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
      return fail("ACCESS_DENIED");
    }

    if (!file) {
      // Manual entry (no file): return empty structure to fill by hand.
      return { ok: true, clubId, extraction: manualExpenseExtraction() };
    }

    const fileCode = validateExpenseFile(file);
    if (fileCode) return fail(fileCode);

    let buffer: Buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch (readError) {
      return fail("FILE_READ_FAILED", readError instanceof Error ? readError.message : "read failed");
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
        userId: ctx.user.id,
        companyId: ctx.selectedCompanyId,
        clubId,
        ...fileInfo,
      });
    }

    const extraction = await analyzeExpenseDocument({ buffer, mime: file.type, fileName: file.name });
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
    };
  } catch (error) {
    return fail("UNKNOWN_ERROR", error instanceof Error ? error.message : "unknown");
  }
}

export async function saveExpense(
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
