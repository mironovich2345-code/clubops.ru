// WAVE 3 — Payroll payment obligation: the «Зарплата к выплате» calendar rail. Generated from
// an APPROVED PayrollPeriod (never forecast, never draft). Reuses the calc's own accrual/payment
// tracking (netPayableKopeks / paidKopeks) — advances already folded, so no double count and NO
// parallel payment ledger. dueDate comes from the company pay schedule; if that is unset we still
// record the obligation but leave dueDate null (never faked) and keep it off the dated calendar.

import { prisma } from "@/lib/prisma";
import type { PaymentObligation, PaymentObligationStatus } from "@/lib/payment-obligations";
import { forecastCategoryOfPosition, type ForecastCategory } from "@/lib/payroll/forecast";

// Period is "approved enough" to owe money once it reaches approved (or beyond). Draft /
// submitted / regional_approved are still in review → no obligation yet.
export const OBLIGATION_ELIGIBLE_PERIOD_STATUSES = ["approved", "partially_paid", "paid", "closed"] as const;
export function isObligationEligiblePeriod(status: string): boolean {
  return (OBLIGATION_ELIGIBLE_PERIOD_STATUSES as readonly string[]).includes(status);
}

export type WeekendRule = "shift_earlier" | "shift_later" | "none";

/**
 * Resolve a payout due date from the company schedule. Returns null (never a fabricated date)
 * when the relevant day is unset. Weekend rule shifts a Sat/Sun payout earlier/later. PURE.
 */
export function resolveObligationDueDate(args: {
  year: number;
  month: number; // 1..12
  day: number | null | undefined;
  weekendRule?: string | null;
}): Date | null {
  const { year, month, day } = args;
  if (!day || day < 1 || day > 31) return null;
  // Clamp to the month's real length (e.g. day 31 in a 30-day month → last day).
  const lastDay = new Date(year, month, 0).getDate();
  const d = new Date(year, month - 1, Math.min(day, lastDay));
  const rule = (args.weekendRule ?? "none") as WeekendRule;
  const dow = d.getDay(); // 0 Sun, 6 Sat
  if (rule === "shift_earlier") {
    if (dow === 6) d.setDate(d.getDate() - 1);
    else if (dow === 0) d.setDate(d.getDate() - 2);
  } else if (rule === "shift_later") {
    if (dow === 6) d.setDate(d.getDate() + 2);
    else if (dow === 0) d.setDate(d.getDate() + 1);
  }
  return d;
}

/** Obligation lifecycle from amount/paid/dueDate (pure). No float. */
export function obligationStatusOf(amountKopeks: number, paidKopeks: number, dueDate: Date | null, now: Date): "planned" | "due" | "partially_paid" | "paid" | "cancelled" {
  if (paidKopeks >= amountKopeks && amountKopeks > 0) return "paid";
  if (paidKopeks > 0) return "partially_paid";
  if (dueDate && dueDate.getTime() <= now.getTime()) return "due";
  return "planned";
}

export type GenerateResult = { created: number; updated: number; skipped: number; warnings: string[] };

/**
 * Generate/refresh obligations for one period. Groups the period's calculations by
 * legalEntity + forecast category (advances already folded into netPayableKopeks). Idempotent:
 * upserts by idempotencyKey, so re-running after payments recomputes paid/remaining/status.
 * Does NOT run for non-approved periods. Money mutation-free beyond the obligation table.
 */
export async function generateObligationsForPeriod(periodId: string, now: Date = new Date()): Promise<GenerateResult> {
  const res: GenerateResult = { created: 0, updated: 0, skipped: 0, warnings: [] };
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) {
    res.warnings.push("Период не найден.");
    return res;
  }
  if (!isObligationEligiblePeriod(period.status)) {
    res.warnings.push(`Период не утверждён (${period.status}) — обязательства не создаются.`);
    return res;
  }

  const calcs = await prisma.payrollCalculation.findMany({
    where: { payrollPeriodId: periodId },
    select: { id: true, legalEntityId: true, roleSnapshot: true, netPayableKopeks: true, paidKopeks: true, clubId: true },
  });
  if (calcs.length === 0) {
    res.warnings.push("В периоде нет расчётов.");
    return res;
  }

  // Club primary legal entity (fallback when a calc has no legalEntityId).
  const clubLink = await prisma.clubLegalEntity.findFirst({ where: { clubId: period.clubId, isActive: true }, orderBy: { isPrimary: "desc" }, select: { legalEntityId: true } });
  const clubPrimaryLE = clubLink?.legalEntityId ?? null;

  // Pay date for the final salary payout of this period's month.
  const company = await prisma.company.findUnique({ where: { id: period.companyId }, select: { payrollFinalDay: true, payrollWeekendRule: true } });
  const dueDate = resolveObligationDueDate({ year: period.year, month: period.month, day: company?.payrollFinalDay ?? null, weekendRule: company?.payrollWeekendRule });
  if (!dueDate) res.warnings.push("График выплат не задан (Company.payrollFinalDay) — обязательство создано без даты и не попадёт в календарь до настройки графика.");

  // Group by legalEntity + category.
  type Slice = { legalEntityId: string; category: ForecastCategory; amount: number; paid: number; anyUnassignedLE: boolean };
  const slices = new Map<string, Slice>();
  for (const c of calcs) {
    const le = c.legalEntityId ?? clubPrimaryLE ?? "";
    if (!le) res.warnings.push("Юрлицо не определено для части расчётов (учтено в «Не распределено»).");
    const category = forecastCategoryOfPosition(c.roleSnapshot);
    const key = `${le}|${category}`;
    const cur = slices.get(key) ?? { legalEntityId: le, category, amount: 0, paid: 0, anyUnassignedLE: !le };
    cur.amount += c.netPayableKopeks;
    cur.paid += c.paidKopeks;
    slices.set(key, cur);
  }

  for (const s of slices.values()) {
    if (s.amount <= 0) {
      res.skipped += 1;
      continue;
    }
    const remaining = Math.max(0, s.amount - s.paid);
    const status = obligationStatusOf(s.amount, s.paid, dueDate, now);
    const idempotencyKey = `${period.companyId}:${period.clubId}:${s.legalEntityId}:${s.category}:${period.id}:final_salary`;

    const existing = await prisma.payrollPaymentObligation.findUnique({ where: { idempotencyKey } });
    if (existing) {
      // Never resurrect a cancelled obligation via regeneration.
      if (existing.status === "cancelled") {
        res.skipped += 1;
        continue;
      }
      await prisma.payrollPaymentObligation.update({
        where: { idempotencyKey },
        data: { amountKopeks: s.amount, paidKopeks: s.paid, remainingKopeks: remaining, status, dueDate },
      });
      res.updated += 1;
    } else {
      await prisma.payrollPaymentObligation.create({
        data: {
          companyId: period.companyId,
          clubId: period.clubId,
          legalEntityId: s.legalEntityId,
          payrollPeriodId: period.id,
          payrollType: "final_salary",
          payrollCategory: s.category,
          amountKopeks: s.amount,
          paidKopeks: s.paid,
          remainingKopeks: remaining,
          dueDate,
          status,
          idempotencyKey,
        },
      });
      res.created += 1;
    }
  }
  return res;
}

// --- Calendar wire ----------------------------------------------------------

function mapObligationStatus(status: string): PaymentObligationStatus {
  switch (status) {
    case "paid":
      return "paid";
    case "cancelled":
      return "canceled";
    case "partially_paid":
    case "due":
      return "pending";
    default:
      return "planned";
  }
}

/**
 * Payroll obligations for the payment calendar. Only DATED, non-cancelled rows with a positive
 * remaining and a real club appear — an obligation without a schedule date stays off the dated
 * calendar (never faked). Returns PaymentObligation[] merged by loadPaymentObligationsForScope.
 */
export async function loadPayrollCalendarObligations(companyId: string, clubIds: string[], loadEnd: Date): Promise<PaymentObligation[]> {
  if (clubIds.length === 0) return [];
  const rows = await prisma.payrollPaymentObligation.findMany({
    where: {
      companyId,
      clubId: { in: clubIds },
      status: { not: "cancelled" },
      dueDate: { not: null, lte: loadEnd },
      remainingKopeks: { gt: 0 },
    },
    orderBy: { dueDate: "asc" },
  });
  if (rows.length === 0) return [];

  const clubs = await prisma.club.findMany({ where: { id: { in: clubIds } }, select: { id: true, name: true, city: true } });
  const clubById = new Map(clubs.map((c) => [c.id, c]));

  return rows.map((r) => {
    const club = r.clubId ? clubById.get(r.clubId) : undefined;
    return {
      id: `payroll:${r.id}`,
      sourceType: "payroll" as const,
      sourceId: r.id,
      companyId: r.companyId,
      clubId: r.clubId ?? "",
      clubName: club?.name ?? "",
      city: club?.city ?? null,
      category: "salary",
      title: "Зарплата к выплате",
      amountKopeks: r.remainingKopeks, // the OUTSTANDING amount, not the gross — no double count
      dueDate: r.dueDate as Date,
      status: mapObligationStatus(r.status),
      paidAt: null,
      legalEntityType: null,
      rawStatus: r.status,
      categoryRaw: "salary",
    } satisfies PaymentObligation;
  });
}
