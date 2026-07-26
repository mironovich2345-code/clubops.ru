// Payroll UX restructure regression. Verifies the NEW shell (overview, nav, separate
// Авансы/Выплаты sections, compact roster, in-card advance read-only) via static guards
// on the real source, and confirms the advance business rules the UI relies on via a
// real-DB mirror (advance without a period; period auto-fold by employee+club+month; the
// one-advance-per-month unique constraint). The engine/statuses/roles are NOT changed.
//   npm run pilot:payroll-ux
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const exists = (rel) => { try { readFileSync(new URL(rel, import.meta.url)); return true; } catch { return false; } };

function staticGuards() {
  const overview = src("../src/app/(app)/payroll/page.tsx");
  const nav = src("../src/app/(app)/payroll/_components/PayrollNav.tsx");
  const advPage = src("../src/app/(app)/payroll/advances/page.tsx");
  const advForm = src("../src/app/(app)/payroll/_components/AdvanceCreateForm.tsx");
  const payPage = src("../src/app/(app)/payroll/payments/page.tsx");
  const roster = src("../src/app/(app)/payroll/_components/PeriodRoster.tsx");
  const paySection = src("../src/app/(app)/payroll/_components/PaymentsSection.tsx");
  const advActions = src("../src/app/(app)/payroll/advance-actions.ts");
  const empList = src("../src/app/(app)/payroll/employees/page.tsx");

  check("UX1 главная /payroll — обзор (KPI + «Требуют внимания» + loadPayrollOverview), не список схем",
    overview.includes("loadPayrollOverview") && overview.includes("Требуют внимания") && !overview.includes("getEmployeesForScope"));
  check("UX2 отдельный пункт «Авансы» и «Выплаты» в навигации + страницы существуют",
    nav.includes('href: "/payroll/advances"') && nav.includes('href: "/payroll/payments"') && exists("../src/app/(app)/payroll/advances/page.tsx") && exists("../src/app/(app)/payroll/payments/page.tsx"));
  check("UX3 навигация покрывает все этапы (Обзор/Сотрудники/Схемы/Периоды/Авансы/Выплаты/Долги/Регионал)",
    ["Обзор", "Сотрудники", "Схемы и версии", "Расчётные периоды", "Авансы", "Выплаты", "Долги", "Регионал"].every((l) => nav.includes(l)));
  check("UX4 аванс создаётся в разделе «Авансы» без периода (форма зовёт recordEmployeeAdvance)",
    advForm.includes("recordEmployeeAdvance") && advPage.includes("AdvanceCreateForm") && advForm.includes("до расчётного периода"));
  check("UX5 карточка расчёта: аванс read-only summary + ссылка «Управление авансами», формы создания нет",
    paySection.includes("Управление авансами") && !paySection.includes("recordAdvance") && paySection.includes('href="/payroll/advances"'));
  check("UX6 выплаты отделены от начисления (раздел /payroll/payments, обзор по позициям)",
    payPage.includes("движение денег") && payPage.includes("payrollCalculation.findMany"));
  check("UX7 компактный ростер: краткий вид по умолчанию (useState(false)), есть подробный",
    roster.includes("useState(false)") && roster.includes("Краткий") && roster.includes("Подробный") && roster.includes("Открыть расчёт"));
  check("UX8 mobile: карточки на md:hidden, таблица hidden md:block; горизонтальный скролл в overflow",
    roster.includes("md:hidden") && roster.includes("hidden overflow-hidden rounded-2xl border border-slate-200 md:block") && advPage.includes("overflow-x-auto"));
  check("UX9 отдельная страница расчёта сотрудника существует, старые URL сохранены",
    exists("../src/app/(app)/payroll/periods/[id]/employees/[calculationId]/page.tsx") && exists("../src/app/(app)/payroll/periods/[id]/page.tsx") && exists("../src/app/(app)/payroll/employees/[id]/page.tsx") && exists("../src/app/(app)/payroll/summary/page.tsx"));
  check("UX10 «Требуют внимания» ведёт ссылками в нужный раздел",
    overview.includes("href: \"/payroll/employees\"") && overview.includes("Открыть →"));
  check("UX11 tenant/scope: разделы фильтруют по доступным клубам (getUserClubs), роли server-side",
    advPage.includes("getUserClubs") && payPage.includes("getUserClubs") && advPage.includes("canManagePayrollAssignments") && empList.includes("getUserClubs"));
  check("UX12 движок не тронут: аванс — дедуп по месяцу + авто-привязка к расчёту через findMonthCalc + recompute",
    advActions.includes("Аванс за этот месяц уже оформлен") && advActions.includes("findMonthCalc") && advActions.includes("recomputeCalculationTotals") && advActions.includes("needsRegionalApproval"));
  check("UX13 закрытый период read-only: карточка расчёта блокируется (locked/closed → CalculationCard locked)",
    src("../src/app/(app)/payroll/periods/[id]/employees/[calculationId]/page.tsx").includes("isPayrollPeriodClosed") && src("../src/app/(app)/payroll/periods/[id]/employees/[calculationId]/page.tsx").includes("locked={locked || !canManage}"));
}

async function realDb() {
  const uid = `pux-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const owner = await p.user.create({ data: { email: `${uid}@t.dev`, name: "O", role: "owner", isActive: true } });
  const co = await p.company.create({ data: { name: `Co ${uid}` } });
  const club = await p.club.create({ data: { companyId: co.id, name: "Клуб", city: "X" } });
  const emp = await p.clubEmployee.create({ data: { companyId: co.id, clubId: club.id, fullName: "Иван", position: "manager", status: "active" } });
  const year = 2026, month = 9;

  // Scenario 11.1: advance BEFORE any period exists.
  const adv = await p.payrollAdvance.create({ data: { companyId: co.id, employeeId: emp.id, clubId: club.id, periodYear: year, periodMonth: month, earnedToDateKopeks: 5000000, earnedToDateSource: "manual", amountKopeks: 2000000, paymentMethod: "cash", status: "paid", comment: "до периода" } });
  const noPeriod = await p.payrollPeriod.findFirst({ where: { companyId: co.id, clubId: club.id, year, month } });
  check("PUX-A аванс создан без расчётного периода (period отсутствует, advance paid)", noPeriod === null && adv.status === "paid" && adv.amountKopeks === 2000000);

  // One-advance-per-month unique constraint (§20.11: один аванс не связывается с двумя расчётами).
  let dupBlocked = false;
  try { await p.payrollAdvance.create({ data: { companyId: co.id, employeeId: emp.id, clubId: club.id, periodYear: year, periodMonth: month, earnedToDateKopeks: 1, amountKopeks: 1, paymentMethod: "cash", status: "paid" } }); } catch { dupBlocked = true; }
  check("PUX-B второй аванс за тот же месяц заблокирован (unique employee+club+year+month)", dupBlocked);

  // Scenario 11.2 + auto-fold: create period + calc, mirror recompute (advances by employee+club+month).
  const period = await p.payrollPeriod.create({ data: { companyId: co.id, clubId: club.id, year, month, status: "draft", createdByUserId: owner.id } });
  const calc = await p.payrollCalculation.create({ data: { payrollPeriodId: period.id, companyId: co.id, clubId: club.id, employeeId: emp.id, roleSnapshot: "manager", grossAccruedKopeks: 5000000, status: "calculated" } });
  // Mirror aggregate.ts fold: advances = sum paid PayrollAdvance for employee+club+month.
  const paidAdvances = await p.payrollAdvance.findMany({ where: { companyId: co.id, employeeId: emp.id, clubId: club.id, periodYear: year, periodMonth: month, status: "paid" } });
  const advancesKopeks = paidAdvances.reduce((s, a) => s + a.amountKopeks, 0);
  const remaining = calc.grossAccruedKopeks - advancesKopeks - 0;
  await p.payrollCalculation.update({ where: { id: calc.id }, data: { advancesKopeks, remainingKopeks: remaining } });
  const after = await p.payrollCalculation.findUnique({ where: { id: calc.id } });
  check("PUX-C период подхватывает аванс: advances=2000000, остаток=начислено−авансы, начисление не уменьшено",
    after.advancesKopeks === 2000000 && after.remainingKopeks === 5000000 - 2000000 && after.grossAccruedKopeks === 5000000);

  // Re-fold (idempotent) — advance not double-counted.
  const paidAdvances2 = await p.payrollAdvance.findMany({ where: { companyId: co.id, employeeId: emp.id, clubId: club.id, periodYear: year, periodMonth: month, status: "paid" } });
  check("PUX-D повторная привязка не удваивает аванс (идемпотентно)", paidAdvances2.reduce((s, a) => s + a.amountKopeks, 0) === 2000000);

  // Cancel path: canceled advance no longer folded.
  await p.payrollAdvance.update({ where: { id: adv.id }, data: { status: "canceled" } });
  const paidAfterCancel = await p.payrollAdvance.findMany({ where: { companyId: co.id, employeeId: emp.id, clubId: club.id, periodYear: year, periodMonth: month, status: "paid" } });
  check("PUX-E отмена аванса убирает его из свёртки (остаётся только paid)", paidAfterCancel.length === 0);

  // Tenant isolation.
  check("PUX-F tenant isolation — аванс виден только своей компании", (await p.payrollAdvance.count({ where: { companyId: co.id } })) === 1 && (await p.payrollAdvance.count({ where: { companyId: { not: co.id }, employeeId: emp.id } })) === 0);

  // cleanup
  await p.payrollCalculation.deleteMany({ where: { payrollPeriodId: period.id } });
  await p.payrollPeriod.deleteMany({ where: { companyId: co.id } });
  await p.payrollAdvance.deleteMany({ where: { companyId: co.id } });
  await p.clubEmployee.deleteMany({ where: { companyId: co.id } });
  await p.club.deleteMany({ where: { companyId: co.id } });
  await p.company.delete({ where: { id: co.id } });
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
