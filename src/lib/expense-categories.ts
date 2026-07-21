// Managed expense categories (Part 8) with SYSTEM + COMPANY ownership isolation.
//
//  - SYSTEM categories (isSystem=true, companyId=null): the platform-wide taxonomy,
//    seeded from the canonical code list. Visible to EVERY company. Never editable,
//    renamable or disable-able by a tenant. Stable keys keep analytics consistent.
//  - COMPANY categories (isSystem=false, companyId=<Company>): private to that
//    company. Created/renamed/disabled only by that company's chief accountant.
//    Invisible to other companies; one company's key/name never affects another.
//
// `key` stays globally unique (stable identifier stored on Expense.category), so a
// company category never collides with a system key and historical rows stay
// labelled. Cross-tenant isolation is enforced by scoping every read/validation to
// (isSystem OR companyId === current company). Server-only.
import { prisma } from "@/lib/prisma";
import type { Role } from "@/lib/auth";
import { EXPENSE_CATEGORY_OPTIONS } from "@/lib/expenses";

// The canonical, code-defined taxonomy — the ONLY keys that may ever be system
// categories. A company category can never claim one of these keys.
export const SYSTEM_CATEGORY_KEYS: ReadonlySet<string> = new Set(EXPENSE_CATEGORY_OPTIONS.map((c) => c.key));

export function isSystemCategoryKey(key: string): boolean {
  return SYSTEM_CATEGORY_KEYS.has(key);
}

/** ONLY the chief accountant manages categories (Part 8/13) — and only their OWN
 * company's categories (enforced in the actions). Fail-closed. */
export function canManageExpenseCategories(roles: readonly Role[]): boolean {
  return roles.includes("chief_accountant");
}

/**
 * Seed the SYSTEM taxonomy (idempotent). Marks rows isSystem=true, companyId=null.
 * "refunds" is a system category owned by the refund flow — seeded implicitly via
 * the migration if present, but NOT created here and never manager-selectable.
 * Also flags any pre-existing canonical rows as system (belt-and-suspenders).
 */
export async function ensureExpenseCategoriesSeeded(): Promise<void> {
  const existing = new Set((await prisma.expenseCategory.findMany({ select: { key: true } })).map((r) => r.key));
  const toCreate = EXPENSE_CATEGORY_OPTIONS.filter((c) => c.key !== "refunds" && !existing.has(c.key));
  if (toCreate.length > 0) {
    await prisma.$transaction(
      toCreate.map((c) => prisma.expenseCategory.create({ data: { key: c.key, name: c.label, isActive: true, isSystem: true } })),
    );
  }
  // Ensure canonical keys are always system-flagged (covers legacy pre-scope rows).
  await prisma.expenseCategory.updateMany({
    where: { key: { in: [...SYSTEM_CATEGORY_KEYS] }, isSystem: false },
    data: { isSystem: true },
  });
}

export type CategoryView = { id: string; key: string; name: string; isActive: boolean; isSystem: boolean; companyId: string | null };

const mapRow = (r: { id: string; key: string; name: string; isActive: boolean; isSystem: boolean; companyId: string | null }): CategoryView =>
  ({ id: r.id, key: r.key, name: r.name, isActive: r.isActive, isSystem: r.isSystem, companyId: r.companyId });

/** Active categories a company may SELECT for a new expense: system categories +
 * the company's own. "refunds" is excluded (owned by the refund flow). */
export async function getActiveExpenseCategories(companyId: string): Promise<CategoryView[]> {
  const rows = await prisma.expenseCategory.findMany({
    where: { isActive: true, key: { not: "refunds" }, OR: [{ isSystem: true }, { companyId }] },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
  return rows.map(mapRow);
}

/** The company's OWN active custom categories only (no system rows). */
export async function getCompanyOwnedExpenseCategories(companyId: string): Promise<CategoryView[]> {
  const rows = await prisma.expenseCategory.findMany({
    where: { isActive: true, isSystem: false, companyId },
    orderBy: { name: "asc" },
  });
  return rows.map(mapRow);
}

/** All categories VISIBLE to a company in the management view: system (read-only) +
 * the company's own (editable). Never another company's categories. */
export async function getAllExpenseCategoriesForCompany(companyId: string): Promise<CategoryView[]> {
  const rows = await prisma.expenseCategory.findMany({
    where: { OR: [{ isSystem: true }, { companyId }] },
    orderBy: [{ isSystem: "desc" }, { isActive: "desc" }, { name: "asc" }],
  });
  return rows.map(mapRow);
}

/**
 * True if `key` is an ACTIVE category the given company may use for a NEW expense:
 * an active SYSTEM category, OR an active category owned by THIS company. A category
 * key from ANOTHER company resolves to false (the OR filter excludes it), so a
 * client-supplied key is never sufficient proof of ownership. "refunds" is excluded
 * (managers never select it; the refund flow sets it directly).
 */
export async function isActiveExpenseCategoryKey(key: string, companyId: string): Promise<boolean> {
  if (!key || key === "refunds") return false;
  const row = await prisma.expenseCategory.findFirst({
    where: { key, isActive: true, OR: [{ isSystem: true }, { companyId }] },
    select: { id: true },
  });
  return row !== null;
}

/** Display name for a stored category key (managed table first, static fallback).
 * Keys are globally unique so this is safe across companies (labels only). */
export async function categoryDisplayName(key: string): Promise<string> {
  const row = await prisma.expenseCategory.findUnique({ where: { key }, select: { name: true } });
  if (row) return row.name;
  const stat = EXPENSE_CATEGORY_OPTIONS.find((c) => c.key === key);
  return stat?.label ?? key;
}
