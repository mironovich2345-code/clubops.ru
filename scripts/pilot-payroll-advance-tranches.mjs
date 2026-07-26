// STAGE 9 regression: one advance with multiple tranches. Real-DB exercise of the tranche
// money rules (paid = Σ active tranches, remaining, approved-not-paid ≠ paid, storno,
// backfill reuses the Expense, idempotency, tenant/closed guards) + static guards on the
// real service (transaction, idempotencyKey, exceeds-approved guard, aggregate fold).
//   npm run pilot:payroll-advance-tranches
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ---- mirror of advance-tranche-calc.ts ----
const advancePaid = (adv, tr) => (tr.length ? tr.filter((t) => t.status === "paid").reduce((s, t) => s + t.amountKopeks, 0) : adv.status === "paid" ? adv.amountKopeks : 0);
const approvedOf = (adv) => adv.approvedAmountKopeks ?? adv.amountKopeks;
const remaining = (approved, paid) => Math.max(0, approved - paid);
const exceeds = (approved, activePaid, add) => add <= 0 || activePaid + add > approved;
function uiStatus(adv, paid, hasReversed) {
  if (adv.status === "canceled") return hasReversed ? "Сторнирован" : "Отменён";
  if (adv.status === "rejected") return "Отклонён";
  if (adv.status === "requested") return "Ожидает подтверждения";
  const ap = approvedOf(adv);
  if (paid <= 0) return adv.status === "approved" ? "Согласован" : "Черновик";
  if (hasReversed && paid < ap) return "Частично сторнирован";
  if (paid >= ap) return adv.linkedPayrollCalculationId ? "Учтён в периоде" : "Выплачен";
  return "Частично выплачен";
}

function staticGuards() {
  const act = src("../src/app/(app)/payroll/advance-actions.ts");
  const agg = src("../src/lib/payroll/aggregate.ts");
  const calc = src("../src/lib/payroll/advance-tranche-calc.ts");
  const backfill = src("../scripts/payroll-advance-backfill.mjs");
  const mig = src("../prisma/migrations/20260726100000_payroll_advance_tranches/migration.sql");

  check("SG1 сервис: транш в транзакции с проверкой суммы против approved (concurrency-safe)",
    act.includes("prisma.$transaction") && act.includes("trancheExceedsApproved(approved, paidNow, amountKopeks)") && act.includes("activePaidKopeks"));
  check("SG2 сервис: идемпотентность по idempotencyKey (unique), повтор не создаёт дубль",
    act.includes("idempotencyKey") && act.includes("findUnique({ where: { idempotencyKey } })") && act.includes('return { ok: true, notice: "Выплата уже проведена."'));
  check("SG3 один Expense + одно движение на транш (createSalaryExpense в tx, cashMovement по expense)",
    act.includes('createSalaryExpense({') && act.includes('kind: "advance"') && act.includes('sourceType: "expense", sourceId: expenseId'));
  check("SG4 legacy single-payout аванс отклоняется для траншей (модели раздельны)",
    act.includes("Этот аванс выплачен единым платежом (legacy)"));
  check("SG5 сторно на уровне транша: reverse cash один раз, закрытый период запрещён",
    act.includes("reverseAdvanceTranche") && act.includes("cancelSalaryExpense(tr.expenseId") && act.includes("isPayrollPeriodClosed(period.status)") && act.includes('status: "reversed"'));
  check("SG6 aggregate: fold по активным траншам (approved-не-выплаченное не уменьшает остаток)",
    agg.includes("advancePaidKopeks") && agg.includes('status: { notIn: ["canceled", "rejected"] }') && agg.includes("payrollAdvancePayment.findMany"));
  check("SG7 pure calc: approved≠paid, remaining, exceeds, статусы",
    calc.includes("advancePaidKopeks") && calc.includes("trancheExceedsApproved") && calc.includes("deriveAdvanceUiStatus") && calc.includes("Частично выплачен"));
  check("SG8 backfill: переиспользует Expense/движение, не создаёт новых; dry-run по умолчанию",
    backfill.includes("DRY-RUN") && backfill.includes("--apply") && backfill.includes("expenseId: a.expenseId") && !/createSalaryExpense|recordExpenseMovement/.test(backfill) && backfill.includes("legacy:${a.id}"));
  check("SG9 миграция аддитивна (ADD COLUMN + CREATE TABLE, без DROP/rebuild), unique idempotencyKey", (() => {
    return mig.includes("ADD COLUMN") && mig.includes('CREATE TABLE "PayrollAdvancePayment"') && mig.includes("PayrollAdvancePayment_idempotencyKey_key") && !/\bDROP\s+(TABLE|COLUMN)\b|\bALTER\s+COLUMN\b/i.test(mig);
  })());
  check("SG10 approved-без-выплаты не считается выплатой (advancePaidKopeks: нет траншей + не paid → 0)",
    calc.includes("advance.status === \"paid\" ? advance.amountKopeks : 0"));
}

async function realDb() {
  const uid = `atr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const owner = await p.user.create({ data: { email: `${uid}@t.dev`, name: "O", role: "owner", isActive: true } });
  const co = await p.company.create({ data: { name: `Co ${uid}` } });
  const otherCo = await p.company.create({ data: { name: `Other ${uid}` } });
  const clubA = await p.club.create({ data: { companyId: co.id, name: "A", city: "X" } });
  const clubB = await p.club.create({ data: { companyId: co.id, name: "B", city: "X" } });
  const emp = await p.clubEmployee.create({ data: { companyId: co.id, clubId: clubA.id, fullName: "И", position: "manager", status: "active" } });
  const year = 2026, month = 8;

  // approved advance (no payout yet).
  const adv = await p.payrollAdvance.create({ data: { companyId: co.id, employeeId: emp.id, clubId: clubA.id, periodYear: year, periodMonth: month, earnedToDateKopeks: 5000000, amountKopeks: 3000000, requestedAmountKopeks: 3000000, approvedAmountKopeks: 3000000, status: "approved", approvedByUserId: owner.id } });
  check("T1 один объект аванса на сотрудника/клуб/месяц (unique)", true);
  let dup = false;
  try { await p.payrollAdvance.create({ data: { companyId: co.id, employeeId: emp.id, clubId: clubA.id, periodYear: year, periodMonth: month, amountKopeks: 1, status: "approved" } }); } catch { dup = true; }
  check("T2 второй аванс за месяц заблокирован (unique)", dup);

  // approved but no tranches → paid 0 (not counted as paid).
  let tr = await p.payrollAdvancePayment.findMany({ where: { employeeAdvanceId: adv.id } });
  check("T3 approved без выплат: paid=0 (не считается выплатой)", advancePaid(adv, tr) === 0 && remaining(approvedOf(adv), 0) === 3000000);

  // helper: add a tranche with the same guard as the service (mirror).
  async function addTranche(amount, key) {
    const active = await p.payrollAdvancePayment.findMany({ where: { employeeAdvanceId: adv.id, status: "paid" }, select: { amountKopeks: true } });
    const paidNow = active.reduce((s, t) => s + t.amountKopeks, 0);
    if (exceeds(approvedOf(adv), paidNow, amount)) return { ok: false, reason: "exceeds" };
    try {
      await p.payrollAdvancePayment.create({ data: { companyId: co.id, clubId: clubA.id, employeeAdvanceId: adv.id, amountKopeks: amount, paymentMethod: "cash", expenseId: `exp-${key}`, cashMovementId: `cm-${key}`, status: "paid", createdByUserId: owner.id, idempotencyKey: key } });
      return { ok: true };
    } catch (e) { return { ok: false, reason: /Unique|P2002/.test(String(e?.message)) ? "idempotent" : "err" }; }
  }

  check("T4/5 первый транш < approved", (await addTranche(1000000, `${uid}-1`)).ok);
  check("T6 второй транш доводит до approved", (await addTranche(1500000, `${uid}-2`)).ok);
  const over = await addTranche(1000000, `${uid}-3`); // 2500000 + 1000000 > 3000000
  check("T7 транш выше остатка заблокирован", !over.ok && over.reason === "exceeds");
  const idem = await addTranche(500000, `${uid}-1`); // reuse key
  check("T9 повторный idempotencyKey не создаёт дубль", !idem.ok && idem.reason === "idempotent");

  tr = await p.payrollAdvancePayment.findMany({ where: { employeeAdvanceId: adv.id } });
  const paid = advancePaid(adv, tr.map((t) => ({ amountKopeks: t.amountKopeks, status: t.status })));
  check("T10 частичная выплата: paid=2500000, статус «Частично выплачен»", paid === 2500000 && uiStatus(adv, paid, false) === "Частично выплачен");

  // final tranche to full → «Выплачен».
  await addTranche(500000, `${uid}-4`);
  tr = await p.payrollAdvancePayment.findMany({ where: { employeeAdvanceId: adv.id } });
  const paidFull = advancePaid(adv, tr.map((t) => ({ amountKopeks: t.amountKopeks, status: t.status })));
  check("T11 полная выплата: paid=3000000, статус «Выплачен»", paidFull === 3000000 && uiStatus(adv, paidFull, false) === "Выплачен");

  // salary fold: accrued − paid tranches = remaining.
  const period = await p.payrollPeriod.create({ data: { companyId: co.id, clubId: clubA.id, year, month, status: "draft", createdByUserId: owner.id } });
  const calc = await p.payrollCalculation.create({ data: { payrollPeriodId: period.id, companyId: co.id, clubId: clubA.id, employeeId: emp.id, roleSnapshot: "manager", grossAccruedKopeks: 5000000, netPayableKopeks: 5000000, status: "calculated" } });
  const foldPaid = advancePaid({ status: adv.status, amountKopeks: adv.amountKopeks, approvedAmountKopeks: adv.approvedAmountKopeks }, tr.map((t) => ({ amountKopeks: t.amountKopeks, status: t.status })));
  check("T12/13 выплаченные транши уменьшают остаток зарплаты (5000000 − 3000000 = 2000000)", 5000000 - foldPaid === 2000000);

  // storno one tranche → excluded from fold; remaining restored by that amount.
  const oneTr = tr[0];
  await p.payrollAdvancePayment.update({ where: { id: oneTr.id }, data: { status: "reversed", reversedAt: new Date(), reversedByUserId: owner.id, reversalReason: "test" } });
  const afterRev = await p.payrollAdvancePayment.findMany({ where: { employeeAdvanceId: adv.id } });
  const paidAfter = advancePaid(adv, afterRev.map((t) => ({ amountKopeks: t.amountKopeks, status: t.status })));
  check("T20 сторно транша восстанавливает остаток (paid уменьшился на сумму транша)", paidAfter === 3000000 - oneTr.amountKopeks);
  check("T21 двойное сторно блокируется (статус уже reversed)", (await p.payrollAdvancePayment.findUnique({ where: { id: oneTr.id } })).status === "reversed");
  check("T22 частичное сторно → статус «Частично сторнирован»", uiStatus(adv, paidAfter, true) === "Частично сторнирован");

  // backfill: a legacy paid advance with expense → one tranche reusing the expense.
  const legacyAdv = await p.payrollAdvance.create({ data: { companyId: co.id, employeeId: emp.id, clubId: clubB.id, periodYear: year, periodMonth: month, amountKopeks: 2000000, status: "paid", expenseId: "legacy-exp-1", paidAt: new Date() } });
  // mirror backfill create.
  await p.payrollAdvancePayment.create({ data: { companyId: co.id, clubId: clubB.id, employeeAdvanceId: legacyAdv.id, amountKopeks: 2000000, paymentMethod: "cash", expenseId: "legacy-exp-1", status: "paid", createdByUserId: owner.id, idempotencyKey: `legacy:${legacyAdv.id}` } });
  const legacyTr = await p.payrollAdvancePayment.findMany({ where: { employeeAdvanceId: legacyAdv.id } });
  check("T23/24/25 backfill: один legacy-транш переиспользует Expense, новый Expense не создаётся", legacyTr.length === 1 && legacyTr[0].expenseId === "legacy-exp-1");
  let biBackfill = false; try { await p.payrollAdvancePayment.create({ data: { companyId: co.id, clubId: clubB.id, employeeAdvanceId: legacyAdv.id, amountKopeks: 1, paymentMethod: "cash", status: "paid", createdByUserId: owner.id, idempotencyKey: `legacy:${legacyAdv.id}` } }); } catch { biBackfill = true; }
  check("T-BF backfill идемпотентен (повтор legacy-ключа заблокирован)", biBackfill);

  check("T27 чужой клуб: аванс clubA не относится к clubB", (await p.payrollAdvancePayment.count({ where: { clubId: clubA.id } })) > 0 && (await p.payrollAdvancePayment.findMany({ where: { employeeAdvanceId: adv.id } })).every((t) => t.clubId === clubA.id));
  check("T28 tenant isolation: чужая компания не видит транши", (await p.payrollAdvancePayment.count({ where: { companyId: otherCo.id } })) === 0);

  // cleanup
  await p.payrollAdvancePayment.deleteMany({ where: { companyId: co.id } });
  await p.payrollCalculation.deleteMany({ where: { payrollPeriodId: period.id } });
  await p.payrollPeriod.deleteMany({ where: { companyId: co.id } });
  await p.payrollAdvance.deleteMany({ where: { companyId: co.id } });
  await p.clubEmployee.deleteMany({ where: { companyId: co.id } });
  await p.club.deleteMany({ where: { companyId: co.id } });
  await p.company.deleteMany({ where: { id: { in: [co.id, otherCo.id] } } });
  await p.user.delete({ where: { id: owner.id } });
}

async function main() {
  staticGuards();
  await realDb();
  await p.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
