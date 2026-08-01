// Single source of truth for "what needs the REGIONAL DIRECTOR's action right now" across
// invoices, expenses (v2), and refunds (v2). Reused by the dashboard cards, the list-page
// filters, and the tests — so counts, sums, and filtered lists can never diverge. Scope is
// enforced by the caller (companyId + active accessible clubIds); this module only counts what
// it is given. Integer kopeks; club/company-local day boundaries; no full-company scans.
import { prisma } from "@/lib/prisma";

// ---- Status predicates (the ONLY definition of a regional task) ----
export const INVOICE_REGIONAL_TASK_STATUSES: readonly string[] = ["needs_review"];
export const EXPENSE_REGIONAL_TASK_STATUSES: readonly string[] = ["pending_regional_budget_approval"];
export const REFUND_REGIONAL_TASK_STATUSES: readonly string[] = ["pending_regional_review"]; // v2 only

export const invoiceNeedsRegionalReview = (status: string) => INVOICE_REGIONAL_TASK_STATUSES.includes(status);
export const expenseNeedsRegionalReview = (status: string, entryVersion: number) => entryVersion === 2 && EXPENSE_REGIONAL_TASK_STATUSES.includes(status);
export const refundNeedsRegionalReview = (status: string, entryVersion: number) => entryVersion === 2 && REFUND_REGIONAL_TASK_STATUSES.includes(status);

// The shared URL filter contract for the list pages.
export const REGIONAL_TASK_FILTER = "regional_review";
export const taskListHref = (base: "invoices" | "expenses" | "refunds", clubId?: string) =>
  `/${base}?task=${REGIONAL_TASK_FILTER}${clubId ? `&clubId=${clubId}` : ""}`;

export type ClubTaskBreakdown = { clubId: string; clubName: string; count: number; sumKopeks: number; overdue: number };
export type RegionalTaskCard = {
  count: number; sumKopeks: number; overdue: number; noDue: number;
  nearestDueIso: string | null; clubCount: number; clubs: ClubTaskBreakdown[]; href: string;
  error?: boolean; // this category failed to load — shown locally, does not break the others
};
export type RegionalReviewTasks = { invoices: RegionalTaskCard; expenses: RegionalTaskCard; refunds: RegionalTaskCard };

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

type Row = { clubId: string; amountKopeks: number; due: Date | null };

function buildCard(rows: Row[], clubName: Map<string, string>, base: "invoices" | "expenses" | "refunds", now: Date): RegionalTaskCard {
  const today = dayStart(now).getTime();
  const per = new Map<string, ClubTaskBreakdown>();
  let sum = 0, overdue = 0, noDue = 0; let nearest: number | null = null;
  for (const r of rows) {
    sum += r.amountKopeks;
    const isOverdue = r.due !== null && dayStart(r.due).getTime() < today;
    if (r.due === null) noDue++;
    else { if (isOverdue) overdue++; const t = dayStart(r.due).getTime(); if (nearest === null || t < nearest) nearest = t; }
    const b = per.get(r.clubId) ?? { clubId: r.clubId, clubName: clubName.get(r.clubId) ?? r.clubId, count: 0, sumKopeks: 0, overdue: 0 };
    b.count++; b.sumKopeks += r.amountKopeks; if (isOverdue) b.overdue++;
    per.set(r.clubId, b);
  }
  const clubs = [...per.values()].sort((a, b) => b.overdue - a.overdue || b.count - a.count);
  return {
    count: rows.length, sumKopeks: sum, overdue, noDue,
    nearestDueIso: nearest !== null ? iso(new Date(nearest)) : null,
    clubCount: clubs.length, clubs, href: taskListHref(base),
  };
}

function mergeCard(parts: RegionalTaskCard[], base: "invoices" | "expenses" | "refunds"): RegionalTaskCard {
  const clubs = parts.flatMap((p) => p.clubs).sort((a, b) => b.overdue - a.overdue || b.count - a.count);
  const nearest = parts.map((p) => p.nearestDueIso).filter((x): x is string => Boolean(x)).sort()[0] ?? null;
  return {
    count: parts.reduce((a, p) => a + p.count, 0), sumKopeks: parts.reduce((a, p) => a + p.sumKopeks, 0),
    overdue: parts.reduce((a, p) => a + p.overdue, 0), noDue: parts.reduce((a, p) => a + p.noDue, 0),
    nearestDueIso: nearest, clubCount: clubs.length, clubs, href: taskListHref(base), error: parts.some((p) => p.error),
  };
}
/** Merge per-company task summaries into one (a regional is normally single-company). */
export function mergeRegionalTasks(parts: RegionalReviewTasks[]): RegionalReviewTasks {
  if (parts.length === 1) return parts[0];
  return {
    invoices: mergeCard(parts.map((p) => p.invoices), "invoices"),
    expenses: mergeCard(parts.map((p) => p.expenses), "expenses"),
    refunds: mergeCard(parts.map((p) => p.refunds), "refunds"),
  };
}

/**
 * Load the regional review-task summary for a scope. `clubIds` MUST already be the regional's
 * ACTIVE accessible clubs (archived/foreign clubs excluded upstream). Each type loads only its
 * (small, bounded) regional-task rows — never the whole company — so there is no N+1 and no
 * over-fetch. Empty scope → all-zero cards.
 */
export async function loadRegionalReviewTasks(companyId: string, clubIds: string[], clubName: Map<string, string>, now: Date = new Date()): Promise<RegionalReviewTasks> {
  const zero = (base: "invoices" | "expenses" | "refunds", error = false): RegionalTaskCard => ({ count: 0, sumKopeks: 0, overdue: 0, noDue: 0, nearestDueIso: null, clubCount: 0, clubs: [], href: taskListHref(base), error });
  if (clubIds.length === 0) return { invoices: zero("invoices"), expenses: zero("expenses"), refunds: zero("refunds") };

  // Each category is loaded + built independently — one failure yields a LOCAL error card,
  // never a broken dashboard (§11).
  const safe = async (base: "invoices" | "expenses" | "refunds", fn: () => Promise<RegionalTaskCard>): Promise<RegionalTaskCard> => {
    try { return await fn(); } catch (e) { console.error(`regional-tasks:${base} failed`, e); return zero(base, true); }
  };
  const [invoices, expenses, refunds] = await Promise.all([
    safe("invoices", async () => buildCard((await prisma.invoice.findMany({ where: { companyId, clubId: { in: clubIds }, status: { in: [...INVOICE_REGIONAL_TASK_STATUSES] } }, select: { clubId: true, amountKopeks: true, dueDate: true } })).map((r) => ({ clubId: r.clubId, amountKopeks: r.amountKopeks, due: r.dueDate })), clubName, "invoices", now)),
    safe("expenses", async () => buildCard((await prisma.expense.findMany({ where: { companyId, clubId: { in: clubIds }, entryVersion: 2, status: { in: [...EXPENSE_REGIONAL_TASK_STATUSES] } }, select: { clubId: true, amountKopeks: true } })).map((r) => ({ clubId: r.clubId, amountKopeks: r.amountKopeks, due: null })), clubName, "expenses", now)),
    safe("refunds", async () => buildCard((await prisma.refund.findMany({ where: { companyId, clubId: { in: clubIds }, entryVersion: 2, status: { in: [...REFUND_REGIONAL_TASK_STATUSES] } }, select: { clubId: true, amountKopeks: true, refundResultAmountKopeks: true, plannedRefundDate: true } })).map((r) => ({ clubId: r.clubId, amountKopeks: r.refundResultAmountKopeks ?? r.amountKopeks, due: r.plannedRefundDate })), clubName, "refunds", now)),
  ]);
  return { invoices, expenses, refunds };
}
