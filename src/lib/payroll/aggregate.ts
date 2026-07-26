// Recompute a PayrollCalculation's derived totals (gross/net/remaining/debt) from its
// automatic amount + approved adjustments + recorded payments. Single source of truth
// for the money roll-up (spec §8): accrual = automatic ± adjustments; paid = advance +
// other payments; remaining = net − paid; overpay → employee debt, underpay → company
// debt. Called after any change to inputs, adjustments, advances or payments.
import { prisma } from "@/lib/prisma";
import { aggregateCalculation } from "@/lib/payroll/calc";
import { advancePaidKopeks } from "@/lib/payroll/advance-tranche-calc";

export async function recomputeCalculationTotals(calculationId: string): Promise<void> {
  const calc = await prisma.payrollCalculation.findUnique({ where: { id: calculationId } });
  if (!calc) return;
  const period = await prisma.payrollPeriod.findUnique({
    where: { id: calc.payrollPeriodId },
    select: { year: true, month: true },
  });

  const [adjustments, payments, advances] = await Promise.all([
    prisma.payrollAdjustment.findMany({
      where: { payrollCalculationId: calculationId, status: "approved" },
      select: { direction: true, amountKopeks: true },
    }),
    // Confirmed salary payments for THIS calculation.
    prisma.payrollPayment.findMany({
      where: { payrollCalculationId: calculationId, status: "confirmed" },
      select: { amountKopeks: true },
    }),
    // Advance(s) for the same employee + club + month (keyed by month, not calc). Only the
    // ACTUALLY-PAID part (Σ active tranches; legacy fallback to the single amount) counts —
    // approved-but-unpaid does NOT reduce salary remaining (spec §13). NEVER counted as a
    // PayrollPayment as well.
    period
      ? prisma.payrollAdvance.findMany({
          where: { employeeId: calc.employeeId, clubId: calc.clubId, periodYear: period.year, periodMonth: period.month, status: { notIn: ["canceled", "rejected"] } },
          select: { id: true, amountKopeks: true, status: true },
        })
      : Promise.resolve([] as { id: string; amountKopeks: number; status: string }[]),
  ]);

  // Active tranches for the month's advances (folded per advance).
  const advanceIds = advances.map((a) => a.id);
  const tranches = advanceIds.length
    ? await prisma.payrollAdvancePayment.findMany({ where: { employeeAdvanceId: { in: advanceIds } }, select: { employeeAdvanceId: true, amountKopeks: true, status: true } })
    : [];
  const trBy = new Map<string, { amountKopeks: number; status: string }[]>();
  for (const t of tranches) { const l = trBy.get(t.employeeAdvanceId) ?? []; l.push({ amountKopeks: t.amountKopeks, status: t.status }); trBy.set(t.employeeAdvanceId, l); }

  const bonuses = adjustments.filter((a) => a.direction === "credit").reduce((s, a) => s + a.amountKopeks, 0);
  const deductions = adjustments.filter((a) => a.direction === "debit").reduce((s, a) => s + a.amountKopeks, 0);
  const advance = advances.reduce((s, a) => s + advancePaidKopeks(a, trBy.get(a.id) ?? []), 0);
  const otherPayments = payments.reduce((s, p) => s + p.amountKopeks, 0);

  const agg = aggregateCalculation({
    automaticKopeks: calc.automaticAmountKopeks,
    adjustments: adjustments.map((a) => ({ direction: a.direction === "debit" ? "debit" : "credit", amountKopeks: a.amountKopeks })),
    advanceKopeks: advance,
    otherPaymentsKopeks: otherPayments,
  });

  await prisma.payrollCalculation.update({
    where: { id: calc.id },
    data: {
      bonusesKopeks: bonuses,
      deductionsKopeks: deductions,
      advancesKopeks: advance,
      paidKopeks: agg.paidKopeks,
      grossAccruedKopeks: agg.grossAccruedKopeks,
      netPayableKopeks: agg.netPayableKopeks,
      remainingKopeks: agg.remainingKopeks,
      employeeDebtKopeks: agg.employeeDebtKopeks,
      companyDebtKopeks: agg.companyDebtKopeks,
    },
  });
}
