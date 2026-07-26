// READ-ONLY audit of legacy advances before the tranche backfill. Prints COUNTS ONLY —
// no ФИО / no amounts per person / no secrets. Safe for production logs.
//   DATABASE_URL="postgresql://…" node scripts/payroll-advance-audit.mjs
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const advances = await p.payrollAdvance.findMany({ select: { id: true, status: true, amountKopeks: true, expenseId: true, approvedAmountKopeks: true } });
const tranches = await p.payrollAdvancePayment.findMany({ select: { employeeAdvanceId: true } });
const hasTranche = new Set(tranches.map((t) => t.employeeAdvanceId));

let paid = 0, unpaid = 0, withExpense = 0, withCashMovement = 0, ambiguous = 0, forecastLegacyTranches = 0, alreadyMigrated = 0, needsManual = 0;
for (const a of advances) {
  const isPaid = a.status === "paid";
  if (isPaid) paid++; else unpaid++;
  if (a.expenseId) withExpense++;
  if (hasTranche.has(a.id)) { alreadyMigrated++; continue; }
  if (isPaid) {
    if (a.expenseId) {
      const cm = await p.cashMovement.count({ where: { sourceType: "expense", sourceId: a.expenseId } });
      if (cm > 0) withCashMovement++;
      forecastLegacyTranches++;
    } else {
      ambiguous++; needsManual++; // paid without a linked expense — cannot rebuild the link safely
    }
  }
}

console.log("=== Payroll advance audit (read-only, counts only) ===");
console.log(JSON.stringify({
  totalAdvances: advances.length,
  paid, unpaid,
  withExpense,
  withCashMovement,
  alreadyMigratedToTranche: alreadyMigrated,
  forecastLegacyTranchesToCreate: forecastLegacyTranches,
  ambiguousPaidWithoutExpense: ambiguous,
  needsManualReview: needsManual,
}, null, 2));
console.log(needsManual > 0 ? `\n⚠ ${needsManual} записей требуют ручной проверки (paid без expenseId) — backfill их пропустит.` : "\nОднозначных проблем не обнаружено.");

await p.$disconnect();
