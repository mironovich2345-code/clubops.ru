// REM-05 — the ONE official recognized-expense aggregator (spec §4/§5). Every
// profit / budget-fact / plan-vs-fact reader gets its expense total from here, so a
// recognized expense is counted exactly ONCE and identically everywhere. Accrual
// basis (recognition), never cash movement: it reads Expense / Invoice (full amount)
// / approved payroll accrual / Refund and DELIBERATELY ignores payments, cash
// movements, transfers, collections, «Приход Иное», forecast, obligations, budget.

import { prisma } from "@/lib/prisma";
import type { DbClient } from "@/lib/db-client";
import { invoiceExpensePeriod } from "@/lib/invoices";
import {
  RECOGNIZED_EXPENSE_FORMULA_VERSION,
  EXPENSE_RECOGNIZED_STATUSES,
  INVOICE_RECOGNIZED_STATUSES,
  PAYROLL_RECOGNIZED_PERIOD_STATUSES,
  isRecognizedRefund,
  refundRecognizedAmountKopeks,
  sourceTypeForExpense,
  isTaxCategory,
  monthKeyLocal,
  PAYROLL_BUDGET_CATEGORY,
  REFUND_BUDGET_CATEGORY,
  UNASSIGNED_CATEGORY,
  type RecognizedSourceType,
} from "./recognition";

export type RecognizedExpenseInput = {
  companyId: string;
  allowedClubIds: string[];
  clubId?: string | null;
  legalEntityId?: string | null;
  /** Inclusive list of accounting months ("YYYY-MM") to recognize. */
  months: string[];
  /** Restrict to a single budget category (optional). */
  category?: string | null;
  includeBreakdown?: boolean;
  db?: DbClient;
};

export type RecognizedRow = {
  sourceType: RecognizedSourceType;
  sourceId: string;
  clubId: string;
  legalEntityId: string | null;
  category: string;
  month: string;
  amountKopeks: number;
};

export type RecognizedExpenseResult = {
  totalKopeks: number;
  bySourceType: Record<string, number>;
  byCategory: Record<string, number>;
  byClub: Record<string, number>;
  byLegalEntity: Record<string, number>;
  warnings: string[];
  formulaVersion: string;
  rows?: RecognizedRow[];
};

function bump(map: Record<string, number>, key: string, v: number): void {
  map[key] = (map[key] ?? 0) + v;
}

/**
 * Load the recognized expenses for a scope + set of accounting months. Pure accrual
 * recognition; NEVER reads InvoicePayment / CashMovement / OtherIncome / transfers.
 */
export async function loadRecognizedExpenses(input: RecognizedExpenseInput): Promise<RecognizedExpenseResult> {
  const db = input.db ?? prisma;
  const clubIds = input.clubId
    ? input.allowedClubIds.includes(input.clubId)
      ? [input.clubId]
      : []
    : input.allowedClubIds;

  const empty: RecognizedExpenseResult = {
    totalKopeks: 0,
    bySourceType: {},
    byCategory: {},
    byClub: {},
    byLegalEntity: {},
    warnings: [],
    formulaVersion: RECOGNIZED_EXPENSE_FORMULA_VERSION,
    rows: input.includeBreakdown ? [] : undefined,
  };
  if (!input.companyId || clubIds.length === 0 || input.months.length === 0) return empty;

  const monthSet = new Set(input.months);
  const leFilter = input.legalEntityId ?? null;
  const catFilter = input.category ?? null;
  const warnings: string[] = [];
  const rows: RecognizedRow[] = [];
  const bySourceType: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byClub: Record<string, number> = {};
  const byLegalEntity: Record<string, number> = {};
  let total = 0;
  let unassignedCount = 0;

  const record = (r: RecognizedRow) => {
    if (catFilter && r.category !== catFilter) return;
    total += r.amountKopeks;
    bump(bySourceType, r.sourceType, r.amountKopeks);
    bump(byCategory, r.category, r.amountKopeks);
    bump(byClub, r.clubId, r.amountKopeks);
    bump(byLegalEntity, r.legalEntityId ?? "none", r.amountKopeks);
    if (input.includeBreakdown) rows.push(r);
  };

  // A. Ordinary Expense (v1 confirmed / v2 verified) — by expenseDate month.
  const expenses = await db.expense.findMany({
    where: { companyId: input.companyId, clubId: { in: clubIds }, status: { in: [...EXPENSE_RECOGNIZED_STATUSES] }, ...(leFilter ? { legalEntityId: leFilter } : {}) },
    select: { id: true, clubId: true, legalEntityId: true, category: true, amountKopeks: true, expenseDate: true },
  });
  for (const e of expenses) {
    const month = monthKeyLocal(e.expenseDate);
    if (!monthSet.has(month)) continue;
    const category = e.category || UNASSIGNED_CATEGORY;
    if (!e.category) unassignedCount++;
    record({ sourceType: sourceTypeForExpense(e.category), sourceId: e.id, clubId: e.clubId, legalEntityId: e.legalEntityId ?? null, category, month, amountKopeks: e.amountKopeks });
  }

  // B. Invoice — FULL amount by expensePeriod, recognized statuses (incl. partially_paid).
  const invoices = await db.invoice.findMany({
    where: { companyId: input.companyId, clubId: { in: clubIds }, status: { in: [...INVOICE_RECOGNIZED_STATUSES] }, ...(leFilter ? { legalEntityId: leFilter } : {}) },
    select: { id: true, clubId: true, legalEntityId: true, expenseCategory: true, amountKopeks: true, expensePeriod: true, invoiceDate: true, paidAt: true, createdAt: true },
  });
  for (const i of invoices) {
    const month = invoiceExpensePeriod(i);
    if (!monthSet.has(month)) continue;
    const category = i.expenseCategory || UNASSIGNED_CATEGORY;
    if (!i.expenseCategory) unassignedCount++;
    const sourceType: RecognizedSourceType = isTaxCategory(i.expenseCategory) ? "tax" : "invoice";
    record({ sourceType, sourceId: i.id, clubId: i.clubId, legalEntityId: i.legalEntityId ?? null, category, month, amountKopeks: i.amountKopeks });
  }

  // C. Payroll accrual — netPayable of calcs whose PERIOD is approved-or-beyond, by period month.
  const periods = await db.payrollPeriod.findMany({
    where: { companyId: input.companyId, clubId: { in: clubIds }, status: { in: [...PAYROLL_RECOGNIZED_PERIOD_STATUSES] } },
    select: { id: true, clubId: true, year: true, month: true },
  });
  const periodInScope = periods.filter((p) => monthSet.has(`${p.year}-${String(p.month).padStart(2, "0")}`));
  if (periodInScope.length) {
    const periodById = new Map(periodInScope.map((p) => [p.id, p]));
    const calcs = await db.payrollCalculation.findMany({
      where: { payrollPeriodId: { in: periodInScope.map((p) => p.id) }, ...(leFilter ? { legalEntityId: leFilter } : {}) },
      select: { id: true, clubId: true, legalEntityId: true, netPayableKopeks: true, payrollPeriodId: true },
    });
    for (const c of calcs) {
      const p = periodById.get(c.payrollPeriodId);
      if (!p) continue;
      const month = `${p.year}-${String(p.month).padStart(2, "0")}`;
      record({ sourceType: "payroll_accrual", sourceId: c.id, clubId: c.clubId, legalEntityId: c.legalEntityId ?? null, category: PAYROLL_BUDGET_CATEGORY, month, amountKopeks: c.netPayableKopeks });
    }
  }

  // D. Refund — separate recognized expense, once, by recognition date.
  const refunds = await db.refund.findMany({
    where: { companyId: input.companyId, clubId: { in: clubIds }, ...(leFilter ? { legalEntityId: leFilter } : {}) },
    select: { id: true, clubId: true, legalEntityId: true, entryVersion: true, status: true, amountKopeks: true, refundResultAmountKopeks: true, refundDate: true, paidAt: true, createdAt: true },
  });
  for (const r of refunds) {
    if (!isRecognizedRefund(r)) continue;
    const month = monthKeyLocal(r.refundDate ?? r.paidAt ?? r.createdAt);
    if (!monthSet.has(month)) continue;
    record({ sourceType: "refund", sourceId: r.id, clubId: r.clubId, legalEntityId: r.legalEntityId ?? null, category: REFUND_BUDGET_CATEGORY, month, amountKopeks: refundRecognizedAmountKopeks(r) });
  }

  if (unassignedCount > 0) warnings.push(`unassigned_category:${unassignedCount}`);

  return {
    totalKopeks: total,
    bySourceType,
    byCategory,
    byClub,
    byLegalEntity,
    warnings,
    formulaVersion: RECOGNIZED_EXPENSE_FORMULA_VERSION,
    rows: input.includeBreakdown ? rows : undefined,
  };
}
