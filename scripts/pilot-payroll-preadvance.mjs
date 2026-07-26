// Item 3 — аванс до утверждения периода. Проверяет: аванс в открытом текущем месяце до
// создания/утверждения PayrollPeriod; ручная база earnedToDate (комментарий + подтверждение
// регионала); авто-подхват периодом (аванс уменьшает remaining, без повторного расхода).
// npm run pilot:payroll-preadvance
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = (rub) => rub * 100;

// ---- mirror: advanceWithinEarned + aggregate paid ----
const within = (amt, earned) => Number.isFinite(amt) && amt > 0 && amt <= earned;
const aggregate = ({ automatic, advance, payments = 0 }) => {
  const gross = automatic, net = gross, paid = advance + payments, remaining = net - paid;
  return { paid, remaining, employeeDebt: remaining < 0 ? -remaining : 0, companyDebt: remaining > 0 ? remaining : 0 };
};

function main() {
  // 7 — аванс 25 числа до периода: сумма ≤ заработанной к дате (ручной базе)
  check("PRE1 advance within manual earned-to-date", within(R(25000), R(40000)) === true && within(R(45000), R(40000)) === false);
  // 8 — период создан → аванс подхватывается: начислено 50к, аванс 10к → remaining 40к
  const a8 = aggregate({ automatic: R(50000), advance: R(10000) });
  check("PRE2 advance auto-picked-up reduces remaining (50k − 10k = 40k)", a8.paid === R(10000) && a8.remaining === R(40000));
  // 9 — аванс не учитывается дважды: аванс 10к + выплата остатка 40к = paid 50к (каждый раз один)
  const a9 = aggregate({ automatic: R(50000), advance: R(10000), payments: R(40000) });
  check("PRE3 advance not double-counted (paid = 50k, remaining 0)", a9.paid === R(50000) && a9.remaining === 0);

  // ---- static guards ----
  const actions = src("../src/app/(app)/payroll/advance-actions.ts");
  const aggregateSrc = src("../src/lib/payroll/aggregate.ts");
  const schemaDev = src("../prisma/schema.prisma");
  const schemaProd = src("../prisma/production/schema.prisma");
  const mig = src("../prisma/production/migrations/20260724132000_payroll_advance_preperiod/migration.sql");
  const page = src("../src/app/(app)/payroll/employees/[id]/page.tsx");

  check("PRE4 pre-period advance: NO period/approval required (keyed by employee+club+month)",
    actions.includes("export async function recordEmployeeAdvance") && actions.includes("periodYear: year, periodMonth: month") && !actions.includes("PAYABLE_STATUSES"));
  check("PRE5 advance bound to employee, club, year/month, legalEntity, source, method",
    actions.includes("legalEntityId: le.legalEntityId") && actions.includes("source:") && actions.includes("paymentMethod: method") && actions.includes("periodYear: year"));
  check("PRE6 one advance per month (unique lookup before create)",
    actions.includes("Аванс за этот месяц уже оформлен"));
  check("PRE7 amount ≤ earned-to-date (auto from calc, else manual)",
    actions.includes("advanceWithinEarned(amountKopeks, earnedToDate)") && actions.includes("calc.netPayableKopeks") && actions.includes('earnedSource = "manual"'));
  check("PRE8 manual earned-to-date requires comment + regional approval (manager)",
    actions.includes("Ручная заработанная сумма требует комментарий") && actions.includes("needsRegionalApproval") && actions.includes("export async function approveEmployeeAdvance"));
  check("PRE9 month must be open (month-close guarded)",
    actions.includes("monthClosedError(companyId, clubId, firstDay)"));
  check("PRE10 advance is a salary expense (part of actual payout, one deduction)",
    actions.includes("createSalaryExpense") && actions.includes('kind: "advance"'));
  check("PRE11 auto-link on period create: aggregate counts month advances (active tranches), no repeat expense",
    aggregateSrc.includes("payrollAdvance.findMany") && aggregateSrc.includes("advancePaidKopeks") && actions.includes("recomputeCalculationTotals(calc.id)"));
  check("PRE12 tenant isolation: club access + employee scope checked server-side",
    actions.includes("ctx.allowedClubIds.includes(clubId)") && actions.includes("getEmployeeForScope") && actions.includes("canAccessClub"));
  check("PRE13 schema fields additive (dev+prod) + migration no DROP",
    schemaDev.includes("earnedToDateSource String?") && schemaProd.includes("earnedToDateSource String?") && /ADD COLUMN "earnedToDateSource"/.test(mig) && !/DROP/.test(mig));
  check("PRE14 UI: advance panel on the employee page (pre-period)",
    page.includes("EmployeeAdvancePanel"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
