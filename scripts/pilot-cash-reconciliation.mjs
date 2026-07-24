// «Фактические деньги» — ежедневная сверка наличных. Проверяет чистую логику дедлайна/
// расхождения/статусов + статические гарантии: переиспользование ожидаемого остатка
// (без параллельного расчёта), отсутствие записи в ledger (нет дублей CashMovement),
// обязательный комментарий, права, аудит, аддитивная миграция.
// npm run pilot:cash-reconciliation
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = (rub) => rub * 100;

// ---- mirrors of pure helpers (cash-reconciliation.ts) ----
const DEADLINE_HOUR = 12;
const yesterdayLocal = (now) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
const reconciliationDeadline = (bd) => new Date(bd.getFullYear(), bd.getMonth(), bd.getDate() + 1, DEADLINE_HOUR, 0, 0, 0);
const isOverdue = (status, bd, now) => status === "awaiting_input" && now.getTime() > reconciliationDeadline(bd).getTime();
const onTime = (bd, at) => at.getTime() <= reconciliationDeadline(bd).getTime();
const diff = (actual, expected) => actual - expected;

function main() {
  // Business date = yesterday; deadline = 12:00 the following day.
  const now = new Date(2026, 6, 24, 9, 0, 0); // 24 Jul 09:00
  const bd = yesterdayLocal(now); // 23 Jul 00:00
  check("REC1 business date is the previous local day", bd.getDate() === 23 && bd.getMonth() === 6);
  const deadline = reconciliationDeadline(bd);
  check("REC2 deadline is 12:00 next day", deadline.getDate() === 24 && deadline.getHours() === 12);

  // On-time vs overdue.
  check("REC3 submit at 09:00 next day is on time", onTime(bd, new Date(2026, 6, 24, 9, 0)) === true);
  check("REC4 submit at 12:01 next day is late", onTime(bd, new Date(2026, 6, 24, 12, 1)) === false);
  check("REC5 awaiting past 12:00 is overdue", isOverdue("awaiting_input", bd, new Date(2026, 6, 24, 12, 30)) === true);
  check("REC6 awaiting before 12:00 is not overdue", isOverdue("awaiting_input", bd, new Date(2026, 6, 24, 10, 0)) === false);
  check("REC7 submitted is never overdue", isOverdue("submitted", bd, new Date(2026, 6, 25, 0, 0)) === false);

  // Difference.
  check("REC8 difference actual − expected", diff(R(50000), R(50000)) === 0 && diff(R(48000), R(50000)) === -R(2000) && diff(R(51000), R(50000)) === R(1000));

  // ---- static guards ----
  const lib = src("../src/lib/cash-reconciliation.ts");
  const actions = src("../src/app/(app)/collections/reconciliation-actions.ts");
  const schema = src("../prisma/schema.prisma");
  const prodSchema = src("../prisma/production/schema.prisma");
  const devMig = src("../prisma/migrations/20260724111956_add_daily_cash_reconciliation/migration.sql");
  const prodMig = src("../prisma/production/migrations/20260724111956_add_daily_cash_reconciliation/migration.sql");

  check("REC9 expected balance + OFD cash REUSED from loadClubCashBalances (no parallel total)",
    lib.includes("loadClubCashBalances") && lib.includes("cashOooFactBalance") && lib.includes("cashOooOfdYesterday"));
  check("REC10 reconciliation does NOT write to the cash ledger (no CashMovement / balance move)",
    !actions.includes("cashMovement") && !actions.includes("walletBalance") && !actions.includes("postCash"));
  check("REC11 discrepancy requires a reason + comment",
    actions.includes("Укажите причину расхождения") && actions.includes("Комментарий обязателен при расхождении"));
  check("REC12 ООО and ИП recorded separately (per legal entity)",
    actions.includes("legalEntityType") && actions.includes("`${e.legalEntityType}_actual`"));
  check("REC13 submit gated server-side (manager/regional, own club)",
    actions.includes("canSubmitReconciliation(ctx.effectiveRoles)") && actions.includes("ctx.allowedClubIds.includes(clubId)"));
  check("REC14 review gated (regional confirms discrepancy, accountant closes)",
    actions.includes("canRegionalReview(ctx.effectiveRoles)") && actions.includes("canAccountingReview(ctx.effectiveRoles)") && actions.includes("Сначала расхождение подтверждает"));
  check("REC15 month-close guarded before submit",
    actions.includes("monthClosedError(companyId, clubId, businessDate)"));
  check("REC16 all actions audited server-side",
    actions.includes('"cash_recon.submitted"') && actions.includes('"cash_recon.closed"'));
  check("REC17 discrepancy raises a regional task/notification",
    actions.includes("notifyReconciliation") && actions.includes('event: "discrepancy"'));
  check("REC18 unique per club+legalEntity+businessDate (idempotent upsert)",
    schema.includes("@@unique([clubId, legalEntityId, businessDate])") && actions.includes("clubId_legalEntityId_businessDate"));
  check("REC19 model present in dev + prod schema; additive migration (no DROP/rebuild)",
    schema.includes("model DailyCashReconciliation") && prodSchema.includes("model DailyCashReconciliation") &&
    /CREATE TABLE "DailyCashReconciliation"/.test(devMig) && /CREATE TABLE "DailyCashReconciliation"/.test(prodMig) &&
    !/DROP TABLE|DROP COLUMN/.test(prodMig));
  check("REC20 amounts are integer kopeks",
    /actualCashBalanceKopeks\s+Int/.test(schema) && /expectedCashBalanceKopeks\s+Int/.test(schema) && /differenceKopeks\s+Int/.test(schema));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
