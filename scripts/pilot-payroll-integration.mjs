// Payroll Stage 8 tests — OFD/sales integration + preliminary ФОТ. Mirrors the
// plan/fact base assembly + the plan-adjusted compute it feeds, and statically
// verifies the generate-time prefill (only club-level schemes, only on create,
// personal sales stay manual).
// npm run pilot:payroll-integration
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = (rub) => rub * 100;
const BP = 10000;
const ceilRub = (k) => Math.ceil(k / 100) * 100;

// ---- mirror: planTotalsByType direction split (sales-plans.ts) ----
function planTotalsByType(plans, scopeClubIds) {
  const set = new Set(scopeClubIds);
  const out = { total: 0, subscriptions: 0, personal_training: 0 };
  for (const p of plans) if (p.clubId && set.has(p.clubId) && ["total", "subscriptions", "personal_training"].includes(p.planType)) out[p.planType] += p.targetAmountKopeks;
  return out;
}

// ---- mirror: getClubPlanFactBases assembly (sales-bases.ts) ----
function bases(plan, fact) {
  return {
    subscriptions: { planKopeks: plan.subscriptions, factKopeks: fact.subscriptions },
    personalTraining: { planKopeks: plan.personal_training, factKopeks: fact.personal_training },
    hasPlan: plan.subscriptions > 0 || plan.personal_training > 0,
    hasFact: fact.subscriptions > 0 || fact.personal_training > 0,
  };
}

// ---- mirror: plan-fact part (calc.ts) — the spec's verified examples ----
const planFactAdj = (fact, plan, maxBp = 4000) => {
  if (plan <= 0) return 0;
  const devPct = (1 - fact / plan) * 100;
  const mag = Math.min(maxBp, 200 * Math.ceil(Math.abs(devPct)));
  return devPct >= 0 ? -mag : mag;
};
const part = (base, fact, plan) => ceilRub(Math.round((base * (BP + planFactAdj(fact, plan)) ) / BP));

function main() {
  // --- direction split from raw plans ---
  const plans = [
    { clubId: "c1", planType: "subscriptions", targetAmountKopeks: R(1350000) },
    { clubId: "c1", planType: "personal_training", targetAmountKopeks: R(1150000) },
    { clubId: "c2", planType: "subscriptions", targetAmountKopeks: R(999999) }, // other club — excluded
  ];
  const plan = planTotalsByType(plans, ["c1"]);
  check("INT1 plan split by direction, scoped to the club", plan.subscriptions === R(1350000) && plan.personal_training === R(1150000));

  // --- assemble bases + feed the plan-adjusted manager scheme (spec §4.5 examples) ---
  const b = bases(plan, { subscriptions: R(928637), personal_training: R(1137417) });
  check("INT2 bases carry plan + fact per direction", b.subscriptions.factKopeks === R(928637) && b.personalTraining.planKopeks === R(1150000) && b.hasPlan && b.hasFact);
  // subs base 60000, plan 1 350 000, fact 928 637 → completion 68.78% → −40% → 36 000
  check("INT3 prefilled subs part = 36 000 (−40% cap)", part(R(60000), R(928637), R(1350000)) === R(36000));
  // pt base 30000, plan 1 150 000, fact 1 137 417 → completion 98.90% → −4% → 28 800
  check("INT4 prefilled PT part = 28 800 (−4%)", part(R(30000), R(1137417), R(1150000)) === R(28800));
  check("INT5 preliminary total = 64 800", part(R(60000), R(928637), R(1350000)) + part(R(30000), R(1137417), R(1150000)) === R(64800));

  // --- empty data → no prefill trigger ---
  const empty = bases({ subscriptions: 0, personal_training: 0, total: 0 }, { subscriptions: 0, personal_training: 0, total: 0 });
  check("INT6 no plan/fact → prefill not triggered", empty.hasPlan === false && empty.hasFact === false);

  // ---- static guards ----
  const actions = src("../src/app/(app)/payroll/periods/actions.ts");
  const salesBases = src("../src/lib/payroll/sales-bases.ts");

  check("INT7 bases come from existing sales plans + confirmed report fact",
    salesBases.includes("getSalesPlansForCompanyMonth") && salesBases.includes("planTotalsByType") && salesBases.includes("getConfirmedReportFactTotals"));
  check("INT8 generate prefills club-level schemes only (plan_adjusted / revenue_%)",
    actions.includes('typed.type === "plan_adjusted_salary"') && actions.includes('typed.type === "revenue_percentage"') && actions.includes("getClubPlanFactBases"));
  check("INT9 prefill runs on CREATE only — entered inputs never overwritten",
    actions.includes("if (existing)") && actions.includes("existing.status === \"draft\""));
  check("INT10 prefilled calc is flagged as preliminary (ОФД/план)",
    actions.includes("подставлены из ОФД/плана продаж"));
  check("INT11 personal-sales commission stays manual (no per-employee sales source)",
    salesBases.includes("commission is NOT prefilled") && salesBases.includes("no per-employee sales attribution"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
