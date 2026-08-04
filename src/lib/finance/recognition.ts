// REM-05 — the SINGLE source of truth for "what counts as a recognized expense"
// and its period/category/amount, per the ratified business decisions (BD-03/04/
// INVOICE/REFUND/TAX). PURE + client-safe (no prisma, no I/O) so predicates are
// identical in the services, the readers, the preflight and the tests.
//
// Four distinct quantities are NEVER mixed by a reader (BD accounting concepts):
//   A recognized REVENUE · B recognized EXPENSE · C cash MOVEMENT · D obligation.
// This module answers only B (recognized expense) + its period/category.

import { EXPENSE_REALIZED_STATUSES } from "@/lib/budgets";
import { APPROVED_UNPAID_STATUSES } from "@/lib/approval";

export const RECOGNIZED_EXPENSE_FORMULA_VERSION = "rem-05.v1";
export const PROFIT_FORMULA_VERSION = "rem-05.v1";
export const BUDGET_FACT_FORMULA_VERSION = "rem-05.v1";

/** Source kinds that contribute to a recognized expense. */
export type RecognizedSourceType =
  | "cash_expense"
  | "invoice"
  | "payroll_accrual"
  | "refund"
  | "tax"
  | "mandatory_expense";

// --- A. Ordinary Expense -----------------------------------------------------
// Realized at "confirmed" (v1) or "verified" (v2); everything else (draft/pending/
// rejected/cancelled/correction-draft) is NOT recognized. Reuses the one existing
// realized-status constant so budgets/analytics/recognition can never drift.
export const EXPENSE_RECOGNIZED_STATUSES: readonly string[] = EXPENSE_REALIZED_STATUSES;
export function isRecognizedExpenseStatus(status: string): boolean {
  return EXPENSE_RECOGNIZED_STATUSES.includes(status);
}

// --- B. Invoice --------------------------------------------------------------
// The FULL recognized amount is an expense by expensePeriod once the invoice is
// approved — approved-unpaid, partially_paid and paid all count in full (BD-INVOICE).
// The paid fraction NEVER scales the amount. Excludes draft/needs_review/rejected/
// cancelled. `partially_paid` is a DERIVED status (invoice-payments.ts), included here.
export const INVOICE_RECOGNIZED_STATUSES: readonly string[] = [
  ...APPROVED_UNPAID_STATUSES,
  "partially_paid",
  "paid",
];
export function isRecognizedInvoiceStatus(status: string): boolean {
  return INVOICE_RECOGNIZED_STATUSES.includes(status);
}

// --- C. Payroll accrual ------------------------------------------------------
// The APPROVED accrual (PayrollCalculation.netPayableKopeks) is the recognized labor
// expense, by PayrollPeriod (year-month) — once the period reaches an approved-or-
// beyond state. PayrollPayment / advance / obligation are cash/commitment, never a
// second expense. Draft/calculated (pre-approval) periods do NOT recognize.
export const PAYROLL_RECOGNIZED_PERIOD_STATUSES: readonly string[] = [
  "regional_approved",
  "approved",
  "partially_paid",
  "paid",
  "closed",
];
export function isRecognizedPayrollPeriodStatus(status: string): boolean {
  return PAYROLL_RECOGNIZED_PERIOD_STATUSES.includes(status);
}

// --- D. Refund ---------------------------------------------------------------
// A refund is a SEPARATE recognized expense (never a revenue reduction, never a
// parallel Expense row — the Refund IS the canonical source). Recognized in an
// approved-or-paid final state; rejected/cancelled/draft/in-review excluded.
export const REFUND_V1_RECOGNIZED_STATUSES: readonly string[] = [...APPROVED_UNPAID_STATUSES, "paid"];
export const REFUND_V2_RECOGNIZED_STATUSES: readonly string[] = ["accounting_in_progress", "paid"];
export function isRecognizedRefund(refund: { entryVersion?: number | null; status: string }): boolean {
  const v2 = (refund.entryVersion ?? 1) === 2;
  return (v2 ? REFUND_V2_RECOGNIZED_STATUSES : REFUND_V1_RECOGNIZED_STATUSES).includes(refund.status);
}
/** Canonical recognized refund amount: the calculated result if present, else the raw amount. */
export function refundRecognizedAmountKopeks(refund: { refundResultAmountKopeks?: number | null; amountKopeks: number }): number {
  return refund.refundResultAmountKopeks ?? refund.amountKopeks;
}

// --- E. Taxes / mandatory ----------------------------------------------------
// NO tax engine, NO rates. Taxes/contributions are recognized ONLY as real
// Expense/Invoice records carrying a tax/mandatory category. VAT inside an invoice
// total is NEVER added on top — the invoice total already includes it (BD-TAX).
export const TAX_CATEGORIES: readonly string[] = ["taxes", "tax", "contributions", "insurance_contributions"];
export const MANDATORY_CATEGORIES: readonly string[] = ["rent", "utilities", "mandatory"];
export function isTaxCategory(category: string | null | undefined): boolean {
  return !!category && TAX_CATEGORIES.includes(category);
}

/** Budget/analytics category used for payroll accrual + the fallback bucket. */
export const PAYROLL_BUDGET_CATEGORY = "salary";
export const REFUND_BUDGET_CATEGORY = "refunds";
export const UNASSIGNED_CATEGORY = "unassigned";

/** Map a source + its category to the source-type tag used in breakdowns. */
export function sourceTypeForExpense(category: string | null | undefined): RecognizedSourceType {
  if (isTaxCategory(category)) return "tax";
  if (category && MANDATORY_CATEGORIES.includes(category)) return "mandatory_expense";
  return "cash_expense";
}

/** Local "YYYY-MM" month key of a Date (no UTC shift — matches budgets.monthRange). */
export function monthKeyLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** True when a "YYYY-MM" month is inside the inclusive month list. */
export function monthInSet(month: string, months: readonly string[]): boolean {
  return months.includes(month);
}
