"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { canImportPlansAndBudgets } from "@/lib/auth";
import { normalizeMonth } from "@/lib/sales-plans";
import { isUploadedFile } from "@/lib/uploaded-file";
import { BUDGET_CATEGORIES, budgetCategoryLabel } from "@/lib/budgets";
import { parseBudgetSheet, buildBudgetPreview, type BudgetPreviewRow } from "@/lib/imports/budget-import";

const CATEGORIES = BUDGET_CATEGORIES.map((c) => ({ key: c.key, label: budgetCategoryLabel(c.key) }));
const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

export type BudgetImportState = {
  ok: boolean;
  error?: string;
  month?: string;
  preview?: BudgetPreviewRow[];
  anyError?: boolean;
  applied?: { created: number; updated: number };
};

async function scopeClubs(companyId: string, clubIds: string[]) {
  if (clubIds.length === 0) return [];
  const clubs = await prisma.club.findMany({ where: { companyId, id: { in: clubIds } }, select: { id: true, name: true, city: true } });
  return clubs.map((c) => ({ id: c.id, name: c.name, city: c.city ?? "" }));
}

/** Owner/GD: parse an uploaded budget file → preview (no writes). */
export async function previewBudgetImport(_prev: BudgetImportState | undefined, formData: FormData): Promise<BudgetImportState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа." };
  if (!canImportPlansAndBudgets(ctx.effectiveRoles)) return { ok: false, error: "Импорт бюджетов доступен только владельцу или ген. директору." };
  const month = normalizeMonth(String(formData.get("month") ?? ""));
  if (!month) return { ok: false, error: "Укажите месяц." };
  const file = formData.get("file");
  if (!isUploadedFile(file)) return { ok: false, error: "Прикрепите файл шаблона (XLSX/CSV)." };
  const buffer = Buffer.from(await file.arrayBuffer());

  const { rows: raw, missing } = parseBudgetSheet(buffer);
  if (missing.length) return { ok: false, error: `В файле нет колонок: ${missing.join(", ")}.`, month };
  if (raw.length === 0) return { ok: false, error: "В файле нет строк с данными.", month };

  const clubs = await scopeClubs(ctx.selectedCompanyId, ctx.allowedClubIds);
  const budgets = await prisma.budget.findMany({ where: { companyId: ctx.selectedCompanyId, month, clubId: { in: clubs.map((c) => c.id) } }, select: { clubId: true, category: true, limitAmountKopeks: true } });
  const { rows, anyError } = buildBudgetPreview({ rawRows: raw, scopeClubs: clubs, categories: CATEGORIES, currentBudgets: budgets.map((b) => ({ clubId: b.clubId, category: b.category, limitKopeks: b.limitAmountKopeks })), month });
  return { ok: true, month, preview: rows, anyError };
}

/** Owner/GD: apply confirmed budget rows. ATOMIC — re-validates scope + category. */
export async function applyBudgetImport(_prev: BudgetImportState | undefined, formData: FormData): Promise<BudgetImportState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа." };
  if (!canImportPlansAndBudgets(ctx.effectiveRoles)) return { ok: false, error: "Импорт бюджетов доступен только владельцу или ген. директору." };
  const companyId = ctx.selectedCompanyId;
  const month = normalizeMonth(String(formData.get("month") ?? ""));
  if (!month) return { ok: false, error: "Укажите месяц." };

  let payload: { clubId: string; category: string; kopeks: number }[];
  try {
    const parsed = JSON.parse(String(formData.get("payload") ?? "[]"));
    if (!Array.isArray(parsed)) throw new Error("bad");
    payload = parsed;
  } catch {
    return { ok: false, error: "Не удалось прочитать данные для импорта." };
  }
  if (payload.length === 0) return { ok: false, error: "Нет строк для применения." };

  const allowed = new Set(ctx.allowedClubIds);
  for (const r of payload) {
    if (!r || typeof r.clubId !== "string" || !allowed.has(r.clubId)) return { ok: false, error: "Клуб вне вашего доступа." };
    if (typeof r.category !== "string" || !CATEGORY_KEYS.has(r.category)) return { ok: false, error: "Неверная статья бюджета." };
    if (!Number.isInteger(r.kopeks) || r.kopeks < 0) return { ok: false, error: "Некорректная сумма." };
  }
  const validClubIds = new Set((await prisma.club.findMany({ where: { companyId, id: { in: payload.map((r) => r.clubId) } }, select: { id: true } })).map((c) => c.id));
  for (const r of payload) if (!validClubIds.has(r.clubId)) return { ok: false, error: "Клуб не найден в компании." };

  let created = 0;
  let updated = 0;
  await prisma.$transaction(async (tx) => {
    for (const r of payload) {
      const existing = await tx.budget.findUnique({ where: { clubId_category_month: { clubId: r.clubId, category: r.category, month } }, select: { id: true } });
      await tx.budget.upsert({
        where: { clubId_category_month: { clubId: r.clubId, category: r.category, month } },
        create: { companyId, clubId: r.clubId, category: r.category, month, limitAmountKopeks: r.kopeks, createdByUserId: ctx.user.id },
        update: { limitAmountKopeks: r.kopeks },
      });
      if (existing) updated += 1; else created += 1;
    }
  });
  await recordAudit({ action: "budget.imported", entityType: "Budget", companyId, userId: ctx.user.id, metadata: { month, rows: payload.length, created, updated } });
  revalidatePath("/budgets");
  return { ok: true, month, applied: { created, updated } };
}
