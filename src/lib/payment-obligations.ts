// Payment-obligation abstraction for the payment calendar.
//
// Today invoices are the ONLY real payment source. This module introduces a
// source-agnostic `PaymentObligation` shape plus adapters so the calendar, the
// dashboard widget and the accountant workspace can later include recurring
// mandatory payments and payroll WITHOUT touching the calendar maths again.
//
// Nothing here changes current behaviour: the invoice adapter is loss-less and
// mandatory/payroll loaders return [] for now (documented TODOs below).
import { expenseCategoryLabel } from "@/lib/expenses";
import {
  loadPaymentInvoices,
  monthKeyOf,
  type PaymentInvoice,
} from "@/lib/payments";

// ---------------------------------------------------------------------------
// Part 1 — shared payment-obligation type
// ---------------------------------------------------------------------------

export type PaymentSourceType = "invoice" | "mandatory_payment" | "payroll";

export type PaymentObligationStatus =
  | "planned"
  | "pending"
  | "paid"
  | "overdue"
  | "canceled";

export type PaymentObligation = {
  id: string;
  sourceType: PaymentSourceType;
  sourceId: string;
  companyId: string;
  clubId: string;
  clubName: string;
  city: string | null;
  category: string; // normalized, non-null category key (for generic grouping)
  title: string; // human label for the row (supplier / category)
  amountKopeks: number;
  dueDate: Date;
  status: PaymentObligationStatus;
  paidAt: Date | null;
  responsibleUserId?: string | null;
  notes?: string | null;
  href?: string;
  // --- source-specific display passthrough (optional) ---------------------
  // Lets the existing calendar UI render the exact same invoice details while
  // the calc layer stays source-agnostic. Non-invoice sources may leave unset.
  rawStatus?: string; // original source status (e.g. invoice "approved_by_owner")
  categoryRaw?: string | null; // original nullable category for exact labelling
  counterpartyName?: string | null;
  legalEntityName?: string | null;
};

function mapInvoiceStatus(status: string): PaymentObligationStatus {
  if (status === "paid") return "paid";
  if (status === "canceled" || status === "rejected") return "canceled";
  return "pending"; // unpaid obligation; "overdue" is derived from dueDate in the UI
}

/**
 * Loss-less adapter: PaymentInvoice -> PaymentObligation. Keeps the invoice id as
 * the obligation id so existing `/invoices/{id}` links stay identical. `companyId`
 * is passed in (PaymentInvoice does not carry it).
 *
 * Note: dueDate is asserted non-null because the obligation loader only feeds
 * invoices that already have a dueDate (see loadPaymentInvoices' query filter).
 */
export function invoiceToPaymentObligation(invoice: PaymentInvoice, companyId: string): PaymentObligation {
  return {
    id: invoice.id,
    sourceType: "invoice",
    sourceId: invoice.id,
    companyId,
    clubId: invoice.clubId,
    clubName: invoice.clubName,
    city: invoice.city,
    category: invoice.expenseCategory ?? "other",
    title: invoice.counterpartyName ?? expenseCategoryLabel(invoice.expenseCategory),
    amountKopeks: invoice.amountKopeks,
    dueDate: invoice.dueDate as Date,
    status: mapInvoiceStatus(invoice.status),
    paidAt: invoice.paidAt,
    href: `/invoices/${invoice.id}`,
    rawStatus: invoice.status,
    categoryRaw: invoice.expenseCategory,
    counterpartyName: invoice.counterpartyName,
    legalEntityName: invoice.legalEntityName,
  };
}

// ---------------------------------------------------------------------------
// Part 2 — mandatory payment categories
// ---------------------------------------------------------------------------

// Categories for future recurring mandatory payments. Kept SEPARATE from
// EXPENSE_CATEGORY_OPTIONS on purpose — there is no safe shared mapping yet (the
// key sets only partially overlap, e.g. salary/rent/taxes/advertising). A future
// mapping helper can bridge them when the DB model lands.
export const MANDATORY_PAYMENT_CATEGORIES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "salary", label: "Зарплата" },
  { key: "cleaning", label: "Клининг" },
  { key: "security", label: "Охрана" },
  { key: "music", label: "Музыка" },
  { key: "internet", label: "Интернет" },
  { key: "telephony", label: "Телефония" },
  { key: "rent", label: "Аренда" },
  { key: "taxes", label: "Налоги" },
  { key: "utilities", label: "Коммунальные" },
  { key: "advertising", label: "Реклама" },
  { key: "banking", label: "Банковские услуги / эквайринг" },
];

export const MANDATORY_PAYMENT_CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  MANDATORY_PAYMENT_CATEGORIES.map((c) => [c.key, c.label]),
);

// ---------------------------------------------------------------------------
// Part 3 — future mandatory-payment plan (design only; no DB model yet)
// ---------------------------------------------------------------------------

export type PaymentRecurrence = "none" | "weekly" | "monthly" | "quarterly" | "yearly";

// TODO Future DB model: MandatoryPaymentPlan
// A recurring obligation template (rent, cleaning, security, …) that the
// calendar will expand into PaymentObligation[] per due date.
export type MandatoryPaymentPlan = {
  id: string;
  companyId: string;
  clubId: string;
  category: string; // one of MANDATORY_PAYMENT_CATEGORIES keys
  title: string;
  amountKopeks: number;
  dueDate: Date;
  recurrence: PaymentRecurrence;
  responsibleUserId: string | null;
  status: PaymentObligationStatus;
  paidAt: Date | null;
  notes: string | null;
};

/**
 * TODO adapter — returns [] until the MandatoryPaymentPlan model exists. When
 * implemented it must expand active plans (by recurrence) into PaymentObligation[]
 * within [now, loadEnd] and merge into loadPaymentObligationsForScope below.
 */
export async function loadMandatoryPaymentObligations(
  _companyId: string,
  _clubIds: string[],
  _loadEnd: Date,
): Promise<PaymentObligation[]> {
  return [];
}

// ---------------------------------------------------------------------------
// Part 4 — future payroll calendar (design only)
// ---------------------------------------------------------------------------

// TODO Future module: payroll calendar. Each employee period yields up to two
// obligations — an advance and a final salary payout.
export type PayrollCalendarItem = {
  id: string;
  companyId: string;
  clubId: string;
  employeeName: string;
  position: string;
  fixedPartKopeks: number;
  bonusKopeks: number;
  deductionKopeks: number;
  advanceKopeks: number;
  finalAmountKopeks: number;
  payoutDate: Date;
  status: PaymentObligationStatus;
};

/**
 * Placeholder — returns [] for now. The future payroll module will generate
 * advance + final-salary obligations from PayrollCalendarItem[]. Those must then
 * flow into: /payments, upcoming payments, cash-gap risk, the accountant
 * workspace and (if relevant) the dashboard widget — automatically, because they
 * become PaymentObligation[] consumed by the same calc layer.
 */
export async function buildPayrollObligations(
  _companyId: string,
  _clubIds: string[],
  _loadEnd: Date,
): Promise<PaymentObligation[]> {
  return [];
}

// ---------------------------------------------------------------------------
// Part 8 — unified obligation loader (invoices + future sources)
// ---------------------------------------------------------------------------

/**
 * Scope-safe obligation loader shared by /payments and the accountant workspace.
 * Today it returns invoice obligations only; mandatory + payroll loaders return
 * [] so output is unchanged. Invoice order (dueDate asc) is preserved.
 */
export async function loadPaymentObligationsForScope(args: {
  companyId: string;
  clubIds: string[];
  loadEnd: Date;
  monthKey?: string;
}): Promise<{ obligations: PaymentObligation[] }> {
  const { companyId, clubIds, loadEnd } = args;
  if (clubIds.length === 0) return { obligations: [] };

  const [{ obligations: invoices }, mandatory, payroll] = await Promise.all([
    loadPaymentInvoices(companyId, clubIds, loadEnd, args.monthKey ?? monthKeyOf(loadEnd)),
    loadMandatoryPaymentObligations(companyId, clubIds, loadEnd),
    buildPayrollObligations(companyId, clubIds, loadEnd),
  ]);

  const obligations: PaymentObligation[] = [
    ...invoices.map((i) => invoiceToPaymentObligation(i, companyId)),
    ...mandatory,
    ...payroll,
  ];
  return { obligations };
}

// ---------------------------------------------------------------------------
// Part 6 — cash-gap helper (pure)
// ---------------------------------------------------------------------------

export type CashGapResult =
  | { state: "ok"; projectedBalanceKopeks: number; deficitKopeks: number; hasRisk: boolean }
  | { state: "insufficient_data"; projectedBalanceKopeks: null; deficitKopeks: null; hasRisk: false };

/**
 * projectedBalance = currentCash − obligations. Deficit/risk when negative.
 * Returns "insufficient_data" when the cash balance is unknown — never invents a
 * balance. No NaN/Infinity (integer subtraction only).
 */
export function calculateCashGap(args: { currentCashKopeks: number | null; obligationsKopeks: number }): CashGapResult {
  if (args.currentCashKopeks === null) {
    return { state: "insufficient_data", projectedBalanceKopeks: null, deficitKopeks: null, hasRisk: false };
  }
  const projectedBalanceKopeks = args.currentCashKopeks - args.obligationsKopeks;
  const hasRisk = projectedBalanceKopeks < 0;
  return {
    state: "ok",
    projectedBalanceKopeks,
    deficitKopeks: hasRisk ? Math.abs(projectedBalanceKopeks) : 0,
    hasRisk,
  };
}

// ---------------------------------------------------------------------------
// Part 7 — required money by date (pure)
// ---------------------------------------------------------------------------

export type RequiredMoneyResult = {
  obligationsUntilDateKopeks: number;
  projectedBalanceKopeks: number | null; // null when cash is unknown
  requiredAdditionalSalesKopeks: number | null; // null when cash is unknown
};

/**
 * Supports the future "сколько денег нужно добрать продажами" view:
 * projectedBalance = currentCash − obligationsUntilDate; if negative, that gap is
 * the additional sales required. "insufficient_data" → nulls (no invented cash).
 */
export function calculateRequiredMoneyByDate(args: {
  currentCashKopeks: number | null;
  obligationsUntilDateKopeks: number;
}): RequiredMoneyResult {
  if (args.currentCashKopeks === null) {
    return {
      obligationsUntilDateKopeks: args.obligationsUntilDateKopeks,
      projectedBalanceKopeks: null,
      requiredAdditionalSalesKopeks: null,
    };
  }
  const projectedBalanceKopeks = args.currentCashKopeks - args.obligationsUntilDateKopeks;
  return {
    obligationsUntilDateKopeks: args.obligationsUntilDateKopeks,
    projectedBalanceKopeks,
    requiredAdditionalSalesKopeks: projectedBalanceKopeks < 0 ? Math.abs(projectedBalanceKopeks) : 0,
  };
}
