// Item 4 — единый расчёт регионала по городу. Мирроринг accrual/totals/paidByClub +
// статические гарантии: одно начисление на город+месяц; выплаты частями из клубов;
// запрет переплаты без явного долга; нет отдельного полного начисления на каждом клубе.
// npm run pilot:payroll-regional
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = (rub) => rub * 100;
const ceilRub = (k) => Math.ceil(k / 100) * 100;

// ---- mirror: regional.ts ----
const accrual = (base, bp) => ceilRub(Math.round((Math.max(0, base) * Math.max(0, bp)) / 10000));
function totals(accrued, payments) {
  const paid = payments.reduce((s, p) => s + p.amountKopeks, 0);
  const remaining = accrued - paid;
  return { paid, remaining, overpay: remaining < 0 ? -remaining : 0 };
}
function byClub(payments) {
  const m = new Map();
  for (const p of payments) m.set(p.clubId, (m.get(p.clubId) ?? 0) + p.amountKopeks);
  return m;
}

function main() {
  // 13 — единое начисление по городу: база (выручка) 1 000 000 × 8% = 80 000, ОДНО на город+месяц
  const acc = accrual(R(1000000), 800);
  check("REG1 single city accrual = base × percent (80 000)", acc === R(80000));
  // 14 — выплаты регионала из двух клубов: A 30 000 + B 20 000 = 50 000, касса каждого клуба на свою часть
  const pays = [{ clubId: "A", amountKopeks: R(30000) }, { clubId: "B", amountKopeks: R(20000) }];
  const t = totals(acc, pays);
  check("REG2 part-payments from two clubs sum, remaining correct", t.paid === R(50000) && t.remaining === R(30000));
  const bc = byClub(pays);
  check("REG3 per-club breakdown (A 30k, B 20k)", bc.get("A") === R(30000) && bc.get("B") === R(20000));
  // 15 — запрет превышения начисления без явного долга
  const over = totals(acc, [{ clubId: "A", amountKopeks: R(90000) }]);
  check("REG4 overpay detected (90k > 80k → overpay 10k)", over.overpay === R(10000));

  // ---- static guards ----
  const actions = src("../src/app/(app)/payroll/regional/actions.ts");
  const lib = src("../src/lib/payroll/regional.ts");
  const page = src("../src/app/(app)/payroll/regional/page.tsx");
  const schemaDev = src("../prisma/schema.prisma");
  const schemaProd = src("../prisma/production/schema.prisma");
  const mig = src("../prisma/production/migrations/20260724133000_regional_city_payroll/migration.sql");

  check("REG5 ONE accrual per city+month (unique) — no full accrual per club",
    schemaDev.includes("@@unique([companyId, city, year, month])") && actions.includes("companyId_city_year_month"));
  check("REG6 base is revenue OR profit; % approved by owner",
    lib.includes('"revenue"') && lib.includes('"profit"') && actions.includes("userHasCompanyRole(ctx.user.id, row.companyId, [\"owner\"])") && actions.includes('status: "approved"'));
  check("REG7 payments allowed only after owner approval",
    actions.includes("Выплата возможна только после утверждения собственником"));
  check("REG8 each payment: source-club (of the city) + legalEntity + method + amount",
    actions.includes("club.city !== row.city") && actions.includes("legalEntityId") && actions.includes("paymentMethod: method") && actions.includes("clubId,"));
  check("REG9 overpay FORBIDDEN without an explicit overpayment debt",
    actions.includes("Суммарная выплата превышает начисление") && actions.includes("allowOverpayment") && actions.includes('direction: "employee_owes_company"'));
  check("REG10 each payment is a salary expense from the SOURCE club (cash reduced once)",
    actions.includes("createSalaryExpense") && actions.includes("clubId, legalEntityId, method"));
  check("REG11 shows accrued / per-club paid / total / remaining / overpay",
    page.includes("Начислено") && page.includes("Выплачено по клубам") && page.includes("переплата"));
  check("REG12 tenant isolation: city + club access server-side",
    actions.includes("scopeCityClubs") && actions.includes("ctx.allowedClubIds.includes(clubId)") && actions.includes("canAccessClub"));
  check("REG13 models additive dev+prod; migration no DROP",
    schemaDev.includes("model RegionalCityPayroll") && schemaProd.includes("model RegionalCityPayment") && /CREATE TABLE "RegionalCityPayroll"/.test(mig) && !/DROP TABLE|DROP COLUMN/.test(mig));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
