"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { getCurrentAccessContext, canAccessClub, recordAudit } from "@/lib/access";
import { getExpenseForContext } from "@/lib/expenses";
import {
  analyzeExpenseDocument,
  manualExpenseExtraction,
  type ExpenseExtraction,
} from "@/lib/ai/expense-analyzer";
import { validateExpenseFile, storeExpenseFile } from "@/lib/expense-storage";

type AnalyzeState = {
  ok: boolean;
  error?: string;
  clubId?: string;
  storageKey?: string;
  fileName?: string;
  fileMime?: string;
  fileSize?: number;
  extraction?: ExpenseExtraction;
};

type SaveState = { ok: boolean; error?: string; expenseId?: string };

const EXPENSE_TYPES = new Set(["receipt", "transfer", "manual"]);

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
  amountKopeks: number;
  currency: string;
  expenseDate: Date;
  address: string | null;
  itemsJson: string | null;
  notes: string | null;
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
      amountKopeks: rublesToKopeks(amount),
      currency: str(formData, "currency") ?? "RUB",
      expenseDate: parseDate(str(formData, "purchaseDate")) ?? new Date(),
      address: str(formData, "address"),
      itemsJson: items.length > 0 ? JSON.stringify(items) : null,
      notes: str(formData, "notes"),
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
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "expenses")) {
    return { ok: false, error: "Нет доступа" };
  }

  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }

  const file = formData.get("file");
  const hasFile = file instanceof File && file.size > 0;

  if (hasFile) {
    const fileError = validateExpenseFile(file);
    if (fileError) return { ok: false, error: fileError };

    const stored = await storeExpenseFile(file);
    const extraction = await analyzeExpenseDocument({
      buffer: stored.buffer,
      mime: stored.mime,
      fileName: stored.fileName,
    });

    await recordAudit({
      action: "expense.uploaded",
      entityType: "Expense",
      companyId: ctx.selectedCompanyId,
      clubId,
      userId: ctx.user.id,
      metadata: { fileName: stored.fileName, mime: stored.mime, size: stored.size },
    });
    await recordAudit({
      action: "expense.extracted",
      entityType: "Expense",
      companyId: ctx.selectedCompanyId,
      clubId,
      userId: ctx.user.id,
      metadata: { confidence: extraction.confidence },
    });

    return {
      ok: true,
      clubId,
      storageKey: stored.storageKey,
      fileName: stored.fileName,
      fileMime: stored.mime,
      fileSize: stored.size,
      extraction,
    };
  }

  // Manual entry (no file): return empty structure to fill by hand.
  return { ok: true, clubId, extraction: manualExpenseExtraction() };
}

export async function saveExpense(
  _prev: SaveState | undefined,
  formData: FormData,
): Promise<SaveState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "expenses")) {
    return { ok: false, error: "Нет доступа" };
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

  const confidenceRaw = String(formData.get("confidence") ?? "low");
  const confidence = ["low", "medium", "high"].includes(confidenceRaw) ? confidenceRaw : "low";

  const expense = await prisma.expense.create({
    data: {
      companyId,
      clubId,
      createdByUserId: ctx.user.id,
      ...parsed.data,
      confidence,
      status: "confirmed",
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
    metadata: { type: expense.type, amountKopeks: expense.amountKopeks },
  });

  revalidatePath("/expenses");
  return { ok: true, expenseId: expense.id };
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
