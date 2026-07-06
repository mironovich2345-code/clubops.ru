// Managed expense categories (Part 8). Chief accountant only may create/rename/
// disable/reactivate; renames preserve history and never change the stable key,
// so historical expenses stay correctly labelled. Server-only.
import { prisma } from "@/lib/prisma";
import type { Role } from "@/lib/auth";
import { EXPENSE_CATEGORY_OPTIONS } from "@/lib/expenses";

/** ONLY the chief accountant manages categories (Part 8/13). Fail-closed. */
export function canManageExpenseCategories(roles: readonly Role[]): boolean {
  return roles.includes("chief_accountant");
}

/**
 * Ensure the managed ExpenseCategory table is seeded from the canonical static
 * list (idempotent). Legacy expenses store these keys; seeding lets the new
 * form select from DB categories without breaking historical labels.
 */
export async function ensureExpenseCategoriesSeeded(): Promise<void> {
  const count = await prisma.expenseCategory.count();
  if (count > 0) return;
  await prisma.$transaction(
    EXPENSE_CATEGORY_OPTIONS
      // "refunds" is a system category owned by the refund flow — not manager-selectable.
      .filter((c) => c.key !== "refunds")
      .map((c) => prisma.expenseCategory.create({ data: { key: c.key, name: c.label, isActive: true } })),
  );
}

export type CategoryView = { id: string; key: string; name: string; isActive: boolean };

export async function getActiveExpenseCategories(): Promise<CategoryView[]> {
  const rows = await prisma.expenseCategory.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
  return rows.map((r) => ({ id: r.id, key: r.key, name: r.name, isActive: r.isActive }));
}

export async function getAllExpenseCategories(): Promise<CategoryView[]> {
  const rows = await prisma.expenseCategory.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] });
  return rows.map((r) => ({ id: r.id, key: r.key, name: r.name, isActive: r.isActive }));
}

/** True if `key` is an ACTIVE managed category (guards new-expense selection). */
export async function isActiveExpenseCategoryKey(key: string): Promise<boolean> {
  const row = await prisma.expenseCategory.findUnique({ where: { key }, select: { isActive: true } });
  return Boolean(row?.isActive);
}

/** Display name for a stored category key (managed table first, static fallback). */
export async function categoryDisplayName(key: string): Promise<string> {
  const row = await prisma.expenseCategory.findUnique({ where: { key }, select: { name: true } });
  if (row) return row.name;
  const stat = EXPENSE_CATEGORY_OPTIONS.find((c) => c.key === key);
  return stat?.label ?? key;
}
