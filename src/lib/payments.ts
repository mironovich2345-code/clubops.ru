// Payment calendar: upcoming obligations, overdue payments and paid-this-month,
// derived from invoices. This is a payment-planning view (by dueDate / paidAt),
// not expense analytics (which uses expensePeriod). All queries are scoped to a
// company + allowed clubs and bounded by date.
import { prisma } from "@/lib/prisma";

// Invoices that are still an obligation to pay (not paid / rejected / canceled).
export const OBLIGATION_STATUSES = ["draft", "needs_review", "approved_by_regional", "approved_by_owner"];

export function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
export function monthBounds(month: string): { start: Date; end: Date } | null {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: new Date(y, mo, 1), end: new Date(y, mo + 1, 1) };
}

export type PaymentInvoice = {
  id: string;
  amountKopeks: number;
  status: string;
  dueDate: Date | null;
  paidAt: Date | null;
  expensePeriod: string | null;
  expenseCategory: string | null;
  counterpartyName: string | null;
  clubId: string;
  clubName: string;
  city: string;
  legalEntityName: string | null;
};

type Row = {
  id: string;
  amountKopeks: number;
  status: string;
  dueDate: Date | null;
  paidAt: Date | null;
  expensePeriod: string | null;
  expenseCategory: string | null;
  counterpartyName: string | null;
  clubId: string;
  club: { name: string; city: string };
  legalEntity: { name: string } | null;
};
const toPayment = (r: Row): PaymentInvoice => ({
  id: r.id,
  amountKopeks: r.amountKopeks,
  status: r.status,
  dueDate: r.dueDate,
  paidAt: r.paidAt,
  expensePeriod: r.expensePeriod,
  expenseCategory: r.expenseCategory,
  counterpartyName: r.counterpartyName,
  clubId: r.clubId,
  clubName: r.club.name,
  city: r.club.city,
  legalEntityName: r.legalEntity?.name ?? null,
});

const ROW_SELECT = {
  id: true,
  amountKopeks: true,
  status: true,
  dueDate: true,
  paidAt: true,
  expensePeriod: true,
  expenseCategory: true,
  counterpartyName: true,
  clubId: true,
  club: { select: { name: true, city: true } },
  legalEntity: { select: { name: true } },
} as const;

/**
 * Date-bounded load (Part 12): obligations with a dueDate up to `loadEnd`
 * (covers all overdue + the upcoming window) and invoices paid in `monthKey`.
 */
export async function loadPaymentInvoices(
  companyId: string,
  clubIds: string[],
  loadEnd: Date,
  monthKey: string,
): Promise<{ obligations: PaymentInvoice[]; paid: PaymentInvoice[] }> {
  if (clubIds.length === 0) return { obligations: [], paid: [] };
  const range = monthBounds(monthKey);
  const [obligations, paid] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, clubId: { in: clubIds }, status: { in: OBLIGATION_STATUSES }, dueDate: { not: null, lte: loadEnd } },
      orderBy: { dueDate: "asc" },
      select: ROW_SELECT,
    }),
    range
      ? prisma.invoice.findMany({
          where: { companyId, clubId: { in: clubIds }, status: "paid", paidAt: { gte: range.start, lt: range.end } },
          orderBy: { paidAt: "desc" },
          select: ROW_SELECT,
        })
      : Promise.resolve([]),
  ]);
  return { obligations: obligations.map(toPayment), paid: paid.map(toPayment) };
}

/** End of the current Monday-first week (Sunday), at day-start. */
export function endOfWeek(now: Date): Date {
  const today = dayStart(now);
  const isoIdx = (today.getDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(today, 6 - isoIdx);
}

export type CalendarKpis = {
  todayKopeks: number;
  weekKopeks: number; // today → end of current week (inclusive)
  monthEndKopeks: number; // today → last day of the selected month (inclusive)
  overdueKopeks: number;
  overdueCount: number;
};

/**
 * KPI windows for the calendar header (Part 1). Reuses the same dueDate-based
 * obligation set; `selectedMonthLastDay` is the last day (day-start) of the month
 * shown in the calendar, so "До конца месяца" follows the selected month.
 */
export function computeCalendarKpis(obligations: PaymentInvoice[], now: Date, selectedMonthLastDay: Date): CalendarKpis {
  const today = dayStart(now);
  const week = endOfWeek(now);
  let todayKopeks = 0, weekKopeks = 0, monthEndKopeks = 0, overdueKopeks = 0, overdueCount = 0;
  for (const i of obligations) {
    if (!i.dueDate) continue;
    const d = dayStart(i.dueDate);
    if (d < today) {
      overdueKopeks += i.amountKopeks;
      overdueCount += 1;
      continue;
    }
    if (d.getTime() === today.getTime()) todayKopeks += i.amountKopeks;
    if (d <= week) weekKopeks += i.amountKopeks; // d >= today already
    if (d <= selectedMonthLastDay) monthEndKopeks += i.amountKopeks;
  }
  return { todayKopeks, weekKopeks, monthEndKopeks, overdueKopeks, overdueCount };
}

export type PaymentSummary = {
  overdueKopeks: number;
  overdueCount: number;
  todayKopeks: number;
  within7Kopeks: number;
  within30Kopeks: number;
  paidThisMonthKopeks: number;
};

/** Summary cards (Part 2/3) from already-loaded obligations + paid. */
export function computePaymentSummary(obligations: PaymentInvoice[], paid: PaymentInvoice[], now: Date): PaymentSummary {
  const today = dayStart(now);
  const tomorrow = addDays(today, 1);
  const in7 = addDays(today, 7);
  const in30 = addDays(today, 30);
  let overdueKopeks = 0, overdueCount = 0, todayKopeks = 0, within7Kopeks = 0, within30Kopeks = 0;
  for (const i of obligations) {
    const d = i.dueDate;
    if (!d) continue;
    if (d < today) {
      overdueKopeks += i.amountKopeks;
      overdueCount += 1;
    } else if (d < tomorrow) {
      todayKopeks += i.amountKopeks;
    }
    // Upcoming windows include today and overlap (cumulative).
    if (d >= today && d <= in7) within7Kopeks += i.amountKopeks;
    if (d >= today && d <= in30) within30Kopeks += i.amountKopeks;
  }
  const paidThisMonthKopeks = paid.reduce((s, p) => s + p.amountKopeks, 0);
  return { overdueKopeks, overdueCount, todayKopeks, within7Kopeks, within30Kopeks, paidThisMonthKopeks };
}

/** Lightweight summary for the dashboard widget (Part 10) — own bounded query. */
export async function getPaymentSummary(companyId: string, clubIds: string[], now: Date): Promise<PaymentSummary> {
  const { obligations, paid } = await loadPaymentInvoices(companyId, clubIds, addDays(dayStart(now), 30), monthKeyOf(now));
  return computePaymentSummary(obligations, paid, now);
}

// --- aggregations (Parts 6/7) ----------------------------------------------

export type CityObligation = { city: string; toPayKopeks: number; overdueKopeks: number };

export function obligationsByCity(obligations: PaymentInvoice[], now: Date): CityObligation[] {
  const today = dayStart(now);
  const map = new Map<string, CityObligation>();
  for (const i of obligations) {
    const row = map.get(i.city) ?? { city: i.city, toPayKopeks: 0, overdueKopeks: 0 };
    row.toPayKopeks += i.amountKopeks;
    if (i.dueDate && i.dueDate < today) row.overdueKopeks += i.amountKopeks;
    map.set(i.city, row);
  }
  return [...map.values()].sort((a, b) => b.toPayKopeks - a.toPayKopeks);
}

export type ClubObligation = { clubId: string; clubName: string; toPayKopeks: number };

export function obligationsByClub(obligations: PaymentInvoice[]): ClubObligation[] {
  const map = new Map<string, ClubObligation>();
  for (const i of obligations) {
    const row = map.get(i.clubId) ?? { clubId: i.clubId, clubName: i.clubName, toPayKopeks: 0 };
    row.toPayKopeks += i.amountKopeks;
    map.set(i.clubId, row);
  }
  return [...map.values()].sort((a, b) => b.toPayKopeks - a.toPayKopeks);
}

// --- alerts (Part 8) -------------------------------------------------------

export type PaymentAlert = { tone: "red" | "yellow" | "green"; text: string };

const RED_OVERDUE_KOPEKS = 100_000 * 100; // > 100 000 ₽
const BIG_PAYMENT_KOPEKS = 300_000 * 100; // > 300 000 ₽

export function paymentAlerts(obligations: PaymentInvoice[], now: Date): PaymentAlert[] {
  const today = dayStart(now);
  const in3 = addDays(today, 3);
  const overdue = obligations.filter((i) => i.dueDate && i.dueDate < today);
  const overdueTotal = overdue.reduce((s, i) => s + i.amountKopeks, 0);
  const overdueWeek = overdue.filter((i) => i.dueDate! < addDays(today, -7));
  const bigSoon = obligations.filter((i) => i.dueDate && i.dueDate >= today && i.dueDate <= in3 && i.amountKopeks > BIG_PAYMENT_KOPEKS);

  const alerts: PaymentAlert[] = [];
  if (overdueTotal > RED_OVERDUE_KOPEKS) {
    alerts.push({ tone: "red", text: `Просрочено более 100 000 ₽ (всего ${Math.round(overdueTotal / 100).toLocaleString("ru-RU")} ₽)` });
  }
  if (overdueWeek.length > 0) {
    alerts.push({ tone: "red", text: `Просрочено более 7 дней: ${overdueWeek.length} счёт(ов)` });
  }
  for (const i of bigSoon) {
    alerts.push({ tone: "yellow", text: `Крупный платёж ${Math.round(i.amountKopeks / 100).toLocaleString("ru-RU")} ₽ в ближайшие 3 дня (${i.clubName})` });
  }
  if (overdue.length === 0) {
    alerts.push({ tone: "green", text: "Нет просроченных обязательств" });
  }
  return alerts.slice(0, 5);
}
