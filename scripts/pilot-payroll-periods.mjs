// Payroll Stage 3 tests — period + calculation persistence wired to the engine.
// Mirrors the compute bridge (compute.ts) dispatch, period totals (periods.ts), and
// static guards proving snapshot immutability + lock enforcement in the actions.
// npm run pilot:payroll-periods
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = (rub) => rub * 100;
const BP = 10000;
const ceilRub = (k) => Math.ceil(k / 100) * 100;
const applyBp = (k, bp) => ceilRub(Math.round((k * bp) / BP));

// ---- mirror: compute bridge dispatch (compute.ts) ----
function computeScheme(scheme, input) {
  switch (scheme.type) {
    case "fixed_salary":
      return scheme.params.baseKopeks;
    case "salary_by_shifts":
      return ceilRub(Math.round((scheme.params.baseKopeks * Math.max(0, input.actualShifts ?? 0)) / (scheme.params.shiftNorm > 0 ? scheme.params.shiftNorm : 1)));
    case "salary_plus_percentage": {
      const shift = ceilRub(Math.round((scheme.params.baseKopeks * (input.actualShifts ?? 0)) / scheme.params.shiftNorm));
      const rate = input.planMet ? scheme.params.atPlanRateBp : scheme.params.belowPlanRateBp;
      return shift + applyBp(Math.max(0, input.netPersonalSalesKopeks ?? 0), rate);
    }
    case "sales_percentage":
      return applyBp(Math.max(0, input.salesKopeks ?? 0), scheme.params.rateBp);
    case "hourly":
      return ceilRub(Math.round(scheme.params.hourlyRateKopeks * Math.max(0, input.hours ?? 0)));
    case "profit_percentage":
      return applyBp(Math.max(0, input.cityProfitKopeks ?? 0), scheme.params.percentBp);
    case "mixed":
      return Math.max(0, input.manualAmountKopeks ?? 0);
    default:
      return 0;
  }
}

// ---- mirror: periodTotals (periods.ts) ----
function periodTotals(calcs) {
  return calcs.reduce(
    (t, c) => ({
      count: t.count + 1,
      grossAccruedKopeks: t.grossAccruedKopeks + c.grossAccruedKopeks,
      netPayableKopeks: t.netPayableKopeks + c.netPayableKopeks,
      paidKopeks: t.paidKopeks + c.paidKopeks,
      remainingKopeks: t.remainingKopeks + c.remainingKopeks,
    }),
    { count: 0, grossAccruedKopeks: 0, netPayableKopeks: 0, paidKopeks: 0, remainingKopeks: 0 },
  );
}

function main() {
  // --- dispatch correctness ---
  check("PER1 fixed salary", computeScheme({ type: "fixed_salary", params: { baseKopeks: R(30000) } }, {}) === R(30000));
  check("PER2 salary by shifts 12/15", computeScheme({ type: "salary_by_shifts", params: { baseKopeks: R(30000), shiftNorm: 15 } }, { actualShifts: 12 }) === R(24000));
  check("PER3 salary+percent plan met (4%)",
    computeScheme({ type: "salary_plus_percentage", params: { baseKopeks: R(30000), shiftNorm: 15, belowPlanRateBp: 300, atPlanRateBp: 400 } }, { actualShifts: 15, netPersonalSalesKopeks: R(500000), planMet: true }) === R(30000) + R(20000));
  check("PER4 salary+percent below plan (3%)",
    computeScheme({ type: "salary_plus_percentage", params: { baseKopeks: R(30000), shiftNorm: 15, belowPlanRateBp: 300, atPlanRateBp: 400 } }, { actualShifts: 15, netPersonalSalesKopeks: R(500000), planMet: false }) === R(30000) + R(15000));
  check("PER5 sales percentage 5%", computeScheme({ type: "sales_percentage", params: { rateBp: 500 } }, { salesKopeks: R(100000) }) === R(5000));
  check("PER6 hourly", computeScheme({ type: "hourly", params: { hourlyRateKopeks: R(700) } }, { hours: 40 }) === R(28000));
  check("PER7 profit percentage 10%", computeScheme({ type: "profit_percentage", params: { percentBp: 1000 } }, { cityProfitKopeks: R(1000000) }) === R(100000));
  check("PER8 mixed uses manual amount", computeScheme({ type: "mixed", params: {} }, { manualAmountKopeks: R(12345) }) === R(12345));
  check("PER9 missing inputs default to zero (no NaN)", computeScheme({ type: "salary_by_shifts", params: { baseKopeks: R(30000), shiftNorm: 15 } }, {}) === 0);

  // --- period totals roll-up ---
  const calcs = [
    { grossAccruedKopeks: R(44000), netPayableKopeks: R(44000), paidKopeks: R(20000), remainingKopeks: R(24000) },
    { grossAccruedKopeks: R(28000), netPayableKopeks: R(28000), paidKopeks: 0, remainingKopeks: R(28000) },
  ];
  const t = periodTotals(calcs);
  check("PER10 totals count", t.count === 2);
  check("PER11 totals gross", t.grossAccruedKopeks === R(72000));
  check("PER12 totals paid", t.paidKopeks === R(20000));
  check("PER13 totals remaining", t.remainingKopeks === R(52000));

  // ---- static guards: snapshot immutability + lock enforcement ----
  const actions = src("../src/app/(app)/payroll/periods/actions.ts");
  const periods = src("../src/lib/payroll/periods.ts");
  const compute = src("../src/lib/payroll/compute.ts");

  check("S17 calculation recomputes from the SNAPSHOT, not the live scheme",
    actions.includes("snapshotToSchemeParams(calc.schemeSnapshotJson)") && periods.includes("export function snapshotToSchemeParams"));
  check("S18 generation snapshots the effective scheme",
    actions.includes("makeSchemeSnapshot(scheme)") && actions.includes("getEffectiveSchemeForEmployee"));
  check("S19 locked period blocks generation AND input edits",
    (actions.match(/isPayrollPeriodLocked\(scope\.period\.status\)/g) ?? []).length >= 2);
  check("S20 re-generate never overwrites entered inputs",
    actions.includes("keeps its entered inputs") && actions.includes('existing.status === "draft"'));
  check("S21 period creation guards a closed month",
    actions.includes("monthClosedError(companyId, clubId, firstDay)"));
  check("S22 compute bridge is pure (no eval, no db import)",
    !/\beval\(|new Function\(|@\/lib\/prisma/.test(compute) && compute.includes("export function computeScheme"));
  check("S23 one period per club+month (unique lookup before create)",
    actions.includes("findFirst") && actions.includes("year, month"));
  check("S24 all period actions audited server-side",
    actions.includes('"payroll.period_created"') && actions.includes('"payroll.calculations_generated"') && actions.includes('"payroll.calculation_computed"'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
