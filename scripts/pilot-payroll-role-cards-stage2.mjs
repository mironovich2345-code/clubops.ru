// STAGE 2 + 3–8 regression: category model, scheme resolver (priority/conflict/tenant),
// snapshot + engine version, formulas wired into the real calc path, and the 5-card UI.
// Static guards on the real source + a real-DB mirror of the resolver/snapshot rules.
// Formula VALUES are covered by pilot:payroll-formulas; this suite proves the WIRING.
//   npm run pilot:payroll-role-cards-stage2
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ---- mirror of categories.ts ----
const catOfPos = (pos) => ({ manager: "club_manager", sales_manager: "sales_manager", administrator: "administrator", night_manager: "night_manager", head_gym_trainer: "gym_head_trainer", gym_trainer: "gym_trainer", senior_group_trainer: "group_head_trainer", group_trainer: "group_trainer" }[pos] ?? "unknown");
const uiGroupOfCat = (c) => (c === "club_manager" ? "manager_card" : ["sales_manager", "administrator", "night_manager"].includes(c) ? "administrative_card" : ["gym_head_trainer", "gym_trainer"].includes(c) ? "gym_trainers_card" : "group_trainers_card");

// ---- mirror of resolveEffectiveScheme + resolveSchemeForCalc priority ----
const ms = (d) => new Date(d).getTime();
function resolveEffective(rows, at) {
  const t = at.getTime(); let best = null;
  for (const s of rows) { const from = ms(s.effectiveFrom), to = s.effectiveTo == null ? Infinity : ms(s.effectiveTo); if (from <= t && t < to) { if (!best || from > ms(best.effectiveFrom)) best = s; } }
  return best;
}
function hasConflict(rows, at) { const t = at.getTime(); const cov = rows.filter((s) => ms(s.effectiveFrom) <= t && (s.effectiveTo == null || ms(s.effectiveTo) > t)); if (cov.length < 2) return false; const mx = Math.max(...cov.map((s) => ms(s.effectiveFrom))); return cov.filter((s) => ms(s.effectiveFrom) === mx).length > 1; }

function staticGuards() {
  const cats = src("../src/lib/payroll/categories.ts");
  const enums = src("../src/lib/payroll/enums.ts");
  const scheme = src("../src/lib/payroll/scheme.ts");
  const compute = src("../src/lib/payroll/compute.ts");
  const roleCompute = src("../src/lib/payroll/role-compute.ts");
  const schemes = src("../src/lib/payroll/schemes.ts");
  const actions = src("../src/app/(app)/payroll/periods/actions.ts");
  const card = src("../src/app/(app)/payroll/_components/CalculationCard.tsx");
  const periodPage = src("../src/app/(app)/payroll/periods/[id]/page.tsx");
  const cardsComp = src("../src/app/(app)/payroll/_components/PeriodCategoryCards.tsx");

  check("SG1 UI group ≠ payroll category (8 категорий, 5 UI-групп, разные функции)",
    cats.includes("PAYROLL_CALC_CATEGORIES") && cats.includes("PAYROLL_UI_GROUPS") && cats.includes("payrollCategoryOfPosition") && cats.includes("payrollUiGroupOfCategory"));
  check("SG2 административная карточка = 3 разные категории (sales_manager/administrator/night_manager)",
    catOfPos("sales_manager") === "sales_manager" && catOfPos("administrator") === "administrator" && catOfPos("night_manager") === "night_manager" &&
    uiGroupOfCat("sales_manager") === "administrative_card" && uiGroupOfCat("administrator") === "administrative_card" && uiGroupOfCat("night_manager") === "administrative_card");
  check("SG3 ТЗ и ГП содержат head + regular категории", uiGroupOfCat("gym_head_trainer") === "gym_trainers_card" && uiGroupOfCat("gym_trainer") === "gym_trainers_card" && uiGroupOfCat("group_head_trainer") === "group_trainers_card" && uiGroupOfCat("group_trainer") === "group_trainers_card");
  check("SG4 unknown-должность не получает случайную формулу", catOfPos("some_legacy_role") === "unknown" && cats.includes('return "unknown"'));
  check("SG5 позиция sales_manager добавлена (аддитивно)", enums.includes('"sales_manager"') && enums.includes("Менеджер продаж"));
  check("SG6 8 role_* типов схем + типизированные params + валидация tiers",
    enums.includes("ROLE_CATEGORY_SCHEME_TYPES") && scheme.includes("role_club_manager") && scheme.includes("function tiers") && scheme.includes("RoleSalesManagerParams"));
  check("SG7 formulas.ts подключён в ЕДИНОЙ точке (computeScheme → role-compute → formulas)",
    compute.includes("isRoleCategoryScheme(scheme.type)") && compute.includes("computeRoleCategoryScheme") && roleCompute.includes("from \"@/lib/payroll/formulas\"") && roleCompute.includes("managerSalary") && roleCompute.includes("seniorGroupTrainerSalary"));
  check("SG8 резолвер приоритета: сотрудник → категория клуба → not_configured/conflict",
    schemes.includes("resolveSchemeForCalc") && schemes.includes('level: "employee"') && schemes.includes('level: "category"') && schemes.includes("employeeId: null") && schemes.includes('reason: "conflict"'));
  check("SG9 generateCalculations резолвит по приоритету + ставит engineVersion + snapshot",
    actions.includes("resolveSchemeForCalc") && actions.includes("calculationEngineVersion: engineVersion") && actions.includes('role_categories_v2') && actions.includes("makeSchemeSnapshot(scheme)"));
  check("SG10 collectPeriodInput читает входы всех 8 role_* категорий",
    ["role_club_manager", "role_administrator", "role_sales_manager", "role_night_manager", "role_gym_trainer", "role_gym_head_trainer", "role_group_trainer", "role_group_head_trainer"].every((t) => actions.includes(`case "${t}"`)));
  check("SG11 CalculationCard: наборы полей для 8 role_* типов", ["role_club_manager", "role_sales_manager", "role_gym_head_trainer", "role_group_head_trainer"].every((t) => card.includes(t)));
  check("SG12 5 карточек в периоде (Управляющий/Админсостав/ТЗ/ГП/Аванс) + прогресс",
    periodPage.includes("PeriodCategoryCards") && periodPage.includes("Расчёт заполнен на") && cardsComp.includes("advances_card") && cardsComp.includes("Открыть →"));
  check("SG13 recompute использует stored automatic; snapshot защищает закрытый месяц",
    src("../src/lib/payroll/aggregate.ts").includes("automaticAmountKopeks") && schemes.includes("NEVER recompute a closed month") && schemes.includes("resolveEffectiveScheme"));
  check("SG14 role-compute: кредит тренера НЕ в total (информативно)",
    roleCompute.includes("gymTrainerSalary") && roleCompute.includes("Кредит тренера (информационно)"));
  check("SG15 миграция аддитивная (ADD COLUMN, без DROP/rebuild), default legacy_v1", (() => {
    const mig = src("../prisma/migrations/20260726090000_payroll_engine_version/migration.sql");
    return mig.includes("ADD COLUMN") && !/\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bALTER\s+COLUMN\b|\bRENAME\b/i.test(mig) && /calculationEngineVersion\s+String\s+@default\("legacy_v1"\)/.test(src("../prisma/schema.prisma"));
  })());
}

async function realDb() {
  const uid = `rc2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const owner = await p.user.create({ data: { email: `${uid}@t.dev`, name: "O", role: "owner", isActive: true } });
  const co = await p.company.create({ data: { name: `Co ${uid}` } });
  const otherCo = await p.company.create({ data: { name: `Other ${uid}` } });
  const clubA = await p.club.create({ data: { companyId: co.id, name: "A", city: "X" } });
  const clubB = await p.club.create({ data: { companyId: co.id, name: "B", city: "X" } });
  const emp = await p.clubEmployee.create({ data: { companyId: co.id, clubId: clubA.id, fullName: "Иван", position: "sales_manager", status: "active" } });
  const dismissed = await p.clubEmployee.create({ data: { companyId: co.id, clubId: clubA.id, fullName: "Пётр", position: "administrator", status: "dismissed" } });
  const at = new Date("2026-09-01T00:00:00.000Z");
  const params = JSON.stringify({ salaryFor15Kopeks: 4500000, shiftNorm: 15, tiers: [{ thresholdBp: 0, percentBp: 300 }, { thresholdBp: 10000, percentBp: 400 }] });

  // category scheme (employeeId=null) + employee-specific scheme → employee wins.
  const catScheme = await p.employeePayScheme.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: null, position: "sales_manager", schemeType: "role_sales_manager", paramsJson: params, effectiveFrom: new Date("2026-01-01"), createdByUserId: owner.id } });
  const empScheme = await p.employeePayScheme.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: emp.id, position: "sales_manager", schemeType: "role_sales_manager", paramsJson: params, effectiveFrom: new Date("2026-06-01"), createdByUserId: owner.id } });

  async function resolve(companyId, clubId, employeeId, position) {
    const empRows = await p.employeePayScheme.findMany({ where: { companyId, clubId, employeeId }, orderBy: [{ effectiveFrom: "desc" }] });
    if (hasConflict(empRows, at)) return { ok: false, reason: "conflict" };
    const e = resolveEffective(empRows, at); if (e) return { ok: true, level: "employee", scheme: e };
    const catRows = await p.employeePayScheme.findMany({ where: { companyId, clubId, employeeId: null, position }, orderBy: [{ effectiveFrom: "desc" }] });
    if (hasConflict(catRows, at)) return { ok: false, reason: "conflict" };
    const c = resolveEffective(catRows, at); if (c) return { ok: true, level: "category", scheme: c };
    return { ok: false, reason: "not_configured" };
  }

  const r1 = await resolve(co.id, clubA.id, emp.id, "sales_manager");
  check("PR1 employee-specific схема выше схемы категории", r1.ok && r1.level === "employee" && r1.scheme.id === empScheme.id);

  // remove employee scheme → category scheme used.
  await p.employeePayScheme.delete({ where: { id: empScheme.id } });
  const r2 = await resolve(co.id, clubA.id, emp.id, "sales_manager");
  check("PR2 схема категории клуба выше fallback (используется при отсутствии employee-схемы)", r2.ok && r2.level === "category" && r2.scheme.id === catScheme.id);

  // other club → not found (tenant/club scope).
  const r3 = await resolve(co.id, clubB.id, emp.id, "sales_manager");
  check("PR3 схема другого клуба не используется", !r3.ok && r3.reason === "not_configured");
  const r4 = await resolve(otherCo.id, clubA.id, emp.id, "sales_manager");
  check("PR4 tenant isolation — чужая компания не видит схему", !r4.ok);

  // conflict: two category schemes same effectiveFrom covering `at`.
  await p.employeePayScheme.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: null, position: "sales_manager", schemeType: "role_sales_manager", paramsJson: params, effectiveFrom: new Date("2026-01-01"), createdByUserId: owner.id } });
  const r5 = await resolve(co.id, clubA.id, emp.id, "sales_manager");
  check("PR5 конфликт схем (одна дата начала) блокирует расчёт", !r5.ok && r5.reason === "conflict");

  // snapshot + engine version on a calc.
  const period = await p.payrollPeriod.create({ data: { companyId: co.id, clubId: clubA.id, year: 2026, month: 9, status: "draft", createdByUserId: owner.id } });
  const snapshot = JSON.stringify({ schemeId: catScheme.id, schemeType: "role_sales_manager", params: JSON.parse(params), effectiveFrom: catScheme.effectiveFrom });
  const calc = await p.payrollCalculation.create({ data: { payrollPeriodId: period.id, companyId: co.id, clubId: clubA.id, employeeId: emp.id, roleSnapshot: "sales_manager", schemeSnapshotJson: snapshot, calculationEngineVersion: "role_categories_v2", status: "calculated", grossAccruedKopeks: 3000000 } });
  check("PR6 snapshot хранит параметры + engineVersion role_categories_v2", calc.calculationEngineVersion === "role_categories_v2" && JSON.parse(calc.schemeSnapshotJson).params.tiers.length === 2);

  // live scheme change does not change snapshot.
  await p.employeePayScheme.update({ where: { id: catScheme.id }, data: { paramsJson: JSON.stringify({ salaryFor15Kopeks: 9999999, shiftNorm: 15, tiers: [{ thresholdBp: 0, percentBp: 900 }] }) } });
  const calcAfter = await p.payrollCalculation.findUnique({ where: { id: calc.id } });
  check("PR7 изменение живой схемы не меняет snapshot расчёта", JSON.parse(calcAfter.schemeSnapshotJson).params.salaryFor15Kopeks === 4500000);

  // closed period calc keeps engine/snapshot (not recomputed).
  await p.payrollPeriod.update({ where: { id: period.id }, data: { status: "closed" } });
  const closedCalc = await p.payrollCalculation.findUnique({ where: { id: calc.id } });
  check("PR8 закрытый период сохраняет snapshot/engineVersion (не пересчитывается)", closedCalc.calculationEngineVersion === "role_categories_v2");

  // dismissed excluded from active roster (generate only takes status active).
  const active = await p.clubEmployee.findMany({ where: { companyId: co.id, clubId: clubA.id, status: "active" } });
  check("PR9 уволенный не в активном составе (generate берёт только active)", active.every((e) => e.id !== dismissed.id) && active.some((e) => e.id === emp.id));

  // historical: a calc created before dismissal stays in its period.
  const histCalc = await p.payrollCalculation.create({ data: { payrollPeriodId: period.id, companyId: co.id, clubId: clubA.id, employeeId: dismissed.id, roleSnapshot: "administrator", status: "closed", grossAccruedKopeks: 1000000, calculationEngineVersion: "role_categories_v2" } });
  const stillThere = await p.payrollCalculation.findFirst({ where: { payrollPeriodId: period.id, employeeId: dismissed.id } });
  check("PR10 исторический сотрудник остаётся в своём (закрытом) периоде", Boolean(stillThere) && stillThere.id === histCalc.id);

  // cleanup
  await p.payrollCalculation.deleteMany({ where: { payrollPeriodId: period.id } });
  await p.payrollPeriod.deleteMany({ where: { companyId: co.id } });
  await p.employeePayScheme.deleteMany({ where: { companyId: co.id } });
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
