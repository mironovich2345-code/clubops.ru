// Payment-obligation abstraction for the payment calendar.
//
// Today invoices are the ONLY real payment source. This module introduces a
// source-agnostic `PaymentObligation` shape plus adapters so the calendar, the
// dashboard widget and the accountant workspace can later include recurring
// mandatory payments and payroll WITHOUT touching the calendar maths again.
//
// Nothing here changes current behaviour: the invoice adapter is loss-less and
// mandatory/payroll loaders return [] for now (documented TODOs below).
import { prisma } from "@/lib/prisma";
import { expenseCategoryLabel } from "@/lib/expenses";
import {
  loadPaymentInvoices,
  monthKeyOf,
  dayStart,
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

/** Human source label for a calendar row (Part 5): Счёт / Обязательный платёж. */
export function paymentSourceLabel(sourceType: PaymentSourceType): string {
  switch (sourceType) {
    case "invoice":
      return "Счёт";
    case "mandatory_payment":
      return "Обязательный платёж";
    case "payroll":
      return "Зарплата";
  }
}

/** Category label resolved per source (mandatory categories differ from expense). */
export function paymentObligationCategoryLabel(o: PaymentObligation): string {
  if (o.sourceType === "mandatory_payment") {
    return MANDATORY_PAYMENT_CATEGORY_LABELS[o.category] ?? o.category;
  }
  return expenseCategoryLabel(o.categoryRaw ?? null);
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

// Active plan shape needed to expand into obligations.
export type MandatoryPlanRow = {
  id: string;
  companyId: string;
  clubId: string;
  clubName: string;
  city: string | null;
  category: string;
  title: string;
  amountKopeks: number;
  dueDayOfMonth: number | null;
  dueDate: Date | null;
  recurrence: string;
  responsibleUserId: string | null;
  status: string;
  isActive: boolean;
  notes: string | null;
};

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function planToObligation(p: MandatoryPlanRow, due: Date, today: Date): PaymentObligation {
  const overdue = dayStart(due).getTime() < today.getTime();
  return {
    id: `mp_${p.id}_${isoDay(due)}`,
    sourceType: "mandatory_payment",
    sourceId: p.id,
    companyId: p.companyId,
    clubId: p.clubId,
    clubName: p.clubName,
    city: p.city,
    category: p.category,
    title: p.title,
    amountKopeks: p.amountKopeks,
    dueDate: due,
    status: overdue ? "overdue" : "planned",
    paidAt: null,
    responsibleUserId: p.responsibleUserId,
    notes: p.notes,
    href: "/mandatory-payments",
    rawStatus: p.status,
    categoryRaw: p.category,
    counterpartyName: p.title, // shown as the secondary label in calendar rows
    legalEntityName: null,
  };
}

/**
 * Pure expansion of active plans into obligations within [windowStart, windowEnd]
 * (both day-inclusive). Monthly plans emit one occurrence per month on
 * dueDayOfMonth (clamped to the month length); one-time plans emit their dueDate.
 * Only planned + active plans generate (paused / canceled disappear).
 */
export function generateMandatoryObligations(
  plans: MandatoryPlanRow[],
  windowStart: Date,
  windowEnd: Date,
  now: Date,
): PaymentObligation[] {
  const start = dayStart(windowStart);
  const end = dayStart(windowEnd);
  const today = dayStart(now);
  const out: PaymentObligation[] = [];
  if (start.getTime() > end.getTime()) return out;

  for (const p of plans) {
    if (!p.isActive || p.status !== "planned") continue;

    if (p.recurrence === "monthly") {
      if (p.dueDayOfMonth == null) continue;
      let cur = new Date(start.getFullYear(), start.getMonth(), 1);
      const lastMonth = new Date(end.getFullYear(), end.getMonth(), 1);
      while (cur.getTime() <= lastMonth.getTime()) {
        const daysInMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
        const day = Math.min(Math.max(1, p.dueDayOfMonth), daysInMonth);
        const occ = new Date(cur.getFullYear(), cur.getMonth(), day);
        if (occ.getTime() >= start.getTime() && occ.getTime() <= end.getTime()) {
          out.push(planToObligation(p, occ, today));
        }
        cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      }
    } else {
      // recurrence "none" — one-time payment on dueDate
      if (!p.dueDate) continue;
      const occ = dayStart(p.dueDate);
      if (occ.getTime() >= start.getTime() && occ.getTime() <= end.getTime()) {
        out.push(planToObligation(p, occ, today));
      }
    }
  }
  return out;
}

/**
 * Loads active mandatory plans for the scope and expands them into obligations
 * within [windowStart, windowEnd]. Scope-safe: companyId + allowed clubIds only.
 */
export async function loadMandatoryPaymentObligations(
  companyId: string,
  clubIds: string[],
  windowStart: Date,
  windowEnd: Date,
): Promise<PaymentObligation[]> {
  if (clubIds.length === 0) return [];
  const plans = await prisma.mandatoryPaymentPlan.findMany({
    where: { companyId, clubId: { in: clubIds }, isActive: true, status: "planned" },
    select: {
      id: true, companyId: true, clubId: true, category: true, title: true, amountKopeks: true,
      dueDayOfMonth: true, dueDate: true, recurrence: true, responsibleUserId: true, status: true,
      isActive: true, notes: true,
      club: { select: { name: true, city: true } },
    },
  });
  const rows: MandatoryPlanRow[] = plans.map((p) => ({
    id: p.id,
    companyId: p.companyId,
    clubId: p.clubId,
    clubName: p.club.name,
    city: p.club.city,
    category: p.category,
    title: p.title,
    amountKopeks: p.amountKopeks,
    dueDayOfMonth: p.dueDayOfMonth,
    dueDate: p.dueDate,
    recurrence: p.recurrence,
    responsibleUserId: p.responsibleUserId,
    status: p.status,
    isActive: p.isActive,
    notes: p.notes,
  }));
  return generateMandatoryObligations(rows, windowStart, windowEnd, new Date());
}

// ---------------------------------------------------------------------------
// Part 4 / Payroll preparation — future payroll calendar (design only, no module
// built yet). These types + the buildPayrollObligations() placeholder define the
// integration contract so payroll plugs into the SAME PaymentObligation pipeline.
//
// TODO Future module: payroll calendar. Each employee pay period yields up to two
// payroll obligations — an Advance (аванс) and a Final Salary payout (расчёт).
// When implemented, buildPayrollObligations() must emit PaymentObligation[] with
// sourceType "payroll", and they will AUTOMATICALLY appear in:
//   • Payment Calendar (day details / KPIs)        — via loadPaymentObligationsForScope
//   • Upcoming Payments                              — same obligation list
//   • Cash Gap / Balance Forecast (lib/balance.ts)   — obligations feed the forecast
//   • Accountant Workspace                           — same loader
//   • Dashboard payment widget (if relevant)
// No calendar/forecast maths change — only this loader needs a real body.
// ---------------------------------------------------------------------------

/** Payroll payout kind: advance (аванс) or final salary (расчёт). */
export type PayrollType = "advance" | "final_salary";

/** Lifecycle of a payroll payout (mirrors the obligation lifecycle). */
export type PayrollStatus = "planned" | "approved" | "paid" | "canceled";

// One employee pay-period record the payroll module will own.
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

// A single payroll payout that becomes a PaymentObligation on the calendar.
// (sourceType maps to "payroll"; category to "salary".)
export type PayrollObligation = {
  id: string;
  payrollItemId: string;
  companyId: string;
  clubId: string;
  employeeName: string;
  payrollType: PayrollType; // advance | final_salary
  amountKopeks: number;
  dueDate: Date;
  status: PayrollStatus;
  paidAt: Date | null;
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
  // Lower bound for expanding recurring mandatory payments. Defaults to the start
  // of the previous month so recent overdue + the current window are covered.
  windowStart?: Date;
}): Promise<{ obligations: PaymentObligation[] }> {
  const { companyId, clubIds, loadEnd } = args;
  if (clubIds.length === 0) return { obligations: [] };
  const windowStart = args.windowStart ?? new Date(loadEnd.getFullYear(), loadEnd.getMonth() - 1, 1);

  const [{ obligations: invoices }, mandatory, payroll] = await Promise.all([
    loadPaymentInvoices(companyId, clubIds, loadEnd, args.monthKey ?? monthKeyOf(loadEnd)),
    loadMandatoryPaymentObligations(companyId, clubIds, windowStart, loadEnd),
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
