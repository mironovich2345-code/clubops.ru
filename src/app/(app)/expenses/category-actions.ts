"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { canManageExpenseCategories, isSystemCategoryKey } from "@/lib/expense-categories";

type State = { ok: boolean; error?: string };

// Chief accountant ONLY (Part 8/13), and only for their OWN company's categories.
// System categories are read-only for tenants. Every change is audited; renames
// preserve history and never change the stable key so historical rows stay labelled.
async function requireCategoryManager() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canManageExpenseCategories(ctx.effectiveRoles)) {
    return { error: "Управлять статьями расходов может только главный бухгалтер." as const };
  }
  if (!ctx.selectedCompanyId) {
    return { error: "Не выбрана компания." as const };
  }
  return { ctx, companyId: ctx.selectedCompanyId };
}

function keyFrom(name: string): string {
  // Stable slug; falls back to a random suffix for non-latin names.
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return base || `cat_${Math.abs(hashCode(name)).toString(36)}`;
}
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

// Resolve a globally-unique, company-owned key: never a system key, never colliding
// with any existing category (system or any company). `key` is opaque to users.
async function resolveCompanyKey(name: string): Promise<string> {
  let key = keyFrom(name);
  // A company category can never claim a system key.
  if (isSystemCategoryKey(key)) key = `c_${key}`;
  const existing = await prisma.expenseCategory.findUnique({ where: { key }, select: { id: true } });
  if (existing || isSystemCategoryKey(key)) {
    key = `${key}_${Math.abs(hashCode(name + Date.now())).toString(36).slice(0, 5)}`;
  }
  return key;
}

export async function createExpenseCategory(_prev: State | undefined, formData: FormData): Promise<State> {
  const guard = await requireCategoryManager();
  if ("error" in guard) return { ok: false, error: guard.error };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Укажите название статьи." };

  const key = await resolveCompanyKey(name);

  const cat = await prisma.$transaction(async (tx) => {
    // COMPANY-owned custom category (isSystem=false, companyId set). Private to this company.
    const c = await tx.expenseCategory.create({ data: { key, name, isActive: true, isSystem: false, companyId: guard.companyId } });
    await tx.expenseCategoryNameHistory.create({ data: { categoryId: c.id, name, changedByUserId: guard.ctx.user.id } });
    return c;
  });
  await recordAudit({ action: "expense.category_created", entityType: "ExpenseCategory", entityId: cat.id, companyId: guard.companyId, userId: guard.ctx.user.id, metadata: { key, name, scope: "company" } });
  revalidatePath("/expenses/categories");
  return { ok: true };
}

export async function renameExpenseCategory(_prev: State | undefined, formData: FormData): Promise<State> {
  const guard = await requireCategoryManager();
  if ("error" in guard) return { ok: false, error: guard.error };
  const id = String(formData.get("categoryId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Укажите название статьи." };
  const cat = await prisma.expenseCategory.findUnique({ where: { id } });
  if (!cat) return { ok: false, error: "Статья не найдена." };
  // Cannot touch a system category, nor another company's category.
  if (cat.isSystem) return { ok: false, error: "Системную статью нельзя переименовать." };
  if (cat.companyId !== guard.companyId) return { ok: false, error: "Статья не найдена." };
  if (cat.name === name) return { ok: true };

  await prisma.$transaction(async (tx) => {
    await tx.expenseCategory.update({ where: { id }, data: { name } });
    await tx.expenseCategoryNameHistory.create({ data: { categoryId: id, name, changedByUserId: guard.ctx.user.id } });
  });
  await recordAudit({ action: "expense.category_renamed", entityType: "ExpenseCategory", entityId: id, companyId: guard.companyId, userId: guard.ctx.user.id, metadata: { key: cat.key, from: cat.name, to: name } });
  revalidatePath("/expenses/categories");
  return { ok: true };
}

export async function setExpenseCategoryActive(formData: FormData): Promise<void> {
  const guard = await requireCategoryManager();
  if ("error" in guard) return;
  const id = String(formData.get("categoryId") ?? "").trim();
  const active = String(formData.get("active") ?? "") === "true";
  const cat = await prisma.expenseCategory.findUnique({ where: { id } });
  if (!cat) return;
  // System categories and other companies' categories are read-only here.
  if (cat.isSystem || cat.companyId !== guard.companyId) return;
  // Never physically delete — only disable/reactivate. Historical expenses keep
  // displaying their category via the stable key. Affects THIS company only.
  await prisma.expenseCategory.update({ where: { id }, data: { isActive: active } });
  await recordAudit({
    action: active ? "expense.category_reactivated" : "expense.category_disabled",
    entityType: "ExpenseCategory", entityId: id, companyId: guard.companyId, userId: guard.ctx.user.id, metadata: { key: cat.key },
  });
  revalidatePath("/expenses/categories");
}
