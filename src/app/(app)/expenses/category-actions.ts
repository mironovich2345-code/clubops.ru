"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { canManageExpenseCategories } from "@/lib/expense-categories";

type State = { ok: boolean; error?: string };

// Chief accountant ONLY (Part 8/13). Every change is audited; renames preserve
// history and never change the stable key so historical rows stay labelled.
async function requireChiefAccountant() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canManageExpenseCategories(ctx.effectiveRoles)) {
    return { error: "Управлять статьями расходов может только главный бухгалтер." as const };
  }
  return { ctx };
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

export async function createExpenseCategory(_prev: State | undefined, formData: FormData): Promise<State> {
  const guard = await requireChiefAccountant();
  if ("error" in guard) return { ok: false, error: guard.error };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Укажите название статьи." };

  let key = keyFrom(name);
  const existing = await prisma.expenseCategory.findUnique({ where: { key } });
  if (existing) key = `${key}_${Math.abs(hashCode(name + Date.now())).toString(36).slice(0, 4)}`;

  const cat = await prisma.$transaction(async (tx) => {
    const c = await tx.expenseCategory.create({ data: { key, name, isActive: true } });
    await tx.expenseCategoryNameHistory.create({ data: { categoryId: c.id, name, changedByUserId: guard.ctx.user.id } });
    return c;
  });
  await recordAudit({ action: "expense.category_created", entityType: "ExpenseCategory", entityId: cat.id, userId: guard.ctx.user.id, metadata: { key, name } });
  revalidatePath("/expenses/categories");
  return { ok: true };
}

export async function renameExpenseCategory(_prev: State | undefined, formData: FormData): Promise<State> {
  const guard = await requireChiefAccountant();
  if ("error" in guard) return { ok: false, error: guard.error };
  const id = String(formData.get("categoryId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Укажите название статьи." };
  const cat = await prisma.expenseCategory.findUnique({ where: { id } });
  if (!cat) return { ok: false, error: "Статья не найдена." };
  if (cat.name === name) return { ok: true };

  await prisma.$transaction(async (tx) => {
    await tx.expenseCategory.update({ where: { id }, data: { name } });
    await tx.expenseCategoryNameHistory.create({ data: { categoryId: id, name, changedByUserId: guard.ctx.user.id } });
  });
  await recordAudit({ action: "expense.category_renamed", entityType: "ExpenseCategory", entityId: id, userId: guard.ctx.user.id, metadata: { key: cat.key, from: cat.name, to: name } });
  revalidatePath("/expenses/categories");
  return { ok: true };
}

export async function setExpenseCategoryActive(formData: FormData): Promise<void> {
  const guard = await requireChiefAccountant();
  if ("error" in guard) return;
  const id = String(formData.get("categoryId") ?? "").trim();
  const active = String(formData.get("active") ?? "") === "true";
  const cat = await prisma.expenseCategory.findUnique({ where: { id } });
  if (!cat) return;
  // Never physically delete — only disable/reactivate. Historical expenses keep
  // displaying their category via the stable key.
  await prisma.expenseCategory.update({ where: { id }, data: { isActive: active } });
  await recordAudit({
    action: active ? "expense.category_reactivated" : "expense.category_disabled",
    entityType: "ExpenseCategory", entityId: id, userId: guard.ctx.user.id, metadata: { key: cat.key },
  });
  revalidatePath("/expenses/categories");
}
