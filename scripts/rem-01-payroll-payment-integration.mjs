// REM-01 — REAL DB-backed integration + failure-injection tests (spec §19/§20). This does NOT
// mirror the logic or grep source — it imports and EXECUTES the actual executePayrollPayment /
// executePayrollReversal service (via jiti) against a DISPOSABLE sqlite copy of the real schema,
// then asserts the actual rows. Cleans up its temp DB. Read-only w.r.t. the dev DB (it copies it).
//   node scripts/rem-01-payroll-payment-integration.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { copyFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = process.env.CLUBOPS_SCRATCH || join(ROOT, ".rem01-tmp");
mkdirSync(SCRATCH, { recursive: true });
const TMP_DB = join(SCRATCH, "rem01-payroll.db");
const SRC = join(ROOT, "src");

// Disposable DB = a copy of the migrated dev schema. We only touch our own synthetic company.
const DEV_DB = join(ROOT, "prisma", "dev.db");
if (!existsSync(DEV_DB)) { console.error("dev.db not found — run prisma migrate deploy first"); process.exit(1); }
for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true });
copyFileSync(DEV_DB, TMP_DB);
process.env.DATABASE_URL = "file:" + TMP_DB.replace(/\\/g, "/");

const require = createRequire(import.meta.url);
const jiti = require("jiti")(fileURLToPath(import.meta.url), {
  alias: { "@": SRC, "server-only": join(ROOT, "scripts", "_stubs", "server-only.cjs") },
  interopDefault: true, esmResolve: true,
});

const svc = jiti("@/lib/payroll/payment-service.ts");
const { prisma } = jiti("@/lib/prisma.ts");

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 10);

async function seed() {
  const companyId = uid("co");
  const clubId = uid("club");
  const leId = uid("le");
  const empId = uid("emp");
  const userId = uid("user");
  const periodId = uid("per");
  const calcId = uid("calc");
  await prisma.company.create({ data: { id: companyId, name: "REM01 Test Co" } });
  await prisma.user.create({ data: { id: userId, email: uid("u") + "@t.local", name: "Tester", role: "accountant", passwordHash: "x" } });
  await prisma.club.create({ data: { id: clubId, companyId, name: "Club", city: "Town" } });
  await prisma.legalEntity.create({ data: { id: leId, companyId, name: "ИП Тест", type: "ip", inn: uid("inn") } });
  await prisma.clubLegalEntity.create({ data: { clubId, legalEntityId: leId, isPrimary: true, isActive: true } });
  await prisma.clubEmployee.create({ data: { id: empId, companyId, clubId, fullName: "Иван Тест", position: "manager", status: "active" } });
  await prisma.payrollPeriod.create({ data: { id: periodId, companyId, clubId, year: 2026, month: 7, status: "approved", createdByUserId: userId } });
  await prisma.payrollCalculation.create({ data: { id: calcId, companyId, payrollPeriodId: periodId, employeeId: empId, clubId, legalEntityId: leId, automaticAmountKopeks: 100000, grossAccruedKopeks: 100000, netPayableKopeks: 100000, paidKopeks: 0, remainingKopeks: 100000, status: "approved" } });
  const wallet = await prisma.cashWallet.create({ data: { companyId, clubId, legalEntityId: leId, type: "club_cash", holderUserId: null } });
  return { companyId, clubId, leId, empId, userId, periodId, calcId, walletId: wallet.id };
}

function baseInput(s, over = {}) {
  return {
    companyId: s.companyId, clubId: s.clubId, legalEntityId: s.leId, method: "cash", sourceType: "club_cash",
    paymentType: "regular", payrollCalculationId: s.calcId, employeeId: s.empId, employeeName: "Иван Тест",
    payrollPeriodId: s.periodId, cashWalletId: s.walletId, amountKopeks: 40000, paymentDate: new Date("2026-07-25T10:00:00Z"),
    paidByUserId: s.userId, comment: null, documentKey: null, idempotencyKey: uid("idem"),
    remaining: { currentRemainingKopeks: 100000, allowOverpayment: false, useCalcRemaining: true },
    refreshObligationsForPeriodId: null, expenseKind: "payment", ...over,
  };
}
const countFor = async (s) => ({
  payments: await prisma.payrollPayment.count({ where: { companyId: s.companyId } }),
  expenses: await prisma.expense.count({ where: { companyId: s.companyId, category: "salary" } }),
  movements: await prisma.cashMovement.count({ where: { companyId: s.companyId } }),
});

async function main() {
  // 1-5: one payment = one effect, correct tenant, calc updated.
  {
    const s = await seed();
    const r = await svc.executePayrollPayment(baseInput(s), prisma);
    check("1 ordinary payment ok", r.ok === true && r.replayed === false, JSON.stringify(r));
    const c = await countFor(s);
    check("2 exactly one PayrollPayment", c.payments === 1, `got ${c.payments}`);
    check("3 exactly one salary Expense", c.expenses === 1, `got ${c.expenses}`);
    check("4 exactly one CashMovement", c.movements === 1, `got ${c.movements}`);
    const calc = await prisma.payrollCalculation.findUnique({ where: { id: s.calcId } });
    check("5 calc paid/remaining updated (40000/60000)", calc.paidKopeks === 40000 && calc.remainingKopeks === 60000, `paid=${calc.paidKopeks} rem=${calc.remainingKopeks}`);
    const pay = await prisma.payrollPayment.findFirst({ where: { companyId: s.companyId } });
    check("6 payment tenant + expense link consistent", pay.legalEntityId === s.leId && pay.clubId === s.clubId && !!pay.expenseId && !!pay.idempotencyKey);
  }
  // 7-9: replay safety.
  {
    const s = await seed();
    const input = baseInput(s);
    const r1 = await svc.executePayrollPayment(input, prisma);
    const r2 = await svc.executePayrollPayment(input, prisma); // same key + same fingerprint
    check("7 replay returns same payment", r2.ok && r2.replayed === true && r2.paymentId === r1.paymentId, JSON.stringify(r2));
    const c = await countFor(s);
    check("8 replay created NO extra rows", c.payments === 1 && c.expenses === 1 && c.movements === 1, JSON.stringify(c));
    const r3 = await svc.executePayrollPayment({ ...input, amountKopeks: 55000 }, prisma); // same key, different amount
    check("9 same key + different fingerprint → conflict", r3.ok === false && r3.code === "IDEMPOTENCY_CONFLICT", JSON.stringify(r3));
    check("9b conflict created no rows", (await countFor(s)).payments === 1);
  }
  // 10-12: guards.
  {
    const s = await seed();
    const over = await svc.executePayrollPayment(baseInput(s, { amountKopeks: 150000 }), prisma);
    check("10 overpayment blocked (>remaining)", over.ok === false && over.code === "PAYMENT_EXCEEDS_REMAINING", JSON.stringify(over));
    const zero = await svc.executePayrollPayment(baseInput(s, { amountKopeks: 0 }), prisma);
    check("11 zero amount blocked", zero.ok === false && zero.code === "INVALID_AMOUNT");
    const neg = await svc.executePayrollPayment(baseInput(s, { amountKopeks: -100 }), prisma);
    check("12 negative amount blocked", neg.ok === false && neg.code === "INVALID_AMOUNT");
    check("12b guards created no rows", (await countFor(s)).payments === 0);
  }
  // 13-16: failure injection → full rollback (nothing persists).
  for (const point of ["after_payment_create", "after_expense_create", "after_cash_movement", "before_commit"]) {
    const s = await seed();
    let threw = false;
    try { await svc.executePayrollPayment(baseInput(s, { _failAt: point }), prisma); } catch { threw = true; }
    const c = await countFor(s);
    check(`13.${point} injected failure rolls back ALL writes`, threw && c.payments === 0 && c.expenses === 0 && c.movements === 0, `threw=${threw} ${JSON.stringify(c)}`);
  }
  // 17: after_commit + retry is safe (returns existing, no new rows).
  {
    const s = await seed();
    const input = baseInput(s, { _failAt: "after_commit" });
    let threw = false;
    try { await svc.executePayrollPayment(input, prisma); } catch { threw = true; } // commit happened, then threw
    check("17a after-commit failure did persist exactly one effect", threw && (await countFor(s)).payments === 1);
    const retry = await svc.executePayrollPayment({ ...input, _failAt: undefined }, prisma); // client retries same key
    check("17b retry after commit returns existing (replay), no new rows", retry.ok && retry.replayed === true && (await countFor(s)).payments === 1, JSON.stringify(retry));
  }
  // 18-20: advance + reversal atomics.
  {
    const s = await seed();
    const adv = await svc.executePayrollPayment(baseInput(s, { paymentType: "advance", expenseKind: "advance", amountKopeks: 30000 }), prisma);
    check("18 advance uses the same protected service", adv.ok && adv.replayed === false);
    const rev = await svc.executePayrollReversal({ paymentId: adv.paymentId, userId: s.userId, reason: "test reversal" }, prisma);
    check("19 reversal atomically cancels the payment", rev.ok && rev.reversed === true, JSON.stringify(rev));
    const pay = await prisma.payrollPayment.findUnique({ where: { id: adv.paymentId } });
    const exp = await prisma.expense.findUnique({ where: { id: pay.expenseId } });
    const inflow = await prisma.cashMovement.count({ where: { companyId: s.companyId, toWalletId: s.walletId } });
    check("20 reversal: payment canceled + expense cancelled + compensating inflow", pay.status === "canceled" && exp.status === "cancelled" && inflow >= 1, `pay=${pay.status} exp=${exp.status} inflow=${inflow}`);
    const rev2 = await svc.executePayrollReversal({ paymentId: adv.paymentId, userId: s.userId, reason: "again" }, prisma);
    check("21 double reversal is an idempotent no-op", rev2.ok && rev2.reversed === false, JSON.stringify(rev2));
    const calc = await prisma.payrollCalculation.findUnique({ where: { id: s.calcId } });
    check("22 reversal restored calc remaining to full", calc.remainingKopeks === 100000 && calc.paidKopeks === 0, `paid=${calc.paidKopeks} rem=${calc.remainingKopeks}`);
  }

  // 23: two PARALLEL requests with the SAME key create exactly one effect.
  {
    const s = await seed();
    const input = baseInput(s);
    const [a, b] = await Promise.all([svc.executePayrollPayment(input, prisma), svc.executePayrollPayment(input, prisma)]);
    const oneOk = [a, b].filter((r) => r.ok).length === 2; // both succeed (one creates, one replays)
    const samePayment = a.ok && b.ok && a.paymentId === b.paymentId;
    const c = await countFor(s);
    check("23 parallel same-key → exactly one effect", oneOk && samePayment && c.payments === 1 && c.expenses === 1 && c.movements === 1, `${JSON.stringify(c)} a=${a.paymentId} b=${b.paymentId}`);
  }
  // 24: two PARALLEL requests with DIFFERENT keys cannot together exceed remaining.
  {
    const s = await seed(); // remaining = 100000
    const i1 = baseInput(s, { amountKopeks: 60000 });
    const i2 = baseInput(s, { amountKopeks: 60000 });
    const [a, b] = await Promise.all([svc.executePayrollPayment(i1, prisma), svc.executePayrollPayment(i2, prisma)]);
    const oks = [a, b].filter((r) => r.ok).length;
    const blocked = [a, b].filter((r) => !r.ok && r.code === "PAYMENT_EXCEEDS_REMAINING").length;
    const calc = await prisma.payrollCalculation.findUnique({ where: { id: s.calcId } });
    check("24 parallel different-key cannot overpay remaining", oks === 1 && blocked === 1 && calc.remainingKopeks === 40000, `oks=${oks} blocked=${blocked} rem=${calc.remainingKopeks}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true });
  if (fail) process.exit(1);
}
main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {} for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true }); process.exit(1); });
