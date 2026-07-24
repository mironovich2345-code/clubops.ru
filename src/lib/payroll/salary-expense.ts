// Payroll payout → finance (spec item 2). A PayrollPayment / paid PayrollAdvance is the
// ACTUAL salary EXPENSE: it creates exactly ONE Expense{category:"salary"} (which drives
// P&L + the ООО/ИП fact balance + expense reports) and, for CASH, the single wallet
// CashMovement via the existing recordExpenseMovement — identical to any cash expense, so
// money is deducted exactly once. There is NO separate payroll CashMovement anymore.
// Cancellation cancels the Expense (drops it from P&L / fact balance) and reverses the
// cash movement with a compensating inflow.
import { prisma } from "@/lib/prisma";
import { recordExpenseMovement } from "@/lib/cash-wallets";
import { reverseCashOutflow } from "@/lib/payroll/payments";

export const SALARY_EXPENSE_TYPE = "payroll_payment"; // distinct from legacy "payroll_statement"
export const SALARY_EXPENSE_CATEGORY = "salary";
const SALARY_EXPENSE_REVERSAL = "payroll_expense_reversal";

export type SalaryExpenseKind = "payment" | "advance";

/**
 * Create the salary Expense for one payout. For cash it also posts the single wallet
 * movement. legalEntityId + cashWalletId are resolved server-side by the caller.
 */
export async function createSalaryExpense(params: {
  companyId: string;
  clubId: string;
  legalEntityId: string;
  method: "cash" | "bank";
  amountKopeks: number;
  paidByUserId: string;
  cashWalletId: string | null;
  employeeId: string;
  employeeName: string;
  payrollPeriodId: string | null;
  kind: SalaryExpenseKind;
}): Promise<{ expenseId: string }> {
  const now = new Date();
  const label = params.kind === "advance" ? "аванс" : "выплата";
  const expense = await prisma.expense.create({
    data: {
      companyId: params.companyId,
      clubId: params.clubId,
      legalEntityId: params.legalEntityId,
      createdByUserId: params.paidByUserId,
      paidByUserId: params.paidByUserId,
      type: SALARY_EXPENSE_TYPE,
      category: SALARY_EXPENSE_CATEGORY,
      amountKopeks: params.amountKopeks,
      currency: "RUB",
      expenseDate: now,
      status: "confirmed", // payroll has its own approval; this is the confirmed payout
      confidence: "high",
      entryVersion: 2, // counted in the ООО/ИП cash fact balance (for cash)
      paymentMethod: params.method,
      cashWalletId: params.method === "cash" ? params.cashWalletId : null,
      recipientName: params.employeeName,
      generatedTitle: `Зарплата: ${params.employeeName}`,
      comment: `Выплата зарплаты (${label})`,
      // Structured back-link so the payroll payout is identifiable (помечается) and a
      // manual duplicate salary expense can be spotted/avoided.
      notes: JSON.stringify({ source: "payroll", kind: params.kind, employeeId: params.employeeId, payrollPeriodId: params.payrollPeriodId }),
    },
    select: { id: true },
  });

  if (params.method === "cash") {
    await recordExpenseMovement({
      id: expense.id,
      companyId: params.companyId,
      clubId: params.clubId,
      legalEntityId: params.legalEntityId,
      amountKopeks: params.amountKopeks,
      expenseDate: now,
      cashWalletId: params.cashWalletId,
    });
  }
  return { expenseId: expense.id };
}

/** Cancel the salary Expense (drops from P&L / fact balance) and reverse its cash movement. */
export async function cancelSalaryExpense(expenseId: string | null | undefined, userId: string, reason: string): Promise<void> {
  if (!expenseId) return;
  const exp = await prisma.expense.findUnique({
    where: { id: expenseId },
    select: { id: true, companyId: true, clubId: true, legalEntityId: true, amountKopeks: true, paymentMethod: true, status: true },
  });
  if (!exp || exp.status === "cancelled") return;

  if (exp.paymentMethod === "cash" && exp.legalEntityId) {
    const mv = await prisma.cashMovement.findFirst({
      where: { sourceType: "expense", sourceId: expenseId },
      select: { fromWalletId: true },
    });
    if (mv?.fromWalletId) {
      await reverseCashOutflow({
        companyId: exp.companyId,
        clubId: exp.clubId,
        legalEntityId: exp.legalEntityId,
        walletId: mv.fromWalletId,
        amountKopeks: exp.amountKopeks,
        occurredAt: new Date(),
        reversalSourceType: SALARY_EXPENSE_REVERSAL,
        sourceId: expenseId,
        userId,
      });
    }
  }
  await prisma.expense.update({
    where: { id: expenseId },
    data: { status: "cancelled", cancelledAt: new Date(), cancelledByUserId: userId, cancellationReason: reason },
  });
}
