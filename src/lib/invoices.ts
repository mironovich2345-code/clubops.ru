import { createHash } from "node:crypto";
import type { Invoice } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DataScope, AccessContext } from "@/lib/access";
import { managerCannotSeeRecord } from "@/lib/access";
import type { Role } from "@/lib/auth";

export type InvoiceStatus =
  | "draft"
  | "needs_review"
  | "needs_correction"
  | "approved_by_regional"
  | "approved_by_chief_accountant"
  | "approved_by_owner" // legacy — kept readable/payable, never produced by new actions
  | "paid"
  | "rejected"
  | "canceled";

// Denial messages shared by the invoice + refund decision tables (kept as plain
// strings so the pure decision modules stay free of server-only imports).
export const APPROVAL_REGIONAL_ONLY_MSG = "Согласование доступно региональному директору этого клуба";
export const APPROVAL_FALLBACK_CHIEF_MSG =
  "Согласование может выполнить главный бухгалтер, так как региональный директор не назначен";

// Options resolved by the caller (server action / server page) before applying a
// workflow action: whether an ACTIVE regional approver exists for the club, and
// whether the actor created the record (self-approval is forbidden).
export type ApprovalContext = { hasActiveRegional: boolean; isCreator: boolean };

export type InvoiceConfidence = "low" | "medium" | "high";

// --- Expense period (accounting month an invoice belongs to) ----------------
// `expensePeriod` ("YYYY-MM") decides which month an invoice counts in for
// expenses / profit / budget / analytics — independent of `paidAt` (when the
// money actually left). Payment reporting keeps using paidAt.

function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Accounting month for an invoice: stored expensePeriod, else derived from
 * invoiceDate → paidAt → createdAt. */
export function invoiceExpensePeriod(inv: {
  expensePeriod?: string | null;
  invoiceDate: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}): string {
  if (inv.expensePeriod && /^\d{4}-\d{2}$/.test(inv.expensePeriod)) return inv.expensePeriod;
  return monthKeyOf(inv.invoiceDate ?? inv.paidAt ?? inv.createdAt);
}

/** First day of a "YYYY-MM" month, or null. */
export function periodToDate(period: string): Date | null {
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1);
}

/** The date an invoice contributes to date-based expense analytics — a day
 * inside its expensePeriod (keeps invoiceDate's day when in the same month). */
export function invoiceAnalyticsDate(inv: {
  expensePeriod?: string | null;
  invoiceDate: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}): Date {
  const period = invoiceExpensePeriod(inv);
  const base = inv.invoiceDate ?? inv.paidAt ?? inv.createdAt;
  if (monthKeyOf(base) === period) return base;
  return periodToDate(period) ?? base;
}

const MONTHS_RU = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

/** "Май 2026" for a "YYYY-MM" period (or the raw value if malformed). */
export function formatExpensePeriod(period: string | null | undefined): string {
  if (!period) return "—";
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m) return period;
  return `${MONTHS_RU[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export const INVOICE_STATUSES: InvoiceStatus[] = [
  "draft",
  "needs_review",
  "needs_correction",
  "approved_by_regional",
  "approved_by_owner",
  "paid",
  "rejected",
  "canceled",
];

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: "Черновик",
  needs_review: "На согласовании",
  needs_correction: "Возвращён на исправление",
  approved_by_regional: "Согласовано регионалом",
  approved_by_chief_accountant: "Согласовано главным бухгалтером",
  approved_by_owner: "Согласовано собственником",
  paid: "Оплачено",
  rejected: "Отклонено",
  canceled: "Отменено",
  // legacy values (kept readable)
  approved: "Согласовано",
  unpaid: "Не оплачен",
  overdue: "Просрочен",
};

// Statuses that are not real obligations or spending — excluded from dashboard
// expenses, debts, budgets and analytics.
export function isDeadInvoiceStatus(status: string): boolean {
  return status === "rejected" || status === "canceled";
}

export const INVOICE_CONFIDENCE_LABELS: Record<string, string> = {
  low: "низкая",
  medium: "средняя",
  high: "высокая",
};

// --- Workflow: draft -> needs_review -> approved_* -> paid (or rejected) ------

export type InvoiceAction = "send_to_review" | "approve" | "return_for_correction" | "reject" | "pay" | "cancel";

// Minimum length of a return-for-correction reason (shared rule; matches refunds).
export const INVOICE_RETURN_REASON_MIN = 5;

export const INVOICE_ACTION_LABELS: Record<InvoiceAction, string> = {
  send_to_review: "Отправить на согласование",
  approve: "Согласовать",
  return_for_correction: "Вернуть на исправление",
  reject: "Отклонить",
  pay: "Отметить оплачено",
  cancel: "Отменить счёт",
};

export const INVOICE_ACTION_AUDIT: Record<InvoiceAction, string> = {
  send_to_review: "invoice.sent_to_review",
  approve: "invoice.approved",
  return_for_correction: "invoice.returned_for_correction",
  reject: "invoice.rejected",
  pay: "invoice.paid",
  cancel: "invoice.canceled",
};

/** Actions that need an explicit "are you sure?" confirmation in the UI. */
export const INVOICE_DESTRUCTIVE_ACTIONS: InvoiceAction[] = ["reject", "cancel"];

type TransitionResult =
  | { ok: true; to: InvoiceStatus }
  | { ok: false; error: string };

function has(roles: readonly Role[], role: Role): boolean {
  return roles.includes(role);
}

/**
 * Resolves an action against the current status and the actor's effective
 * roles. Pure function — the single source of truth for who may do what.
 */
// Pre-payment statuses an invoice can be rejected from.
const INVOICE_REJECTABLE = ["needs_review", "approved_by_regional", "approved_by_chief_accountant", "approved_by_owner"];
// Approved statuses an invoice can be paid from (legacy approved_by_owner kept).
const INVOICE_PAYABLE = ["approved_by_regional", "approved_by_chief_accountant", "approved_by_owner"];

/**
 * Pure decision table. Approval routes by club: when an ACTIVE regional approver
 * exists (opts.hasActiveRegional) only the regional director may approve/reject;
 * otherwise the chief accountant approves/rejects as fallback. The creator may
 * never approve their own invoice (opts.isCreator). Owner / GD take no action.
 */
export function applyInvoiceAction(
  action: InvoiceAction,
  status: string,
  roles: readonly Role[],
  opts: ApprovalContext,
): TransitionResult {
  const isRegional = has(roles, "regional_director");
  const isChief = has(roles, "chief_accountant");
  const isAccountant = has(roles, "accountant"); // chief inherits accountant
  const isManager = has(roles, "manager");

  switch (action) {
    case "send_to_review":
      // A fresh draft OR one returned for correction is (re)submitted for review.
      if (status !== "draft" && status !== "needs_correction") return { ok: false, error: "Отправить на согласование можно только черновик" };
      if (!(isManager || isRegional)) return { ok: false, error: "Недостаточно прав" };
      // Only the author submits their own draft — a regional/other manager does
      // not send on someone else's behalf (they review it once it arrives).
      if (!opts.isCreator) return { ok: false, error: "Отправить на проверку может только автор счёта" };
      return { ok: true, to: "needs_review" };

    case "approve": {
      // INVOICES ONLY: a regional director MAY approve an invoice they created
      // themselves (confirmed business rule for the invoice contour). Role +
      // scope + status are still enforced; expenses/refunds keep their own
      // self-approval rules in their own decision tables (unchanged here).
      if (status !== "needs_review") return { ok: false, error: "Согласовать можно счёт на согласовании" };
      if (opts.hasActiveRegional) {
        if (isRegional) return { ok: true, to: "approved_by_regional" };
        return { ok: false, error: APPROVAL_REGIONAL_ONLY_MSG };
      }
      if (isChief) return { ok: true, to: "approved_by_chief_accountant" };
      return { ok: false, error: APPROVAL_FALLBACK_CHIEF_MSG };
    }

    case "return_for_correction": {
      // Reviewer sends a submitted invoice back to its author to fix (a comment is
      // required — enforced in the server action). Only from needs_review; the same
      // regional / chief-fallback routing as approve/reject.
      if (status !== "needs_review") return { ok: false, error: "Вернуть на исправление можно счёт на согласовании" };
      if (opts.hasActiveRegional) {
        if (isRegional) return { ok: true, to: "needs_correction" };
        return { ok: false, error: APPROVAL_REGIONAL_ONLY_MSG };
      }
      if (isChief) return { ok: true, to: "needs_correction" };
      return { ok: false, error: APPROVAL_FALLBACK_CHIEF_MSG };
    }

    case "reject": {
      if (!INVOICE_REJECTABLE.includes(status)) {
        return { ok: false, error: "Отклонить можно счёт на согласовании или согласованный (до оплаты)" };
      }
      if (opts.hasActiveRegional) {
        if (isRegional) return { ok: true, to: "rejected" };
        return { ok: false, error: APPROVAL_REGIONAL_ONLY_MSG };
      }
      if (isChief) return { ok: true, to: "rejected" };
      return { ok: false, error: APPROVAL_FALLBACK_CHIEF_MSG };
    }

    case "cancel":
      // A draft may be canceled by the people working on it. Owner is strategic
      // (read-only) and cannot cancel. Paid invoices can never be canceled.
      if (!(isManager || isRegional)) return { ok: false, error: "Недостаточно прав для отмены" };
      if (status === "draft") return { ok: true, to: "canceled" };
      return { ok: false, error: "Отменить можно только черновик" };

    case "pay":
      // Marking paid — accountant / chief accountant only (owner is read-only).
      if (!isAccountant) return { ok: false, error: "Недостаточно прав для отметки об оплате" };
      if (INVOICE_PAYABLE.includes(status)) return { ok: true, to: "paid" };
      return { ok: false, error: "Оплатить можно только согласованный счёт" };
  }
}

/** Actions the actor can currently perform — drives which buttons are shown. */
export function availableInvoiceActions(status: string, roles: readonly Role[], opts: ApprovalContext): InvoiceAction[] {
  return (Object.keys(INVOICE_ACTION_LABELS) as InvoiceAction[]).filter(
    (action) => applyInvoiceAction(action, status, roles, opts).ok,
  );
}

// The ONLY statuses in which an invoice's business fields may be edited by its
// author. Once submitted (needs_review) or decided (approved_*, rejected,
// canceled) the fields are immutable; a reviewer returns it for correction
// instead of editing on the author's behalf.
export const INVOICE_EDITABLE_STATUSES = ["draft", "needs_correction"] as const;

/**
 * Whether an invoice's fields may be edited in `status`:
 *  - draft / needs_correction: yes (the author — the updateInvoice action also
 *    enforces createdByUserId === actor for these unpaid statuses);
 *  - paid: only the accountant / chief accountant (post-payment correction);
 *  - everything else (needs_review, approved_by_regional / _chief_accountant /
 *    _owner, rejected, canceled): NO edits by anyone.
 * Owner / general director are strategic (read-only); the updateInvoice action
 * additionally blocks all strategic roles.
 */
export function canEditInvoice(status: string, roles: readonly Role[]): boolean {
  if (status === "paid") return has(roles, "accountant");
  return (INVOICE_EDITABLE_STATUSES as readonly string[]).includes(status);
}

/** LOW recognition confidence — "low" (or unknown/null) confidence blocks payment
 * until the accountant reviews and saves the extracted "Данные счёта". medium / high
 * pass this specific check. Categorical (invoice.confidence is low | medium | high). */
export function isLowConfidence(confidence: string | null | undefined): boolean {
  return confidence !== "high" && confidence !== "medium";
}

// Statuses in which the AI-extracted data may still be reviewed/corrected. A PAID
// invoice's financial data is immutable (post-payment corrections are out of scope),
// so `paid` is intentionally excluded. rejected / canceled are terminal.
export const INVOICE_REVIEW_DATA_STATUSES = [
  "draft", "needs_review", "needs_correction", "approved_by_regional",
  "approved_by_chief_accountant", "approved_by_owner",
] as const;

/** Approved-but-not-yet-paid statuses. Editing the financial data of an invoice in
 * one of these invalidates the approval (→ needs_review). Legacy approved_by_owner
 * is kept payable/approved. Mirrors INVOICE_PAYABLE. */
export const INVOICE_APPROVED_UNPAID_STATUSES = [
  "approved_by_regional", "approved_by_chief_accountant", "approved_by_owner",
] as const;

/** Who may edit + mark-reviewed the AI-extracted invoice data ("Данные счёта"): the
 * accounting contour ONLY (accountant + chief accountant, since chief expands to
 * accountant). Owner is strategic read-only — it may VIEW the data but never edit it,
 * save the review, or stamp aiDataReviewedAt. Manager / regional / GD / marketer get
 * no rights here either. */
export function canReviewInvoiceData(roles: readonly Role[]): boolean {
  return has(roles, "accountant");
}

// --- Financial fingerprint + payment guard (link review → approval → payment) ---
// The financially-significant fields whose change after approval requires a fresh
// approval and resets the AI review. A stable sha256 over their NORMALIZED values
// (trim + collapse whitespace + lowercase; dates as ISO day; amount as integer) so
// formatting/order never produce a false mismatch. Server-only source of truth.
export type InvoiceFinancialSnapshot = {
  counterpartyName: string | null; counterpartyInn: string | null; counterpartyKpp: string | null;
  counterpartyBankName: string | null; counterpartyBankBik: string | null;
  counterpartyAccount: string | null; counterpartyCorrAccount: string | null;
  payerName: string | null; payerInn: string | null; payerKpp: string | null;
  amountKopeks: number; invoiceNumber: string | null;
  invoiceDate: Date | null; dueDate: Date | null;
  subject: string | null; legalEntityId: string | null;
};

export function invoiceFinancialSnapshot(inv: {
  counterpartyName?: string | null; counterpartyInn?: string | null; counterpartyKpp?: string | null;
  counterpartyBankName?: string | null; counterpartyBankBik?: string | null;
  counterpartyAccount?: string | null; counterpartyCorrAccount?: string | null;
  payerName?: string | null; payerInn?: string | null; payerKpp?: string | null;
  amountKopeks: number; invoiceNumber?: string | null;
  invoiceDate?: Date | null; dueDate?: Date | null;
  subject?: string | null; legalEntityId?: string | null;
}): InvoiceFinancialSnapshot {
  return {
    counterpartyName: inv.counterpartyName ?? null, counterpartyInn: inv.counterpartyInn ?? null,
    counterpartyKpp: inv.counterpartyKpp ?? null, counterpartyBankName: inv.counterpartyBankName ?? null,
    counterpartyBankBik: inv.counterpartyBankBik ?? null, counterpartyAccount: inv.counterpartyAccount ?? null,
    counterpartyCorrAccount: inv.counterpartyCorrAccount ?? null, payerName: inv.payerName ?? null,
    payerInn: inv.payerInn ?? null, payerKpp: inv.payerKpp ?? null, amountKopeks: inv.amountKopeks,
    invoiceNumber: inv.invoiceNumber ?? null, invoiceDate: inv.invoiceDate ?? null, dueDate: inv.dueDate ?? null,
    subject: inv.subject ?? null, legalEntityId: inv.legalEntityId ?? null,
  };
}

const fpNorm = (v: string | null | undefined): string => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const fpDay = (d: Date | null | undefined): string => (d ? d.toISOString().slice(0, 10) : "");

export function invoiceFinancialFingerprint(s: InvoiceFinancialSnapshot): string {
  const parts = [
    fpNorm(s.counterpartyName), fpNorm(s.counterpartyInn), fpNorm(s.counterpartyKpp),
    fpNorm(s.counterpartyBankName), fpNorm(s.counterpartyBankBik), fpNorm(s.counterpartyAccount), fpNorm(s.counterpartyCorrAccount),
    fpNorm(s.payerName), fpNorm(s.payerInn), fpNorm(s.payerKpp),
    String(s.amountKopeks ?? 0), fpNorm(s.invoiceNumber), fpDay(s.invoiceDate), fpDay(s.dueDate),
    fpNorm(s.subject), fpNorm(s.legalEntityId),
  ];
  return createHash("sha256").update(parts.join("")).digest("hex");
}

export function invoiceFinancialFieldsChanged(a: InvoiceFinancialSnapshot, b: InvoiceFinancialSnapshot): boolean {
  return invoiceFinancialFingerprint(a) !== invoiceFinancialFingerprint(b);
}

/** The CRITICAL payment fields for the medium-confidence guard: counterparty, ИНН,
 * amount, payer, БИК, расчётный счёт. A structured gap here (empty / non-positive)
 * is the reliable signal that medium-confidence doubt touches a critical field. */
export function invoiceHasCriticalPaymentGap(inv: {
  amountKopeks: number; counterpartyName: string | null; counterpartyInn: string | null;
  payerName: string | null; counterpartyBankBik: string | null; counterpartyAccount: string | null;
}): boolean {
  const empty = (s: string | null | undefined) => !s || s.trim() === "";
  return empty(inv.counterpartyName) || empty(inv.counterpartyInn) || inv.amountKopeks <= 0
    || empty(inv.payerName) || empty(inv.counterpartyBankBik) || empty(inv.counterpartyAccount);
}

/**
 * The single server-side source of truth for whether an invoice's DATA blocks
 * payment (role/status/scope/CAS are enforced separately by the action). The UI
 * uses the same function so the reason shown always matches the server. Returns a
 * human message or null. `currentFingerprint` is computed by the caller from the
 * invoice's current financial fields.
 */
export function invoicePaymentBlockedReason(inv: {
  confidence: string | null;
  aiDataReviewedAt: Date | null;
  amountKopeks: number;
  counterpartyName: string | null; counterpartyInn: string | null;
  payerName: string | null; counterpartyBankBik: string | null; counterpartyAccount: string | null;
  approvedDataFingerprint: string | null;
  currentFingerprint: string;
}): string | null {
  if (inv.amountKopeks <= 0) return "Сумма счёта должна быть положительной для оплаты.";
  // Data changed after approval (defence-in-depth; the edit path also moves the
  // invoice back to needs_review). Legacy approvals without a fingerprint skip this.
  if (inv.approvedDataFingerprint && inv.approvedDataFingerprint !== inv.currentFingerprint) {
    return "Данные счёта изменились после согласования — требуется повторное согласование.";
  }
  const reviewed = Boolean(inv.aiDataReviewedAt);
  if (isLowConfidence(inv.confidence) && !reviewed) {
    return "Перед оплатой проверьте и сохраните данные счёта.";
  }
  if (inv.confidence === "medium" && !reviewed && invoiceHasCriticalPaymentGap(inv)) {
    return "Проверьте критичные поля счёта (контрагент, ИНН, сумма, плательщик, БИК, счёт) перед оплатой.";
  }
  return null;
}

/** Extract ONLY the human-readable AI warnings from the stored raw extraction blob.
 * Never exposes any other raw content (no prompt, no model text, no other keys).
 * Returns a safe, trimmed, deduped string[] (bounded). */
export function parseInvoiceWarnings(rawExtractedJson: string | null | undefined): string[] {
  if (!rawExtractedJson) return [];
  try {
    const obj = JSON.parse(rawExtractedJson) as { warnings?: unknown };
    if (!Array.isArray(obj?.warnings)) return [];
    return [...new Set(obj.warnings.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim()))].slice(0, 20);
  } catch {
    return [];
  }
}

export type InvoiceWithClub = Invoice & {
  club: { id: string; name: string; city: string };
};

export async function getInvoicesForScope(scope: DataScope): Promise<InvoiceWithClub[]> {
  if (!scope.company || scope.clubIds.length === 0) return [];
  const invoices = await prisma.invoice.findMany({
    where: { companyId: scope.company.id, clubId: { in: scope.clubIds } },
    orderBy: { createdAt: "desc" },
    include: { club: { select: { id: true, name: true, city: true } } },
  });
  return invoices as InvoiceWithClub[];
}

/** Single invoice, scoped to the current access context (company + allowed clubs). */
export async function getInvoiceForContext(
  ctx: AccessContext,
  invoiceId: string,
): Promise<InvoiceWithClub | null> {
  if (!ctx.selectedCompanyId) return null;
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { club: { select: { id: true, name: true, city: true } } },
  });
  if (!invoice) return null;
  if (invoice.companyId !== ctx.selectedCompanyId) return null;
  if (!ctx.allowedClubIds.includes(invoice.clubId)) return null;
  // A plain manager sees only invoices they created (own-only, server-enforced).
  if (managerCannotSeeRecord(ctx, invoice)) return null;
  return invoice as InvoiceWithClub;
}

// --- Dashboard helpers (kept; null-safe for the new nullable dueDate) ---------

export function isOverdue(invoice: { status: string; dueDate: Date | null }): boolean {
  if (invoice.status === "paid" || isDeadInvoiceStatus(invoice.status)) return false;
  if (!invoice.dueDate) return false;
  return invoice.dueDate.getTime() < Date.now();
}

// --- Phase 1 «Счета»: single-source status + reporting-month helpers ----------
// Pure (no server imports) so they are shared by the loader AND mirrored by
// tests. Status values come from the real enum above — nothing invented.

/** Statuses that mean "sent and awaiting payment" (not draft, not paid/dead). */
export const INVOICE_AWAITING_PAYMENT_STATUSES = [
  "needs_review", "approved_by_regional", "approved_by_chief_accountant", "approved_by_owner",
] as const;

export function isInvoicePaid(status: string): boolean { return status === "paid"; }
export function isInvoiceCancelled(status: string): boolean { return status === "canceled"; }
export function isInvoiceRejected(status: string): boolean { return status === "rejected"; }
/** In a live status that awaits actual payment (drives «Ожидает оплаты»). */
export function isInvoiceAwaitingPayment(status: string): boolean {
  return (INVOICE_AWAITING_PAYMENT_STATUSES as readonly string[]).includes(status);
}

type InvoiceDates = { status: string; dueDate: Date | null; paidAt: Date | null; invoiceDate: Date | null; createdAt: Date };

/**
 * The date an invoice reports to: paid → paidAt (when money left); otherwise →
 * dueDate (the obligation month). Falls back to invoiceDate/createdAt only when
 * the primary date is missing (never lets createdAt override dueDate/paidAt).
 */
export function getInvoiceReportingDate(inv: InvoiceDates): Date {
  if (isInvoicePaid(inv.status)) return inv.paidAt ?? inv.dueDate ?? inv.invoiceDate ?? inv.createdAt;
  return inv.dueDate ?? inv.invoiceDate ?? inv.createdAt;
}
export function getInvoiceReportingMonth(inv: InvoiceDates): string {
  return monthKeyOf(getInvoiceReportingDate(inv));
}

// --- Operational visibility (list membership) — separate from financial period -
// A draft / awaiting invoice must never vanish from the operational list just
// because a financial date (dueDate/invoiceDate) is missing. The OPERATIONAL
// month decides which month the invoices page shows a row in; it is NOT a
// financial reporting date (dashboard / budgets / analytics keep using
// getInvoiceReportingMonth / invoiceExpensePeriod, which are untouched).

/** Confirmed-but-unpaid statuses (approved by someone, awaiting payment). */
const INVOICE_CONFIRMED_UNPAID_STATUSES = [
  "approved_by_regional", "approved_by_chief_accountant", "approved_by_owner",
];

/**
 * Operational month for the invoices list:
 *  - paid          → paidAt (when money left)
 *  - approved_*     → dueDate (the confirmed obligation month) — financial rule kept
 *  - draft / needs_review / rejected → invoiceDate, else createdAt (never hidden
 *    by a missing dueDate). Every branch falls back to createdAt so a row can
 *    never disappear for lack of a date.
 */
export function getInvoiceOperationalDate(inv: InvoiceDates): Date {
  if (isInvoicePaid(inv.status)) return inv.paidAt ?? inv.dueDate ?? inv.invoiceDate ?? inv.createdAt;
  if (INVOICE_CONFIRMED_UNPAID_STATUSES.includes(inv.status)) return inv.dueDate ?? inv.invoiceDate ?? inv.createdAt;
  return inv.invoiceDate ?? inv.createdAt;
}
export function getInvoiceOperationalMonth(inv: InvoiceDates): string {
  return monthKeyOf(getInvoiceOperationalDate(inv));
}

/** Statuses a manager always sees in their own operational list (own club).
 * canceled is excluded (soft-deleted); everything else is work they can track. */
export const INVOICE_MANAGER_VISIBLE_STATUSES = [
  "draft", "needs_review", "approved_by_regional", "approved_by_chief_accountant",
  "approved_by_owner", "rejected", "paid",
] as const;

/** The active regional-review queue predicate (status only). Month-independent. */
export function isAwaitingRegionalReview(status: string): boolean {
  return status === "needs_review";
}

/**
 * Whether a draft has the minimum data to be sent for review: a counterparty,
 * a positive amount and an attached file. AI confidence is NOT a gate — a
 * manager who filled the fields by hand may always submit. Pure; returns a
 * reason string when not ready, else null.
 */
export function invoiceSubmitBlockedReason(inv: {
  counterpartyName: string | null; amountKopeks: number; hasFile: boolean;
}): string | null {
  if (!inv.counterpartyName || !inv.counterpartyName.trim()) return "Укажите контрагента перед отправкой на проверку";
  if (!(inv.amountKopeks > 0)) return "Укажите сумму больше нуля перед отправкой на проверку";
  if (!inv.hasFile) return "К счёту должен быть прикреплён файл перед отправкой на проверку";
  return null;
}

/**
 * Overdue = a SENT, unpaid obligation whose dueDate has passed (server `now`).
 * Never overdue: paid, canceled, rejected, an unsent draft, or a not-yet-due
 * invoice.
 */
export function isInvoiceOverdue(inv: { status: string; dueDate: Date | null }, now: Date = new Date()): boolean {
  if (!isInvoiceAwaitingPayment(inv.status)) return false;
  if (!inv.dueDate) return false;
  return inv.dueDate.getTime() < now.getTime();
}

/** «Добавить оплаченный счёт» + отметить оплату (full/partial) — accountant / chief only. */
export function canAddPaidInvoice(roles: readonly Role[]): boolean {
  return roles.includes("accountant") || roles.includes("chief_accountant");
}
export const canRecordInvoicePayment = canAddPaidInvoice;

/** «Сторнировать платёж» — ТОЛЬКО главный бухгалтер. Owner/GD/accountant НЕ получают это
 *  право автоматически (§7/§18). Reversal is append-only (flips a payment to `reversed`). */
export function canReverseInvoicePayment(roles: readonly Role[]): boolean {
  return roles.includes("chief_accountant");
}

export type StatusSummary = {
  unpaid: { count: number; amountKopeks: number };
  overdue: { count: number; amountKopeks: number };
  paid: { count: number; amountKopeks: number };
  rejected: { count: number; amountKopeks: number };
};

export function summarize(
  invoices: Array<{ status: string; dueDate: Date | null; amountKopeks: number }>,
): StatusSummary {
  const summary: StatusSummary = {
    unpaid: { count: 0, amountKopeks: 0 },
    overdue: { count: 0, amountKopeks: 0 },
    paid: { count: 0, amountKopeks: 0 },
    rejected: { count: 0, amountKopeks: 0 },
  };
  const now = Date.now();
  for (const inv of invoices) {
    if (inv.status === "paid") {
      summary.paid.count += 1;
      summary.paid.amountKopeks += inv.amountKopeks;
    } else if (isDeadInvoiceStatus(inv.status)) {
      // rejected + canceled — not a debt, not an expense.
      summary.rejected.count += 1;
      summary.rejected.amountKopeks += inv.amountKopeks;
    } else if (inv.dueDate && inv.dueDate.getTime() < now) {
      summary.overdue.count += 1;
      summary.overdue.amountKopeks += inv.amountKopeks;
    } else {
      summary.unpaid.count += 1;
      summary.unpaid.amountKopeks += inv.amountKopeks;
    }
  }
  return summary;
}
