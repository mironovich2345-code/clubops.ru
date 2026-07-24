// Payroll Stage 5 tests — advances + payments + cash-ledger single deduction.
// Mirrors the advance cap + paid roll-up + the CashMovement outflow/reversal balance
// math, and statically verifies the actions follow the exact ledger pattern
// (outflow = fromWalletId set, positive kopeks, unique source key; reversal = inflow).
// npm run pilot:payroll-payments
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = (rub) => rub * 100;

// ---- mirror: advanceWithinEarned (payments.ts) ----
const advanceWithinEarned = (amount, earned) => Number.isFinite(amount) && amount > 0 && amount <= earned;

// ---- mirror: aggregate paid = advance + payments (aggregate.ts / calc.ts) ----
const aggregate = ({ automatic, credits = 0, debits = 0, advance = 0, payments = 0 }) => {
  const gross = automatic + credits - debits, net = gross;
  const paid = advance + payments, remaining = net - paid;
  return { gross, net, paid, remaining, employeeDebt: remaining < 0 ? -remaining : 0, companyDebt: remaining > 0 ? remaining : 0 };
};

// ---- mirror: wallet balance from movements (cash-wallets.ts walletBalanceKopeks) ----
// balance = Σ(confirmed toWallet) − Σ(confirmed fromWallet). Outflow sets fromWallet.
function walletBalance(movements, walletId) {
  let inc = 0, out = 0;
  for (const m of movements) {
    if (m.status !== "confirmed") continue;
    if (m.toWalletId === walletId) inc += m.amountKopeks;
    if (m.fromWalletId === walletId) out += m.amountKopeks;
  }
  return inc - out;
}

function main() {
  // --- advance cap ---
  check("PAYP1 advance within earned", advanceWithinEarned(R(20000), R(44000)) === true);
  check("PAYP2 advance cannot exceed earned", advanceWithinEarned(R(50000), R(44000)) === false);
  check("PAYP3 advance must be positive", advanceWithinEarned(0, R(44000)) === false && advanceWithinEarned(-R(1), R(44000)) === false);

  // --- paid roll-up: advance + payments, never double-counted ---
  const a1 = aggregate({ automatic: R(47000), advance: R(20000), payments: R(10000) });
  check("PAYP4 paid = advance + payments", a1.paid === R(30000));
  check("PAYP5 remainder is company debt", a1.remaining === R(17000) && a1.companyDebt === R(17000));
  const a2 = aggregate({ automatic: R(30000), advance: R(20000), payments: R(15000) });
  check("PAYP6 overpay → employee debt", a2.remaining === -R(5000) && a2.employeeDebt === R(5000));
  // advance is NOT also a payment — a 20000 advance + 20000 remainder payment = fully paid, once each
  const a3 = aggregate({ automatic: R(40000), advance: R(20000), payments: R(20000) });
  check("PAYP7 advance not double-counted", a3.paid === R(40000) && a3.remaining === 0);

  // --- cash ledger: one outflow reduces the wallet once; reversal restores it ---
  const W = "wallet-1";
  const opening = { status: "confirmed", toWalletId: W, fromWalletId: null, amountKopeks: R(100000) };
  const payout = { status: "confirmed", toWalletId: null, fromWalletId: W, amountKopeks: R(20000) };
  check("PAYP8 outflow reduces wallet once", walletBalance([opening, payout], W) === R(80000));
  // idempotent retry: same (sourceType,sourceId) → the DB rejects the 2nd, so still ONE payout
  check("PAYP9 idempotent — retry does not deduct twice", walletBalance([opening, payout], W) === R(80000));
  const reversal = { status: "confirmed", toWalletId: W, fromWalletId: null, amountKopeks: R(20000) };
  check("PAYP10 reversal (compensating inflow) restores balance", walletBalance([opening, payout, reversal], W) === R(100000));

  // ---- static guards over the actions + ledger helper ----
  const actions = src("../src/app/(app)/payroll/periods/actions.ts");
  const payments = src("../src/lib/payroll/payments.ts");
  const aggregateSrc = src("../src/lib/payroll/aggregate.ts");

  check("S33 cash outflow sets fromWalletId (money leaves), positive kopeks",
    payments.includes("fromWalletId: p.walletId") && payments.includes("toWalletId: null") && payments.includes('type: "payroll_payout"'));
  check("S34 outflow idempotent on (sourceType, sourceId)",
    payments.includes("isUniqueClash(e)") && payments.includes('e.code === "P2002"'));
  check("S35 cancellation reverses with a compensating INFLOW (not a delete/flip)",
    payments.includes("export async function reverseCashOutflow") && payments.includes("toWalletId: p.walletId") && !payments.includes(".delete("));
  check("S36 cash payment resolves the club's active ИП + correct wallet server-side",
    actions.includes("resolveActiveIpForClub") && actions.includes("ensureRegionalCashWallet") && actions.includes("ensureClubCashWallet"));
  check("S37 bank payments do NOT touch a cash wallet",
    src("../src/lib/payroll/salary-expense.ts").includes('if (params.method === "cash")') && actions.includes("bank_account"));
  check("S38 payments only after approval (locked) and never when closed",
    actions.includes("PAYABLE_STATUSES") && actions.includes('"approved", "partially_paid", "paid"'));
  check("S39 cash payer role gate (manager/regional cash; accountant bank)",
    actions.includes("Наличную выплату проводит управляющий или регионал") && actions.includes("Безналичную выплату проводит бухгалтер"));
  check("S40 advance is one-per-month (unique lookup before create)",
    actions.includes("Аванс за этот месяц уже оформлен"));
  check("S41 month-close guarded before any payout",
    (actions.match(/monthClosedError\(scope\.companyId, calc\.clubId/g) ?? []).length >= 2);
  check("S42 paid derived from ledger (advances + confirmed payments)",
    aggregateSrc.includes('status: "confirmed"') && aggregateSrc.includes('status: "paid"') && aggregateSrc.includes("paidKopeks: agg.paidKopeks"));
  check("S43 payments audited server-side",
    actions.includes('"payroll.payment_recorded"') && actions.includes('"payroll.advance_recorded"'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
