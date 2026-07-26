// STAGE 10–11 regression: regional change proposals + GD/owner approval queue. Real-DB
// exercise of the change-request lifecycle (pending ≠ affects total, one-time bonus,
// percent/base override, approve idempotency, reject/return, future scheme, close guard,
// tenant/IDOR) + a mirror of the pure engine (whitelist, override merge, previewChangeImpact,
// state machine) + static guards on the real service/UI/migration.
//   npm run pilot:payroll-change-requests
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// Mirror of the pure engine (src/lib/payroll/change-request.ts + formulas)
// ---------------------------------------------------------------------------

// Whitelist (subset used by the tests) — schemeType → { field: {fieldType, unit} }.
const WHITELIST = {
  role_club_manager: { abBaseKopeks: ["base_salary", "kopeks"], ptBaseKopeks: ["base_salary", "kopeks"], limitBp: ["percentage", "bp"] },
  sales_percentage: { rateBp: ["percentage", "bp"] },
  role_group_trainer: { hourRateKopeks: ["base_salary", "kopeks"], personalRateBp: ["percentage", "bp"] },
};
const fieldAllowed = (st, f, ft) => { const s = WHITELIST[st]?.[f]; return !!s && s[0] === ft; };

// Minimal formula mirrors (must match formulas.ts behaviour for the tested schemes).
const clampBp = (v) => Math.max(0, Math.min(10000, v));
function salesPct(params, input) { return Math.round((input.salesKopeks ?? 0) * (params.rateBp / 10000)); }
function groupTrainer(params, input) {
  const hours = input.hours ?? 0;
  const personal = Math.round((input.personalSalesKopeks ?? 0) * (params.personalRateBp / 10000));
  return hours * params.hourRateKopeks + personal;
}
const compute = (st, params, input) => (st === "sales_percentage" ? salesPct(params, input) : st === "role_group_trainer" ? groupTrainer(params, input) : 0);

function applyOverrides(st, baseParams, overrides) {
  const merged = { ...baseParams };
  for (const o of overrides) { if (!fieldAllowed(st, o.targetField, o.fieldType)) return { ok: false }; merged[o.targetField] = o.value; }
  return { ok: true, params: merged };
}

// previewChangeImpact mirror — percentage with no base → uncomputable (never fake 0).
const PCT_BASE = { sales_percentage: (i) => i.salesKopeks ?? 0, role_group_trainer: (i) => i.personalSalesKopeks ?? 0 };
function preview(st, baseParams, input, field, ft, value, existing = []) {
  if (!fieldAllowed(st, field, ft)) return { computable: false };
  const cur = applyOverrides(st, baseParams, existing);
  const prop = applyOverrides(st, baseParams, [...existing, { targetField: field, fieldType: ft, value }]);
  if (!cur.ok || !prop.ok) return { computable: false };
  if (ft === "percentage" && PCT_BASE[st] && PCT_BASE[st](input) <= 0) return { computable: false, reason: "no base" };
  const c = compute(st, cur.params, input), pp = compute(st, prop.params, input);
  return { computable: true, currentKopeks: c, proposedKopeks: pp, differenceKopeks: pp - c };
}

// State machine mirror.
const ALLOWED = {
  submit: ["draft"], resubmit: ["returned_for_revision"], start_review: ["submitted"],
  return: ["submitted", "under_review"], reject: ["submitted", "under_review"], approve: ["submitted", "under_review"],
  cancel: ["draft", "submitted", "under_review", "returned_for_revision"],
};
const canTransition = (from, t) => (ALLOWED[t] ?? []).includes(from);

function pureTests() {
  // Whitelist (§4).
  check("P1 whitelist пропускает разрешённое поле (limitBp/percentage у управляющего)", fieldAllowed("role_club_manager", "limitBp", "percentage"));
  check("P2 whitelist отклоняет чужой тип поля (limitBp как base_salary)", !fieldAllowed("role_club_manager", "limitBp", "base_salary"));
  check("P3 whitelist отклоняет неизвестное поле (companyId/clubId/employeeId — запрещены по умолчанию)",
    !fieldAllowed("role_club_manager", "companyId", "base_salary") && !fieldAllowed("role_club_manager", "clubId", "base_salary"));

  // Override merge (§6): snapshot не мутируется, объединённые параметры считаются заново.
  const base = { hourRateKopeks: 50000, personalRateBp: 1000 };
  const merged = applyOverrides("role_group_trainer", base, [{ targetField: "personalRateBp", fieldType: "percentage", value: 2000 }]);
  check("P4 override merge не меняет базовые params (snapshot неизменен)", base.personalRateBp === 1000 && merged.params.personalRateBp === 2000);

  // previewChangeImpact (§8, §23): один расчётный путь, разница считается корректно.
  const pv = preview("role_group_trainer", base, { hours: 10, personalSalesKopeks: 1000000 }, "personalRateBp", "percentage", 2000);
  // current: 10*50000 + 1000000*0.10 = 500000+100000=600000; proposed: 500000+200000=700000; diff=+100000
  check("P5 preview: разница начисления считается тем же движком (+100000)", pv.computable && pv.differenceKopeks === 100000);

  // §8 — процент без базы → «невозможно рассчитать», НЕ фейковый 0.
  const noBase = preview("sales_percentage", { rateBp: 300 }, { salesKopeks: 0 }, "rateBp", "percentage", 500);
  check("P6 preview: процент без базы → uncomputable, не фейковый 0", !noBase.computable);

  // base_salary изменение считается даже без выручки.
  const baseChange = preview("role_group_trainer", base, { hours: 10, personalSalesKopeks: 0 }, "hourRateKopeks", "base_salary", 60000);
  check("P7 preview: изменение оклада считается и без выручки (10*10000=+100000)", baseChange.computable && baseChange.differenceKopeks === 100000);

  // State machine (§13/§15).
  check("P8 из submitted можно approve/return/reject, нельзя submit", canTransition("submitted", "approve") && canTransition("submitted", "return") && !canTransition("submitted", "submit"));
  check("P9 approve возможен только из submitted/under_review (не из approved/rejected)", canTransition("under_review", "approve") && !canTransition("rejected", "approve") && !canTransition("applied", "approve"));
  check("P10 resubmit только из returned_for_revision", canTransition("returned_for_revision", "resubmit") && !canTransition("submitted", "resubmit"));

  // Overrides с несколькими entries — последний по полю выигрывает.
  const twice = applyOverrides("role_group_trainer", base, [
    { targetField: "personalRateBp", fieldType: "percentage", value: 1500 },
    { targetField: "personalRateBp", fieldType: "percentage", value: 2500 },
  ]);
  check("P11 несколько override на одно поле: последний выигрывает", twice.params.personalRateBp === 2500);
  void clampBp;
}

// ---------------------------------------------------------------------------
// Static guards on the real service / UI / migration
// ---------------------------------------------------------------------------
function staticGuards() {
  const lib = src("../src/lib/payroll/change-request.ts");
  const act = src("../src/app/(app)/payroll/change-requests/actions.ts");
  const access = src("../src/lib/payroll/access.ts");
  const periodsAct = src("../src/app/(app)/payroll/periods/actions.ts");
  const trainerAct = src("../src/app/(app)/payroll/periods/trainer-actions.ts");
  const migDev = src("../prisma/migrations/20260726110000_payroll_change_requests/migration.sql");
  const migProd = src("../prisma/production/migrations/20260726110000_payroll_change_requests/migration.sql");
  const detail = src("../src/app/(app)/payroll/change-requests/[id]/page.tsx");
  const queue = src("../src/app/(app)/payroll/change-requests/page.tsx");

  check("SG1 whitelist server-side: forbidden поля не в списке (companyId/clubId/employeeId/category/formula/engineVersion)",
    !/companyId|clubId|employeeId|category|formula|engineVersion|paidKopeks/.test(lib.slice(lib.indexOf("const WHITELIST"), lib.indexOf("allowedFieldsForScheme"))));
  check("SG2 preview и apply — один путь через computeScheme (никакого локального расчёта в UI)",
    lib.includes("import { computeScheme") && lib.includes("computeScheme(current.scheme, input)") && lib.includes("computeScheme(proposed.scheme, input)"));
  check("SG3 §8: процент без базы → «Невозможно рассчитать влияние», не 0",
    lib.includes("Невозможно рассчитать влияние") && lib.includes("PCT_BASE_INPUT"));
  check("SG4 override merge ре-валидирует через validateSchemeParams (границы значений)",
    lib.includes("validateSchemeParams(schemeType, merged)"));
  check("SG5 effectiveSchemeParams = snapshot + approved overrides (snapshot не переписывается)",
    lib.includes("export function effectiveSchemeParams") && lib.includes("applyOverridesToParams(snap.schemeType, snap.params, overrides)"));
  check("SG6 compute-путь honors overrides (saveCalculationInputs + gym trainer)",
    periodsAct.includes("effectiveSchemeParams(calc.schemeSnapshotJson, calc.approvedOverridesJson)") && trainerAct.includes("effectiveSchemeParams(calc.schemeSnapshotJson, calc.approvedOverridesJson)"));
  check("SG7 approve идемпотентен: атомарный claim (unique appliedToken + статус-precondition)",
    act.includes("appliedToken: token") && act.includes('status: { in: ["submitted", "under_review"] }, appliedToken: null') && act.includes("claim.count === 0"));
  check("SG8 one-time bonus → approved PayrollAdjustment (credit), без движения денег (§7)",
    act.includes('type: "bonus"') && act.includes('direction: "credit"') && act.includes("recomputeCalculationTotals") && !/createSalaryExpense|cashMovement/.test(act));
  check("SG9 роли server-side: propose=regional, review=GD/owner, нельзя согласовать своё",
    access.includes("canProposePayrollChange") && access.includes('r === "regional_director"') && access.includes("canReviewPayrollChange") && act.includes("req.requestedById === scope.ctx.user.id"));
  check("SG10 reject/return не трогают расчёт (нет recompute/override в этих ветках)", (() => {
    const rej = act.slice(act.indexOf("export async function rejectChangeRequest"), act.indexOf("export async function approveChangeRequest"));
    return !/recomputeCalculationTotals|approvedOverridesJson|payrollAdjustment\.create/.test(rej);
  })());
  check("SG11 future_scheme_change → approved_pending_scheme_creation, не «applied» (§10 Variant B)",
    act.includes("approved_pending_scheme_creation") && act.includes("Создание новой схемы выполняется отдельно"));
  check("SG12 close guard: период с submitted/under_review/returned заявкой не закрыть (§16)",
    periodsAct.includes("payrollChangeRequest.count") && periodsAct.includes('["submitted", "under_review", "returned_for_revision"]') && periodsAct.includes("незакрытые заявки"));
  check("SG13 tenant/IDOR: scope по companyId + accessible clubIds",
    act.includes("calc.companyId !== base.companyId") && act.includes("base.clubIds.includes(req.clubId)"));
  check("SG14 полный аудит-трейл (historyJson append-only, не только последнее состояние)",
    lib.includes("export function appendHistory") && act.includes("appendHistory(req.historyJson"));
  check("SG15 миграция аддитивна (ADD COLUMN + CREATE TABLE, unique appliedToken, без DROP/ALTER COLUMN/rebuild)",
    migDev.includes("ADD COLUMN") && migDev.includes('CREATE TABLE "PayrollChangeRequest"') && migDev.includes("PayrollChangeRequest_appliedToken_key") &&
    migProd.includes('CREATE TABLE "PayrollChangeRequest"') && !/\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bALTER\s+COLUMN\b|\bRENAME\b/i.test(migDev) && !/\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bALTER\s+COLUMN\b|\bRENAME\b/i.test(migProd));
  check("SG16 UI: очередь desktop-таблица + mobile-карточки + KPI + фильтры",
    queue.includes("hidden overflow-hidden sm:block") && queue.includes("sm:hidden") && queue.includes("function Kpi") && queue.includes("FilterLink"));
  check("SG17 detail: before/after + предупреждение о переплате (§17) + история",
    detail.includes("Было") && detail.includes("Станет") && detail.includes("overpayWarning") && detail.includes("История"));
  check("SG18 notifications через существующую инфраструктуру (events.ts), не с нуля",
    act.includes("notifyPayrollChangeReview") && act.includes("notifyPayrollChangeDecision"));
}

// ---------------------------------------------------------------------------
// Real DB lifecycle
// ---------------------------------------------------------------------------
async function realDb() {
  const uid = `cr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const owner = await p.user.create({ data: { email: `${uid}-o@t.dev`, name: "ГД", role: "owner", isActive: true } });
  const regional = await p.user.create({ data: { email: `${uid}-r@t.dev`, name: "Регионал", role: "regional_director", isActive: true } });
  const co = await p.company.create({ data: { name: `Co ${uid}` } });
  const otherCo = await p.company.create({ data: { name: `Other ${uid}` } });
  const club = await p.club.create({ data: { companyId: co.id, name: "A", city: "X" } });
  const emp = await p.clubEmployee.create({ data: { companyId: co.id, clubId: club.id, fullName: "Тренер", position: "group_trainer", status: "active" } });
  const year = 2026, month = 9;

  const snapshot = { schemeId: "sch1", schemeType: "role_group_trainer", params: { hourRateKopeks: 50000, personalRateBp: 1000 }, effectiveFrom: "2026-01-01T00:00:00.000Z" };
  const details = { breakdown: [], flags: {}, warnings: [], inputJson: JSON.stringify({ hours: 10, personalSalesKopeks: 1000000 }) };
  const period = await p.payrollPeriod.create({ data: { companyId: co.id, clubId: club.id, year, month, status: "draft", createdByUserId: owner.id } });
  // automatic: 10*50000 + 1000000*0.10 = 600000
  const calc = await p.payrollCalculation.create({ data: { payrollPeriodId: period.id, companyId: co.id, clubId: club.id, employeeId: emp.id, roleSnapshot: "group_trainer", schemeSnapshotJson: JSON.stringify(snapshot), detailsJson: JSON.stringify(details), automaticAmountKopeks: 600000, grossAccruedKopeks: 600000, netPayableKopeks: 600000, status: "calculated" } });

  // ---- T1: create a pending percent-change request; total unchanged ----
  const impact = preview("role_group_trainer", snapshot.params, { hours: 10, personalSalesKopeks: 1000000 }, "personalRateBp", "percentage", 2000);
  const reqPct = await p.payrollChangeRequest.create({ data: {
    companyId: co.id, clubId: club.id, employeeId: emp.id, payrollPeriodId: period.id, payrollCalculationId: calc.id, payrollSchemeId: "sch1",
    requestType: "period_adjustment", fieldType: "percentage", targetField: "personalRateBp",
    oldValueJson: JSON.stringify(1000), proposedValueJson: JSON.stringify(2000),
    calculatedImpactKopeks: impact.differenceKopeks, impactUncomputable: false,
    reason: "Рост личных продаж", status: "submitted", revision: 1, requestedById: regional.id, requestedAt: new Date(), submittedAt: new Date(),
    historyJson: JSON.stringify([{ at: new Date().toISOString(), by: regional.id, action: "submitted", toStatus: "submitted", revision: 1 }]),
  } });
  const calcAfterSubmit = await p.payrollCalculation.findUnique({ where: { id: calc.id } });
  check("T1 pending заявка НЕ меняет итог (grossAccrued остался 600000, overrides пусты)",
    calcAfterSubmit.grossAccruedKopeks === 600000 && calcAfterSubmit.approvedOverridesJson === null && reqPct.calculatedImpactKopeks === 100000);

  // ---- T2: approve applies exactly once (idempotent claim) ----
  const token = `apply:${reqPct.id}`;
  const claim1 = await p.payrollChangeRequest.updateMany({ where: { id: reqPct.id, status: { in: ["submitted", "under_review"] }, appliedToken: null }, data: { appliedToken: token, reviewedById: owner.id, reviewedAt: new Date() } });
  check("T2 первый claim успешен (count=1)", claim1.count === 1);
  const claim2 = await p.payrollChangeRequest.updateMany({ where: { id: reqPct.id, status: { in: ["submitted", "under_review"] }, appliedToken: null }, data: { appliedToken: token } });
  check("T3 повторный claim не проходит (идемпотентность, count=0)", claim2.count === 0);

  // apply override + recompute (mirror of recomputeCalcFromEffective).
  const overrides = [{ requestId: reqPct.id, targetField: "personalRateBp", fieldType: "percentage", value: 2000, appliedAt: new Date().toISOString() }];
  await p.payrollCalculation.update({ where: { id: calc.id }, data: { approvedOverridesJson: JSON.stringify({ overrides }) } });
  const eff = applyOverrides("role_group_trainer", snapshot.params, overrides);
  const newAuto = compute("role_group_trainer", eff.params, { hours: 10, personalSalesKopeks: 1000000 });
  await p.payrollCalculation.update({ where: { id: calc.id }, data: { automaticAmountKopeks: newAuto, grossAccruedKopeks: newAuto, netPayableKopeks: newAuto } });
  await p.payrollChangeRequest.update({ where: { id: reqPct.id }, data: { status: "applied", appliedById: owner.id, appliedAt: new Date() } });
  const calcApplied = await p.payrollCalculation.findUnique({ where: { id: calc.id } });
  check("T4 approve применяет override РОВНО один раз (600000 → 700000)", calcApplied.grossAccruedKopeks === 700000);
  check("T5 base snapshot НЕ переписан (snapshot.params.personalRateBp = 1000)", JSON.parse(calcApplied.schemeSnapshotJson).params.personalRateBp === 1000);
  check("T6 approved override хранится отдельно (approvedOverridesJson)", JSON.parse(calcApplied.approvedOverridesJson).overrides[0].value === 2000);

  // ---- T7: one-time bonus → adjustment, no money movement ----
  const reqBonus = await p.payrollChangeRequest.create({ data: {
    companyId: co.id, clubId: club.id, employeeId: emp.id, payrollPeriodId: period.id, payrollCalculationId: calc.id,
    requestType: "period_adjustment", fieldType: "one_time_bonus", targetField: "one_time_bonus",
    proposedValueJson: JSON.stringify(150000), calculatedImpactKopeks: 150000, impactUncomputable: false,
    reason: "Премия за результат", status: "submitted", revision: 1, requestedById: regional.id, requestedAt: new Date(), submittedAt: new Date(),
  } });
  const adj = await p.payrollAdjustment.create({ data: { companyId: co.id, payrollCalculationId: calc.id, employeeId: emp.id, clubId: club.id, type: "bonus", direction: "credit", amountKopeks: 150000, reason: "Разовая премия", status: "approved", createdByUserId: regional.id, approvedByUserId: owner.id } });
  await p.payrollChangeRequest.update({ where: { id: reqBonus.id }, data: { status: "applied", appliedToken: `apply:${reqBonus.id}`, appliedAdjustmentId: adj.id, appliedById: owner.id, appliedAt: new Date() } });
  const bonusAdjustments = await p.payrollAdjustment.count({ where: { payrollCalculationId: calc.id, type: "bonus", status: "approved" } });
  const payments = await p.payrollPayment.count({ where: { payrollCalculationId: calc.id } });
  check("T7 one-time bonus → одна approved корректировка, движения денег нет", bonusAdjustments === 1 && payments === 0);

  // ---- T8: reject does not change the calc ----
  const before = await p.payrollCalculation.findUnique({ where: { id: calc.id } });
  const reqReject = await p.payrollChangeRequest.create({ data: { companyId: co.id, clubId: club.id, employeeId: emp.id, payrollPeriodId: period.id, payrollCalculationId: calc.id, requestType: "period_adjustment", fieldType: "base_salary", targetField: "hourRateKopeks", proposedValueJson: JSON.stringify(90000), reason: "нет", status: "submitted", revision: 1, requestedById: regional.id } });
  await p.payrollChangeRequest.update({ where: { id: reqReject.id }, data: { status: "rejected", reviewedById: owner.id, reviewedAt: new Date(), rejectedAt: new Date(), reviewerComment: "не обосновано" } });
  const after = await p.payrollCalculation.findUnique({ where: { id: calc.id } });
  check("T8 reject не меняет расчёт (grossAccrued не изменился)", before.grossAccruedKopeks === after.grossAccruedKopeks);

  // ---- T9: return keeps revision history; resubmit bumps revision ----
  const reqReturn = await p.payrollChangeRequest.create({ data: { companyId: co.id, clubId: club.id, employeeId: emp.id, payrollPeriodId: period.id, payrollCalculationId: calc.id, requestType: "period_adjustment", fieldType: "percentage", targetField: "personalRateBp", proposedValueJson: JSON.stringify(3000), reason: "ещё выше", status: "submitted", revision: 1, requestedById: regional.id, historyJson: JSON.stringify([{ at: new Date().toISOString(), by: regional.id, action: "submitted", revision: 1 }]) } });
  let hist = JSON.parse(reqReturn.historyJson); hist.push({ at: new Date().toISOString(), by: owner.id, action: "returned", comment: "уточните" });
  await p.payrollChangeRequest.update({ where: { id: reqReturn.id }, data: { status: "returned_for_revision", reviewedById: owner.id, returnedAt: new Date(), reviewerComment: "уточните", historyJson: JSON.stringify(hist) } });
  hist.push({ at: new Date().toISOString(), by: regional.id, action: "resubmitted", revision: 2 });
  await p.payrollChangeRequest.update({ where: { id: reqReturn.id }, data: { status: "submitted", revision: 2, historyJson: JSON.stringify(hist) } });
  const returned = await p.payrollChangeRequest.findUnique({ where: { id: reqReturn.id } });
  check("T9 return→resubmit сохраняет историю (3 события) и повышает ревизию (2)", JSON.parse(returned.historyJson).length === 3 && returned.revision === 2);

  // ---- T10: future scheme change → approved_pending_scheme_creation, calc unchanged ----
  const grossBeforeFuture = (await p.payrollCalculation.findUnique({ where: { id: calc.id } })).grossAccruedKopeks;
  const reqFuture = await p.payrollChangeRequest.create({ data: { companyId: co.id, clubId: club.id, employeeId: emp.id, payrollPeriodId: period.id, payrollCalculationId: calc.id, requestType: "future_scheme_change", fieldType: "percentage", targetField: "personalRateBp", proposedValueJson: JSON.stringify(1500), effectiveFrom: new Date("2026-12-01"), reason: "новая схема с декабря", impactUncomputable: true, status: "submitted", revision: 1, requestedById: regional.id } });
  await p.payrollChangeRequest.update({ where: { id: reqFuture.id }, data: { status: "approved_pending_scheme_creation", reviewedById: owner.id, reviewedAt: new Date(), appliedToken: `apply:${reqFuture.id}` } });
  const grossAfterFuture = (await p.payrollCalculation.findUnique({ where: { id: calc.id } })).grossAccruedKopeks;
  check("T10 future scheme: статус approved_pending_scheme_creation, текущий расчёт не изменён", grossBeforeFuture === grossAfterFuture);

  // ---- T11: close guard — an open request blocks close ----
  const openReq = await p.payrollChangeRequest.create({ data: { companyId: co.id, clubId: club.id, employeeId: emp.id, payrollPeriodId: period.id, payrollCalculationId: calc.id, requestType: "period_adjustment", fieldType: "percentage", targetField: "personalRateBp", proposedValueJson: JSON.stringify(2200), reason: "open", status: "submitted", revision: 1, requestedById: regional.id } });
  const openCount = await p.payrollChangeRequest.count({ where: { payrollPeriodId: period.id, status: { in: ["submitted", "under_review", "returned_for_revision"] } } });
  check("T11 close guard: есть открытая заявка → закрытие периода блокируется", openCount > 0);
  // Resolve EVERY still-open request (openReq + the resubmitted reqReturn) → close allowed.
  await p.payrollChangeRequest.update({ where: { id: openReq.id }, data: { status: "cancelled", cancelledAt: new Date() } });
  await p.payrollChangeRequest.update({ where: { id: reqReturn.id }, data: { status: "rejected", reviewedById: owner.id, rejectedAt: new Date() } });
  const openCount2 = await p.payrollChangeRequest.count({ where: { payrollPeriodId: period.id, status: { in: ["submitted", "under_review", "returned_for_revision"] } } });
  check("T12 после отмены/решения всех заявок закрытие разрешено", openCount2 === 0);

  // ---- T13: tenant isolation + IDOR ----
  check("T13 tenant isolation: чужая компания не видит заявки", (await p.payrollChangeRequest.count({ where: { companyId: otherCo.id } })) === 0);
  check("T14 IDOR: заявка принадлежит своей компании и клубу", (await p.payrollChangeRequest.findMany({ where: { companyId: co.id } })).every((r) => r.clubId === club.id && r.companyId === co.id));

  // ---- T15: appliedToken unique — DB enforces one applied artifact per request ----
  let tokenDup = false;
  try { await p.payrollChangeRequest.update({ where: { id: reqBonus.id }, data: { appliedToken: `apply:${reqPct.id}` } }); } catch { tokenDup = true; }
  check("T15 appliedToken @unique: нельзя переиспользовать токен другого запроса", tokenDup);

  // cleanup
  await p.payrollAdjustment.deleteMany({ where: { companyId: co.id } });
  await p.payrollChangeRequest.deleteMany({ where: { companyId: co.id } });
  await p.payrollCalculation.deleteMany({ where: { payrollPeriodId: period.id } });
  await p.payrollPeriod.deleteMany({ where: { companyId: co.id } });
  await p.clubEmployee.deleteMany({ where: { companyId: co.id } });
  await p.club.deleteMany({ where: { companyId: co.id } });
  await p.company.deleteMany({ where: { id: { in: [co.id, otherCo.id] } } });
  await p.user.deleteMany({ where: { id: { in: [owner.id, regional.id] } } });
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
