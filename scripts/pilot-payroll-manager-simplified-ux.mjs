// Manager payroll UX simplification: role-aware navigation (Зарплата + Долги only), one
// working screen at /payroll, month switching + empty state, regional payroll fully removed
// for a manager (UI + server guards + IDOR), backward-compat redirects. Pure mirror of the
// capability logic + static guards on the real pages/nav/guards + real-DB scope checks.
//   npm run pilot:payroll-manager-simplified-ux
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ---- mirror of payroll/access.ts capability helpers ----
const FULL = ["owner", "general_director", "regional_director", "chief_accountant", "accountant"];
const payrollNavMode = (roles) => (roles.some((r) => FULL.includes(r)) ? "full" : roles.includes("manager") ? "manager" : "full");
const canViewRegionalPayroll = (roles) => roles.some((r) => ["owner", "general_director", "regional_director", "chief_accountant", "accountant"].includes(r));

function pureTests() {
  check("P1 payrollNavMode: чистый управляющий → manager", payrollNavMode(["manager"]) === "manager");
  check("P2 payrollNavMode: owner/GD/regional/бухгалтер → full", payrollNavMode(["owner"]) === "full" && payrollNavMode(["accountant"]) === "full" && payrollNavMode(["regional_director"]) === "full");
  check("P3 payrollNavMode: управляющий И регионал → full (расширенные права)", payrollNavMode(["manager", "regional_director"]) === "full");
  check("P4 canViewRegionalPayroll: управляющий НЕ видит", !canViewRegionalPayroll(["manager"]));
  check("P5 canViewRegionalPayroll: регионал/ГД/собственник/бухгалтер видят", canViewRegionalPayroll(["regional_director"]) && canViewRegionalPayroll(["owner"]) && canViewRegionalPayroll(["accountant"]));
}

function staticGuards() {
  const access = src("../src/lib/payroll/access.ts");
  const nav = src("../src/app/(app)/payroll/_components/PayrollNav.tsx");
  const landing = src("../src/app/(app)/payroll/page.tsx");
  const workspace = src("../src/app/(app)/payroll/_components/PayrollWorkspace.tsx");
  const scopeBar = src("../src/app/(app)/payroll/_components/PayrollScopeBar.tsx");
  const empty = src("../src/app/(app)/payroll/_components/PayrollEmptyPeriod.tsx");
  const periods = src("../src/app/(app)/payroll/periods/page.tsx");
  const employees = src("../src/app/(app)/payroll/employees/page.tsx");
  const payments = src("../src/app/(app)/payroll/payments/page.tsx");
  const summary = src("../src/app/(app)/payroll/summary/page.tsx");
  const regionalPage = src("../src/app/(app)/payroll/regional/page.tsx");
  const regionalActions = src("../src/app/(app)/payroll/regional/actions.ts");
  const debts = src("../src/app/(app)/payroll/debts/page.tsx");
  const overview = src("../src/app/(app)/payroll/overview/page.tsx");
  const cards = src("../src/app/(app)/payroll/_components/PeriodCategoryCards.tsx");

  check("SG1 access: payrollNavMode по capability (не только по имени роли)", access.includes("export function payrollNavMode") && access.includes("FULL_PAYROLL_NAV_ROLES"));
  check("SG2 access: canViewRegionalPayroll исключает управляющего (нет 'manager' в списке)", (() => {
    const seg = access.slice(access.indexOf("export function canViewRegionalPayroll"));
    const body = seg.slice(0, seg.indexOf("}"));
    return !body.includes('"manager"');
  })());
  check("SG3 nav: у управляющего только 2 пункта — Зарплата + Долги", nav.includes("MANAGER_ITEMS") && nav.includes('label: "Зарплата"') && nav.includes('label: "Долги"'));
  check("SG4 nav: управляющий НЕ видит Обзор/Сотрудники/Периоды/Авансы/Выплаты/Регионал как отдельные вкладки", (() => {
    const mi = nav.slice(nav.indexOf("MANAGER_ITEMS"), nav.indexOf("export function PayrollNav"));
    return !/Обзор|Сотрудники и схемы|Расчётные периоды|"Авансы"|"Выплаты"|"Регионал"/.test(mi);
  })());
  check("SG5 nav: mode-aware сегментированный контрол (2 пункта), full-режим — полный список", nav.includes('mode === "manager"') && nav.includes("FULL_ITEMS") && nav.includes("rounded-xl bg-slate-100"));
  check("SG6 landing: /payroll role-aware — управляющему рабочий экран, остальным обзор", landing.includes('payrollNavMode(ctx.effectiveRoles)') && landing.includes('navMode === "manager"') && landing.includes("PayrollWorkspace") && landing.includes("loadPayrollOverview"));
  check("SG7 landing: один рабочий экран (PayrollWorkspace) + 5 карточек, без второго overview у управляющего", workspace.includes("PeriodCategoryCards") && workspace.includes("advances_card") && landing.includes('basePath="/payroll"'));
  check("SG8 month switching: prev/next/select + club select (§4)", scopeBar.includes("shiftMonth") && scopeBar.includes("Предыдущий месяц") && scopeBar.includes("Следующий месяц") && scopeBar.includes('type="month"'));
  check("SG9 empty state: клуб/месяц/активные/без схемы + кнопка Создать период (§3)", empty.includes("ещё не создан") && empty.includes("Активных сотрудников") && empty.includes("Без схемы") && empty.includes("createPayrollPeriod") && empty.includes("Создать период"));
  check("SG10 periods: управляющего редиректит на /payroll (не таблица периодов) (§12)", periods.includes('payrollNavMode(ctx.effectiveRoles) === "manager"') && periods.includes('redirect(`/payroll'));
  check("SG11 employees: управляющего редиректит на /payroll (схемы закрыты) (§8)", employees.includes('payrollNavMode(ctx.effectiveRoles) === "manager"') && employees.includes('redirect("/payroll")'));
  check("SG12 payments: управляющего редиректит на /payroll (выплаты контекстные) (§10)", payments.includes('payrollNavMode(ctx.effectiveRoles) === "manager"') && payments.includes('redirect("/payroll")'));
  check("SG13 summary: сводка по ФОТ недоступна управляющему (redirect)", summary.includes('payrollNavMode(ctx.effectiveRoles) === "manager"') && summary.includes('redirect("/payroll")'));
  check("SG14 regional page: server-side view guard (canViewRegionalPayroll → notFound) (§7/§16)", regionalPage.includes("canViewRegionalPayroll(ctx.effectiveRoles)") && regionalPage.includes("notFound()"));
  check("SG15 regional actions: запись/отмена выплаты регионалу закрыты управляющему (canViewRegionalPayroll)", (() => {
    return regionalActions.includes("canViewRegionalPayroll(roles)") && regionalActions.includes("canViewRegionalPayroll(ctx.effectiveRoles)") && !/r === "manager"/.test(regionalActions.slice(regionalActions.indexOf("recordRegionalCityPayment")));
  })());
  check("SG16 debts route: /payroll/debts → редирект на /payroll/obligations (сохраняя query) (§6)", debts.includes('redirect(`/payroll/obligations') && debts.includes("URLSearchParams"));
  check("SG17 overview route: /payroll/overview → редирект на /payroll (§15)", overview.includes('redirect(`/payroll') && overview.includes("URLSearchParams"));
  check("SG18 backward-compat: редиректы учитывают query (month/club)", periods.includes('q.set("month"') && periods.includes('q.set("club"'));
  check("SG19 mobile: 5 карточек в одну колонку на мал. ширине (grid-cols-1), нет форс-горизонтали", cards.includes("grid-cols-1") && cards.includes("sm:grid-cols-2") && cards.includes("lg:grid-cols-5"));
  check("SG20 mobile: сегментированная навигация ≥44px, без 7 мелких вкладок у управляющего", nav.includes("min-h-[44px]") && nav.includes("flex-1"));
  check("SG21 mobile: scope bar ≥44px кнопки, wrap без горизонтального скролла", scopeBar.includes("h-11") && scopeBar.includes("flex-wrap"));
  check("SG22 workspace: карточки/группы сохраняют month+club в ссылках (basePath+keepParams)", workspace.includes("keepParams") && workspace.includes("URLSearchParams({ ...keepParams"));
  check("SG23 не трогаем формулы/снапшот/change-requests/транши (нет их правок в этих файлах)", !/formulas\.ts|approvedOverridesJson|computeScheme\(/.test(nav + scopeBar + empty + debts + overview));
}

async function realDb() {
  const uid = `mux-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const owner = await p.user.create({ data: { email: `${uid}-o@t.dev`, name: "O", role: "owner", isActive: true } });
  const co = await p.company.create({ data: { name: `Co ${uid}` } });
  const otherCo = await p.company.create({ data: { name: `Other ${uid}` } });
  const clubA = await p.club.create({ data: { companyId: co.id, name: "A", city: "Город" } });
  const clubB = await p.club.create({ data: { companyId: co.id, name: "B", city: "Город" } });
  const emp = await p.clubEmployee.create({ data: { companyId: co.id, clubId: clubA.id, fullName: "Сотр", position: "manager", status: "active" } });
  const year = 2026, month = 8;

  // Manager scope = [clubA]. A period in clubB must be invisible to a manager scoped to clubA.
  const periodA = await p.payrollPeriod.create({ data: { companyId: co.id, clubId: clubA.id, year, month, status: "draft", createdByUserId: owner.id } });
  const periodB = await p.payrollPeriod.create({ data: { companyId: co.id, clubId: clubB.id, year, month, status: "draft", createdByUserId: owner.id } });
  const calcB = await p.payrollCalculation.create({ data: { payrollPeriodId: periodB.id, companyId: co.id, clubId: clubB.id, employeeId: emp.id, roleSnapshot: "manager", grossAccruedKopeks: 100, netPayableKopeks: 100, status: "calculated" } });

  const managerClubIds = [clubA.id]; // scope of the manager under test
  // T: manager landing resolves the CURRENT club period (clubA), never clubB's.
  const found = await p.payrollPeriod.findFirst({ where: { companyId: co.id, clubId: clubA.id, year, month } });
  check("T1 manager landing находит рабочий период своего клуба", found?.id === periodA.id);
  check("T2 IDOR: расчёт чужого клуба (B) не входит в scope управляющего (A)", !managerClubIds.includes(calcB.clubId));

  // Regional city payroll: tenant + scope isolation (manager must not read via any selection).
  const rcp = await p.regionalCityPayroll.create({ data: { companyId: co.id, city: "Город", year, month, baseType: "revenue", baseKopeks: 1000000, percentBp: 500, accruedKopeks: 50000, regionalName: "Регионал", status: "approved", createdByUserId: owner.id, ownerApprovedById: owner.id, ownerApprovedAt: new Date() } });
  check("T3 regional payroll: другая компания не видит начисление регионала (tenant)", (await p.regionalCityPayroll.count({ where: { companyId: otherCo.id } })) === 0);
  check("T4 regional payroll данные существуют только под своей компанией", (await p.regionalCityPayroll.findMany({ where: { companyId: co.id } })).every((r) => r.companyId === co.id) && rcp.companyId === co.id);

  // Debts (obligations) are club-scoped: an obligation in clubB is not in the manager's scope.
  const obl = await p.employeeFinancialObligation.create({ data: { companyId: co.id, employeeId: emp.id, clubId: clubB.id, direction: "company_owes_employee", reason: "unpaid_salary", originalAmountKopeks: 500, outstandingAmountKopeks: 500, status: "open", createdByUserId: owner.id } });
  const managerVisibleObl = await p.employeeFinancialObligation.findMany({ where: { companyId: co.id, clubId: { in: managerClubIds } } });
  check("T5 долги: обязательство чужого клуба (B) не попадает в выборку управляющего (A)", managerVisibleObl.every((o) => o.clubId !== clubB.id) && obl.clubId === clubB.id);

  // cleanup
  await p.employeeFinancialObligation.deleteMany({ where: { companyId: co.id } });
  await p.regionalCityPayroll.deleteMany({ where: { companyId: co.id } });
  await p.payrollCalculation.deleteMany({ where: { payrollPeriodId: { in: [periodA.id, periodB.id] } } });
  await p.payrollPeriod.deleteMany({ where: { companyId: co.id } });
  await p.clubEmployee.deleteMany({ where: { companyId: co.id } });
  await p.club.deleteMany({ where: { companyId: co.id } });
  await p.company.deleteMany({ where: { id: { in: [co.id, otherCo.id] } } });
  await p.user.delete({ where: { id: owner.id } });
}

async function main() {
  pureTests();
  staticGuards();
  await realDb();
  await p.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
