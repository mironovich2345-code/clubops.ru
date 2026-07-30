// Single source of truth for expense workflow status buckets. Shared by the expenses
// LIST filters (expenses/page.tsx) and the ИП cash-balance card (cash-balances.ts) so
// their status definitions can never silently drift apart again. Money elsewhere is
// integer kopeks — these are pure status sets, no arithmetic.
//
// Relationship (proven by scripts/audit-expense-summary-consistency.mjs):
//   card «Расходы ИП на проверке»  = cash-pending statuses, restricted to ONE club's
//                                    active ИП, paymentMethod=cash, entryVersion=2.
//   list «На проверке»             = review statuses, across the whole page scope.
//   list «Требуют исправления»     = needs_correction, across the whole page scope.
//   cash-pending                   = review ∪ needs_correction (both still draw cash).
// So the card is a SCOPE-narrowed subset of («На проверке» ∪ «Требуют исправления») —
// same status master set, different (intentional) scope.

// Active review stages. `submitted` is a real resting state ("Отправлен") — it MUST be
// here so an in-flight expense is never invisible in the list (previously it was in no
// filter yet counted by the card). `waiting_budget_approval` is the legacy v1 pending.
export const EXPENSE_REVIEW_STATUSES = [
  "submitted",
  "pending_regional_budget_approval",
  "pending_owner_budget_approval",
  "pending_accountant_verification",
  "waiting_budget_approval",
] as const;

export const EXPENSE_NEEDS_CORRECTION_STATUS = "needs_correction";

// Realized / finalised spend (legacy `confirmed` + v2 `verified`).
export const EXPENSE_VERIFIED_STATUSES = ["verified", "confirmed"] as const;

export const EXPENSE_CANCELLED_STATUSES = ["cancelled", "canceled", "import_reverted"] as const;

// Expenses that still draw down ИП cash: every review stage PLUS awaiting-correction
// (an expense bounced back for correction has not been undone — it still holds cash).
export const EXPENSE_CASH_PENDING_STATUSES = [
  ...EXPENSE_REVIEW_STATUSES,
  EXPENSE_NEEDS_CORRECTION_STATUS,
] as const;

const has = (set: readonly string[], s: string) => set.includes(s);
export const isExpenseOnReview = (s: string) => has(EXPENSE_REVIEW_STATUSES, s);
export const isExpenseNeedsCorrection = (s: string) => s === EXPENSE_NEEDS_CORRECTION_STATUS;
export const isExpenseVerified = (s: string) => has(EXPENSE_VERIFIED_STATUSES, s);
export const isExpenseCancelled = (s: string) => has(EXPENSE_CANCELLED_STATUSES, s);
export const isExpenseCashPending = (s: string) => has(EXPENSE_CASH_PENDING_STATUSES, s);
