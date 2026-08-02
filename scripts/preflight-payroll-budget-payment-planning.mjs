// READ-ONLY preflight for the Payroll → Salary Budget → Payment Planning rollout (spec §30).
// Reports data that needs attention; it changes NOTHING. Safe to run any time.
//   node scripts/preflight-payroll-budget-payment-planning.mjs
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const APPROVED = new Set(["approved", "partially_paid", "paid", "closed"]);

async function main() {
  let problems = 0;
  const flag = (n) => { if (n > 0) problems += 1; };

  // 1) Approved calculations missing a legalEntityId (obligation can't be scoped to an entity).
  const noLE = await prisma.payrollCalculation.count({ where: { legalEntityId: null, status: { in: ["approved", "paid", "closed"] } } });
  console.log(`[1] Утверждённые расчёты без юрлица: ${noLE}`);
  flag(noLE);

  // 2) Periods marked approved+ but with no year/month (can't resolve a due date).
  const periods = await prisma.payrollPeriod.findMany({ select: { id: true, status: true, year: true, month: true, clubId: true } });
  const badDate = periods.filter((p) => APPROVED.has(p.status) && (!p.year || !p.month || p.month < 1 || p.month > 12));
  console.log(`[2] Утверждённые периоды без корректного года/месяца: ${badDate.length}`);
  badDate.forEach((p) => console.log(`    ${p.id} · ${p.year}-${p.month}`));
  flag(badDate.length);

  // 3) Duplicate obligations on one idempotencyKey (unique constraint should prevent — verify).
  const obligations = await prisma.payrollPaymentObligation.findMany({ select: { id: true, idempotencyKey: true, amountKopeks: true, paidKopeks: true, remainingKopeks: true, status: true, dueDate: true, legalEntityId: true } });
  const keySeen = new Map();
  const dupKeys = [];
  for (const o of obligations) {
    if (keySeen.has(o.idempotencyKey)) dupKeys.push(o.idempotencyKey);
    else keySeen.set(o.idempotencyKey, o.id);
  }
  console.log(`[3] Дублирующиеся obligation по idempotencyKey: ${dupKeys.length}`);
  flag(dupKeys.length);

  // 4) Obligations where paid > amount (overpayment must surface as debt, not a negative obligation).
  const overpaid = obligations.filter((o) => o.paidKopeks > o.amountKopeks);
  console.log(`[4] Obligation с выплатой больше суммы: ${overpaid.length}`);
  overpaid.forEach((o) => console.log(`    ${o.id} · paid=${o.paidKopeks} > amount=${o.amountKopeks}`));
  flag(overpaid.length);

  // 5) Negative remaining (must be clamped ≥ 0).
  const negRemain = obligations.filter((o) => o.remainingKopeks < 0);
  console.log(`[5] Obligation с отрицательным остатком: ${negRemain.length}`);
  flag(negRemain.length);

  // 6) Non-cancelled, still-owed obligations without a due date (won't reach the calendar).
  const noDue = obligations.filter((o) => o.status !== "cancelled" && o.remainingKopeks > 0 && o.dueDate == null);
  console.log(`[6] Активные obligation без даты (нет графика выплат): ${noDue.length}`);
  flag(noDue.length);

  // 7) Obligations whose legalEntity no longer exists.
  const leIds = [...new Set(obligations.map((o) => o.legalEntityId).filter(Boolean))];
  const les = leIds.length ? await prisma.legalEntity.findMany({ where: { id: { in: leIds } }, select: { id: true } }) : [];
  const leSet = new Set(les.map((e) => e.id));
  const orphanLE = obligations.filter((o) => o.legalEntityId && !leSet.has(o.legalEntityId));
  console.log(`[7] Obligation без существующего юрлица: ${orphanLE.length}`);
  flag(orphanLE.length);

  // 8) Approved periods with NO obligations at all (backfill candidates).
  const oblPeriodIds = new Set(obligations.map(() => null)); // placeholder; recomputed below
  const withObl = new Set((await prisma.payrollPaymentObligation.findMany({ select: { payrollPeriodId: true } })).map((o) => o.payrollPeriodId));
  const approvedNoObl = periods.filter((p) => APPROVED.has(p.status) && !withObl.has(p.id));
  console.log(`[8] Утверждённые периоды без obligation (кандидаты на backfill): ${approvedNoObl.length}`);
  void oblPeriodIds;
  // Not a hard error — informational (backfill --apply will create them).

  // 9) Pending budget-change proposals (informational — awaiting owner/GD).
  const pendingProposals = await prisma.budgetChangeProposal.count({ where: { status: "pending" } });
  console.log(`[9] Ожидающие предложения по бюджету ЗП: ${pendingProposals}`);

  // 10) Companies with an advance/final day set but no timezone (informational).
  const companies = await prisma.company.findMany({ select: { id: true, name: true, payrollFinalDay: true, salaryBudgetSyncMode: true } });
  const autoSync = companies.filter((c) => c.salaryBudgetSyncMode === "auto_sync");
  console.log(`[10] Компаний с auto_sync (бюджет меняется автоматически): ${autoSync.length}`);
  autoSync.forEach((c) => console.log(`    ${c.name}`));

  console.log(`\nИтог: ${problems === 0 ? "проблем не найдено ✅" : `требуют внимания разделов: ${problems}`}`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
