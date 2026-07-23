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

  const adjustments = await prisma.payrollAdjustment.findMany({
    where: { payrollCalculationId: calculationId, status: "approved" },
    select: { direction: true, amountKopeks: true },
  });
  const bonuses = adjustments.filter((a) => a.direction === "credit").reduce((s, a) => s + a.amountKopeks, 0);
  const deductions = adjustments.filter((a) => a.direction === "debit").reduce((s, a) => s + a.amountKopeks, 0);

  // advancesKopeks is maintained by the advance flow (Stage 5); paidKopeks is the total
  // already paid (advance + payments). otherPayments = paid − advance (never negative).
  const advance = calc.advancesKopeks;
  const otherPayments = Math.max(0, calc.paidKopeks - advance);

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
      grossAccruedKopeks: agg.grossAccruedKopeks,
      netPayableKopeks: agg.netPayableKopeks,
      remainingKopeks: agg.remainingKopeks,
      employeeDebtKopeks: agg.employeeDebtKopeks,
      companyDebtKopeks: agg.companyDebtKopeks,
    },
  });
}
