// Recompute a PayrollCalculation's derived totals (gross/net/remaining/debt) from its
// automatic amount + approved adjustments + recorded payments. Single source of truth
// for the money roll-up (spec §8): accrual = automatic ± adjustments; paid = advance +
// other payments; remaining = net − paid; overpay → employee debt, underpay → company
// debt. Called after any change to inputs, adjustments, advances or payments.
import { prisma } from "@/lib/prisma";
import { aggregateCalculation } from "@/lib/payroll/calc";

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
    // Paid advance(s) for the same employee + club + month (advances are keyed by month,
    // not calculation). Counted as part of paid — and NEVER also counted as a payment.
    period
      ? prisma.payrollAdvance.findMany({
          where: { employeeId: calc.employeeId, clubId: calc.clubId, periodYear: period.year, periodMonth: period.month, status: "paid" },
          select: { amountKopeks: true },
        })
      : Promise.resolve([] as { amountKopeks: number }[]),
  ]);

  const bonuses = adjustments.filter((a) => a.direction === "credit").reduce((s, a) => s + a.amountKopeks, 0);
  const deductions = adjustments.filter((a) => a.direction === "debit").reduce((s, a) => s + a.amountKopeks, 0);
  const advance = advances.reduce((s, a) => s + a.amountKopeks, 0);
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
