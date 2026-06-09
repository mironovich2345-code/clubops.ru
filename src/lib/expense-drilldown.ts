// Category drilldown for analytics "Топ расходов по статьям": lists the
// individual spend rows behind a category total, split by cash / non-cash.
// Mirrors the analytics spend logic EXACTLY (same statuses, same date rules) so
// the drilldown total equals the clicked category total.
import { prisma } from "@/lib/prisma";
import { invoiceAnalyticsDate } from "@/lib/invoices";

export type DrillSource = "expense" | "invoice" | "refund";

export const DRILL_SOURCE_LABELS: Record<DrillSource, string> = {
  expense: "Расход",
  invoice: "Счёт",
  refund: "Возврат",
};

export type DrillRow = {
  id: string;
  source: DrillSource;
  date: Date | null;
  clubId: string;
  clubName: string;
  city: string;
  legalEntityId: string | null;
  legalEntityName: string | null;
  counterparty: string | null;
  comment: string | null;
  amountKopeks: number;
  paymentMethod: string | null;
  cash: boolean;
  href: string;
};

/** Cash iff paymentMethod === "cash"; everything else (card / sbp /
 * bank_transfer / other / null) is non-cash. */
export function isCashPayment(paymentMethod: string | null): boolean {
  return paymentMethod === "cash";
}

const inRange = (d: Date, start: Date, end: Date) => d.getTime() >= start.getTime() && d.getTime() < end.getTime();

/**
 * All spend rows for one category in [start, end), scoped to a company + clubs.
 * Source logic matches analytics top expenses:
 *   - confirmed expenses (by expenseDate)
 *   - paid invoices (by expensePeriod via invoiceAnalyticsDate) — non-cash
 *   - paid refunds (only for the "refunds" category, by paid/refund date) — non-cash
 */
export async function loadCategoryExpenseRows(opts: {
  companyId: string;
  clubIds: string[];
  category: string;
  start: Date;
  end: Date;
}): Promise<DrillRow[]> {
  const { companyId, clubIds, category, start, end } = opts;
  if (clubIds.length === 0) return [];
  const inClubs = { in: clubIds };

  const [expenses, invoices, refunds] = await Promise.all([
    prisma.expense.findMany({
      where: { companyId, clubId: inClubs, status: "confirmed", category, expenseDate: { gte: start, lt: end } },
      select: {
        id: true, clubId: true, amountKopeks: true, expenseDate: true, paymentMethod: true,
        vendorName: true, recipientName: true, comment: true, notes: true, transferComment: true,
        legalEntityId: true,
        club: { select: { name: true, city: true } },
        legalEntity: { select: { name: true } },
      },
      orderBy: { expenseDate: "desc" },
    }),
    prisma.invoice.findMany({
      where: { companyId, clubId: inClubs, status: "paid", expenseCategory: category },
      select: {
        id: true, clubId: true, amountKopeks: true, expensePeriod: true, invoiceDate: true, paidAt: true, createdAt: true,
        counterpartyName: true, comment: true, notes: true, legalEntityId: true,
        club: { select: { name: true, city: true } },
        legalEntity: { select: { name: true } },
      },
    }),
    category === "refunds"
      ? prisma.refund.findMany({
          where: { companyId, clubId: inClubs, status: "paid" },
          select: {
            id: true, clubId: true, amountKopeks: true, paidAt: true, refundDate: true, createdAt: true,
            clientName: true, reason: true, notes: true,
            club: { select: { name: true, city: true } },
          },
        })
      : Promise.resolve([] as never[]),
  ]);

  const rows: DrillRow[] = [];
  for (const e of expenses) {
    rows.push({
      id: e.id, source: "expense", date: e.expenseDate, clubId: e.clubId, clubName: e.club.name, city: e.club.city,
      legalEntityId: e.legalEntityId, legalEntityName: e.legalEntity?.name ?? null,
      counterparty: e.vendorName ?? e.recipientName ?? null,
      comment: e.comment ?? e.notes ?? e.transferComment ?? null,
      amountKopeks: e.amountKopeks, paymentMethod: e.paymentMethod ?? null, cash: isCashPayment(e.paymentMethod ?? null),
      href: `/expenses/${e.id}`,
    });
  }
  for (const i of invoices) {
    // Invoices belong to their accounting month (expensePeriod) — match analytics.
    if (!inRange(invoiceAnalyticsDate(i), start, end)) continue;
    rows.push({
      id: i.id, source: "invoice", date: i.invoiceDate ?? i.paidAt, clubId: i.clubId, clubName: i.club.name, city: i.club.city,
      legalEntityId: i.legalEntityId, legalEntityName: i.legalEntity?.name ?? null,
      counterparty: i.counterpartyName ?? null, comment: i.comment ?? i.notes ?? null,
      amountKopeks: i.amountKopeks, paymentMethod: null, cash: false, // invoices = non-cash (Part 4)
      href: `/invoices/${i.id}`,
    });
  }
  for (const r of refunds) {
    const d = r.paidAt ?? r.refundDate ?? r.createdAt;
    if (!inRange(d, start, end)) continue;
    rows.push({
      id: r.id, source: "refund", date: r.paidAt ?? r.refundDate, clubId: r.clubId, clubName: r.club.name, city: r.club.city,
      legalEntityId: null, legalEntityName: null,
      counterparty: r.clientName ?? null, comment: r.reason ?? r.notes ?? null,
      amountKopeks: r.amountKopeks, paymentMethod: null, cash: false, // refunds = non-cash (Part 5)
      href: `/refunds/${r.id}`,
    });
  }
  return rows;
}

export type DrillFilters = { pay?: string; source?: string; entity?: string; club?: string };

/** Apply the page/export filters (Part 7) to loaded rows. */
export function filterDrillRows(rows: DrillRow[], f: DrillFilters): DrillRow[] {
  return rows.filter((r) => {
    if (f.pay === "cash" && !r.cash) return false;
    if (f.pay === "noncash" && r.cash) return false;
    if (f.source && f.source !== "all" && r.source !== f.source) return false;
    if (f.entity && r.legalEntityId !== f.entity) return false;
    if (f.club && r.clubId !== f.club) return false;
    return true;
  });
}

export type DrillSummary = { totalKopeks: number; cashKopeks: number; nonCashKopeks: number; count: number };

export function summarizeDrill(rows: DrillRow[]): DrillSummary {
  let totalKopeks = 0, cashKopeks = 0, nonCashKopeks = 0;
  for (const r of rows) {
    totalKopeks += r.amountKopeks;
    if (r.cash) cashKopeks += r.amountKopeks;
    else nonCashKopeks += r.amountKopeks;
  }
  return { totalKopeks, cashKopeks, nonCashKopeks, count: rows.length };
}
