// REM-05 — the ONE official budget-fact service (spec §9, BD-04).
//
//   available = approvedBudget − recognizedFact
//
// `recognizedFact` is recognized EXPENSES by accounting month — the SAME
// loadRecognizedExpenses used by profit, so Plan-vs-Fact, "Использовано" and
// overrun alerts can never disagree again (closes FIN-003 / DATA-018/019). It
// includes v2 verified expenses and partially_paid invoices in full, and excludes
// payments/obligations/forecast/transfers. Committed obligations are a SEPARATE
// figure (liquidity), never folded into fact.

import { prisma } from "@/lib/prisma";
import type { DbClient } from "@/lib/db-client";
import { budgetCategoryLabel } from "@/lib/budgets";
import { loadRecognizedExpenses } from "./recognized-expense";
import { BUDGET_FACT_FORMULA_VERSION, UNASSIGNED_CATEGORY } from "./recognition";

export type BudgetFactInput = {
  companyId: string;
  allowedClubIds: string[];
  month: string; // "YYYY-MM"
  clubId?: string | null;
  category?: string | null;
  legalEntityId?: string | null;
  db?: DbClient;
};

export type BudgetFactCategoryRow = {
  category: string;
  label: string;
  budgetKopeks: number;
  factKopeks: number;
  availableKopeks: number;
  varianceKopeks: number; // fact - budget (positive = over)
};

export type BudgetFactResult = {
  month: string;
  approvedBudgetKopeks: number;
  recognizedFactKopeks: number;
  availableKopeks: number;
  varianceKopeks: number;
  rows: BudgetFactCategoryRow[];
  byCategory: Record<string, number>;
  warnings: string[];
  formulaVersion: string;
};

/** Approved-budget + recognized-fact, per category, for one month + scope. */
export async function calculateBudgetFact(input: BudgetFactInput): Promise<BudgetFactResult> {
  const db = input.db ?? prisma;
  const clubIds = input.clubId
    ? input.allowedClubIds.includes(input.clubId)
      ? [input.clubId]
      : []
    : input.allowedClubIds;

  const base: BudgetFactResult = {
    month: input.month,
    approvedBudgetKopeks: 0,
    recognizedFactKopeks: 0,
    availableKopeks: 0,
    varianceKopeks: 0,
    rows: [],
    byCategory: {},
    warnings: [],
    formulaVersion: BUDGET_FACT_FORMULA_VERSION,
  };
  if (!input.companyId || clubIds.length === 0) return base;

  const budgets = await db.budget.findMany({
    where: { companyId: input.companyId, clubId: { in: clubIds }, month: input.month, ...(input.category ? { category: input.category } : {}) },
    select: { category: true, limitAmountKopeks: true },
  });
  const budgetByCategory: Record<string, number> = {};
  for (const b of budgets) budgetByCategory[b.category] = (budgetByCategory[b.category] ?? 0) + b.limitAmountKopeks;

  const fact = await loadRecognizedExpenses({
    companyId: input.companyId,
    allowedClubIds: input.allowedClubIds,
    clubId: input.clubId ?? null,
    legalEntityId: input.legalEntityId ?? null,
    months: [input.month],
    category: input.category ?? null,
  });

  const approvedBudgetKopeks = Object.values(budgetByCategory).reduce((a, b) => a + b, 0);
  const recognizedFactKopeks = fact.totalKopeks;

  // One row per category that has a budget OR recognized fact (unassigned included).
  const categories = new Set<string>([...Object.keys(budgetByCategory), ...Object.keys(fact.byCategory)]);
  const rows: BudgetFactCategoryRow[] = [];
  for (const category of categories) {
    const budgetKopeks = budgetByCategory[category] ?? 0;
    const factKopeks = fact.byCategory[category] ?? 0;
    rows.push({
      category,
      label: category === UNASSIGNED_CATEGORY ? "Без категории" : budgetCategoryLabel(category),
      budgetKopeks,
      factKopeks,
      availableKopeks: budgetKopeks - factKopeks,
      varianceKopeks: factKopeks - budgetKopeks,
    });
  }
  rows.sort((a, b) => b.factKopeks - a.factKopeks);

  const warnings = [...fact.warnings];
  // Invariant guard (§19): the per-category facts must sum to the total.
  const sumRows = rows.reduce((a, r) => a + r.factKopeks, 0);
  if (sumRows !== recognizedFactKopeks) warnings.push(`category_sum_mismatch:${recognizedFactKopeks - sumRows}`);

  return {
    month: input.month,
    approvedBudgetKopeks,
    recognizedFactKopeks,
    availableKopeks: approvedBudgetKopeks - recognizedFactKopeks,
    varianceKopeks: recognizedFactKopeks - approvedBudgetKopeks,
    rows,
    byCategory: fact.byCategory,
    warnings,
    formulaVersion: BUDGET_FACT_FORMULA_VERSION,
  };
}
