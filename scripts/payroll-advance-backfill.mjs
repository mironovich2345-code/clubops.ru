// Backfill legacy advances into the tranche model. DRY-RUN by default; pass --apply to
// write. IDEMPOTENT (idempotencyKey = "legacy:<advanceId>"; re-running is a no-op). For
// each PAID advance with NO tranche yet it creates ONE legacy tranche REUSING the existing
// Expense + CashMovement — it NEVER creates a new Expense or a new cash movement — and
// sets requested/approved = amountKopeks. Ambiguous rows (paid without an expense) are
// SKIPPED for manual review, never guessed. Counts only in logs (no ФИО/secrets).
//   DATABASE_URL="postgresql://…" node scripts/payroll-advance-backfill.mjs            # dry-run
//   DATABASE_URL="postgresql://…" node scripts/payroll-advance-backfill.mjs --apply    # execute
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const p = new PrismaClient();
console.log(`=== Payroll advance backfill (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);

const advances = await p.payrollAdvance.findMany();
const existing = new Set((await p.payrollAdvancePayment.findMany({ select: { employeeAdvanceId: true } })).map((t) => t.employeeAdvanceId));

let planned = 0, created = 0, skippedAmbiguous = 0, alreadyDone = 0, amountsSet = 0;
for (const a of advances) {
  // Populate requested/approved from the legacy amount (safe on any status).
  if (a.approvedAmountKopeks == null || a.requestedAmountKopeks == null) {
    amountsSet++;
    if (APPLY) await p.payrollAdvance.update({ where: { id: a.id }, data: { requestedAmountKopeks: a.requestedAmountKopeks ?? a.amountKopeks, approvedAmountKopeks: a.approvedAmountKopeks ?? a.amountKopeks } });
  }
  if (a.status !== "paid") continue;
  if (existing.has(a.id)) { alreadyDone++; continue; }
  if (!a.expenseId) { skippedAmbiguous++; continue; } // paid without expense → manual review
  planned++;
  const cm = await p.cashMovement.findFirst({ where: { sourceType: "expense", sourceId: a.expenseId }, select: { id: true } });
  if (APPLY) {
    await p.payrollAdvancePayment.create({
      data: {
        companyId: a.companyId, clubId: a.clubId, employeeAdvanceId: a.id, amountKopeks: a.amountKopeks,
        paidAt: a.paidAt ?? a.createdAt, paymentMethod: a.paymentMethod ?? "cash", legalEntityId: a.legalEntityId ?? null,
        cashSource: a.cashSource ?? null, expenseId: a.expenseId, cashMovementId: cm?.id ?? null, status: "paid",
        createdByUserId: a.paidByUserId ?? a.approvedByUserId ?? a.companyId, approvedByUserId: a.approvedByUserId ?? null,
        idempotencyKey: `legacy:${a.id}`,
      },
    }).then(() => { created++; }).catch((e) => { if (/Unique|P2002/.test(String(e?.message))) alreadyDone++; else throw e; });
  }
}

console.log(JSON.stringify({ totalAdvances: advances.length, amountsBackfilled: amountsSet, legacyTranchesPlanned: planned, legacyTranchesCreated: APPLY ? created : 0, alreadyMigrated: alreadyDone, skippedAmbiguous }, null, 2));
console.log(skippedAmbiguous > 0 ? `\n⚠ ${skippedAmbiguous} paid-авансов без expenseId пропущено (ручная проверка).` : "");
console.log(APPLY ? "Готово." : "Dry-run. Запустите с --apply для записи. Новый Expense/движение кассы НЕ создаются.");

await p.$disconnect();
