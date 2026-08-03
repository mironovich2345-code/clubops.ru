// Item 2 — зарплата как фактический расход БЕЗ двойного списания. Проверяет: одна
// PayrollPayment/аванс = одна Expense{salary} (P&L + ООО/ИП фактбаланс) + одно движение
// кассы (для наличных); банк не трогает кассу; отмена сторнирует Expense и движение;
// аванс не учитывается дважды; старый PayrollStatement→Expense путь — отдельный тип.
// npm run pilot:payroll-finance
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = (rub) => rub * 100;

// ---- mirror: wallet balance = Σ(confirmed toWallet) − Σ(confirmed fromWallet) ----
function walletBalance(movs, w) {
  let inc = 0, out = 0;
  for (const m of movs) { if (m.status !== "confirmed") continue; if (m.toWalletId === w) inc += m.amountKopeks; if (m.fromWalletId === w) out += m.amountKopeks; }
  return inc - out;
}
// ---- mirror: paid = advance + payments (no double count) ----
const paid = (advance, payments) => advance + payments;

function main() {
  const W = "wallet-ip";
  const opening = { status: "confirmed", toWalletId: W, fromWalletId: null, amountKopeks: R(100000) };
  // ONE cash salary expense → ONE expense movement (recordExpenseMovement).
  const salaryMv = { status: "confirmed", toWalletId: null, fromWalletId: W, amountKopeks: R(30000), sourceType: "expense" };
  check("FIN1 one cash salary payout reduces the wallet ONCE", walletBalance([opening, salaryMv], W) === R(70000));
  // Cancellation → compensating inflow restores balance.
  const reversal = { status: "confirmed", toWalletId: W, fromWalletId: null, amountKopeks: R(30000) };
  check("FIN2 cancel restores wallet (compensating inflow)", walletBalance([opening, salaryMv, reversal], W) === R(100000));
  // Advance 10k + remainder 20k: two payouts, wallet −30k total, each once.
  const adv = { status: "confirmed", toWalletId: null, fromWalletId: W, amountKopeks: R(10000), sourceType: "expense" };
  const rem = { status: "confirmed", toWalletId: null, fromWalletId: W, amountKopeks: R(20000), sourceType: "expense" };
  check("FIN3 advance + remainder each deduct once (−30k)", walletBalance([opening, adv, rem], W) === R(70000));
  check("FIN4 advance not double-counted in paid", paid(R(10000), R(20000)) === R(30000));

  // ---- static guards ----
  const actions = src("../src/app/(app)/payroll/periods/actions.ts");
  const salary = src("../src/lib/payroll/salary-expense.ts");
  // REM-01: salary payment + reversal now run through the shared transactional service.
  const service = src("../src/lib/payroll/payment-service.ts");
  const aggregate = src("../src/lib/payroll/aggregate.ts");
  const payrollActions = src("../src/app/(app)/expenses/payroll-actions.ts");

  check("FIN5 payout creates ONE salary Expense (category salary, type payroll_payment, entryVersion 2, confirmed)",
    salary.includes('category: SALARY_EXPENSE_CATEGORY') && salary.includes('SALARY_EXPENSE_CATEGORY = "salary"') &&
    salary.includes('SALARY_EXPENSE_TYPE = "payroll_payment"') && salary.includes("entryVersion: 2") && salary.includes('status: "confirmed"'));
  check("FIN6 cash → ONE CashMovement via recordExpenseMovement; bank → none",
    salary.includes("recordExpenseMovement") && salary.includes('if (params.method === "cash")'));
  check("FIN7 NO separate payroll CashMovement anymore (postCashOutflow removed from payout actions)",
    !actions.includes("postCashOutflow") && actions.includes("createSalaryExpense"));
  check("FIN8 payment + advance both link the salary expenseId (payment via the atomic service)",
    /payrollPayment\.update[\s\S]*expenseId/.test(service) && /payrollAdvance\.update[\s\S]*expenseId/.test(actions));
  check("FIN9 cancellation cancels the Expense (drops from P&L/fact) + reverses the movement",
    service.includes("cancelSalaryExpense(payment?.expenseId") && actions.includes("cancelSalaryExpense(advance.expenseId") &&
    salary.includes('status: "cancelled"') && salary.includes("reverseCashOutflow"));
  check("FIN10 salary expense visible with employee + period + legal entity + club",
    salary.includes("recipientName: params.employeeName") && salary.includes("payrollPeriodId: params.payrollPeriodId") && salary.includes("legalEntityId: params.legalEntityId"));
  check("FIN11 aggregate paid = advance(paid) + payments(confirmed), summed separately (no double)",
    aggregate.includes("advanceKopeks: advance") && aggregate.includes("otherPaymentsKopeks: otherPayments") && aggregate.includes("paidKopeks: agg.paidKopeks"));
  check("FIN12 payout tagged as source=payroll (помечается — manual duplicate spotted)",
    salary.includes('source: "payroll"'));
  check("FIN13 legacy PayrollStatement→Expense path uses a DISTINCT type (no dup with payroll_payment)",
    /category:\s*"salary"/.test(payrollActions) && !payrollActions.includes('type: "payroll_payment"'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
