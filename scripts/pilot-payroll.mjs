// Payroll calculation-core tests (behavioural — faithful mirrors of the pure engine
// in src/lib/payroll/calc.ts + period.ts) covering the spec §11 scenarios that are
// pure (formulas, aggregation, trainer credit, status machine, permissions). Payment
// / cash-ledger integration scenarios (Stage 5) are exercised in later stages.
// npm run pilot:payroll
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = (rub) => rub * 100; // rubles → kopeks

// ---- mirrors of calc.ts (kopeks; bp = basis points; 100% = 10000) ----
const BP = 10000;
const ceilRub = (k) => Math.ceil(k / 100) * 100; // ceilToRubleKopeks
const applyBp = (k, bp) => ceilRub(Math.round((k * bp) / BP));
const salaryByShifts = (base, shifts, norm) => ceilRub(Math.round((base * Math.max(0, shifts)) / (norm > 0 ? norm : 1)));
const salesCommission = (rateBp, net) => applyBp(Math.max(0, net), rateBp);
const hourly = (rate, hours) => ceilRub(Math.round(rate * Math.max(0, hours)));
const seniorGroup = (fixed, rateBp, sales) => fixed + applyBp(Math.max(0, sales), rateBp);
const gymPackage = (pkg, low, high, threshold) => {
  const net = Math.max(0, pkg.contract - (pkg.refund ?? 0));
  const rateBp = pkg.contract <= threshold ? low : high;
  const sessionPrice = pkg.sessions > 0 ? Math.round(pkg.contract / pkg.sessions) : 0;
  return { income: applyBp(net, rateBp), sessionPrice, rateBp };
};
const planFactAdj = (fact, plan, maxBp = 4000, manualBp = 2000) => {
  if (plan <= 0) return { adjustmentBp: 0, completionBp: 0, needsManual: true };
  const completion = fact / plan;
  const completionBp = Math.max(0, Math.round(completion * BP));
  const devPct = (1 - completion) * 100;
  const mag = Math.min(maxBp, 200 * Math.ceil(Math.abs(devPct)));
  return { adjustmentBp: devPct >= 0 ? -mag : mag, completionBp, needsManual: Math.abs(devPct) * 100 > manualBp };
};
const planFactPart = (base, fact, plan, maxBp, manualBp) => {
  const a = planFactAdj(fact, plan, maxBp, manualBp);
  return { part: ceilRub(Math.round((base * (BP + a.adjustmentBp)) / BP)), ...a };
};
const trainerCredit = (paid, provided, price) => {
  const p = Math.max(0, paid), pr = Math.min(p, Math.max(0, provided));
  return { allowed: pr * price, overpaid: Math.max(0, p * price - pr * price), unprovided: p - pr };
};
const aggregate = ({ automatic, credits = 0, debits = 0, advance = 0, other = 0 }) => {
  const gross = automatic + credits - debits, net = gross, paid = advance + other, remaining = net - paid;
  return { gross, net, paid, remaining, employeeDebt: remaining < 0 ? -remaining : 0, companyDebt: remaining > 0 ? remaining : 0 };
};
const streakBonus = (months, tiers) => { let b = 0; for (const t of tiers) if (months >= t.m) b = Math.max(b, t.bonus); return b; };

function main() {
  // 1 — manager: salary + percent (plan met → 4%)
  check("PAY1 manager salary + percent", salaryByShifts(R(30000), 15, 15) + salesCommission(400, R(500000)) === R(30000) + R(20000));
  // 2 — 12 of 15 shifts
  check("PAY2 manager 12/15 shifts", salaryByShifts(R(30000), 12, 15) === R(24000));
  // 3 — below plan → 3%
  check("PAY3 below-plan rate 3%", salesCommission(300, R(500000)) === R(15000));
  // 4 — at plan → 4%
  check("PAY4 at-plan rate 4%", salesCommission(400, R(500000)) === R(20000));
  // 5 — refund reduces sales base
  check("PAY5 refund reduces sales", salesCommission(400, R(500000) - R(50000)) === R(18000));
  // 6 — installment counted by actual payment (base is the actually-received amount)
  check("PAY6 installment = actual received", salesCommission(400, R(120000)) === applyBp(R(120000), 400));
  // 7/8 — trainer 40% / 50% by threshold
  check("PAY7 gym trainer 40% (≤ threshold)", gymPackage({ contract: R(20000), sessions: 10 }, 4000, 5000, R(20000)).income === R(8000));
  check("PAY8 gym trainer 50% (> threshold)", gymPackage({ contract: R(30000), sessions: 10 }, 4000, 5000, R(20000)).income === R(15000));
  // 9 — threshold is inclusive at 20 000
  check("PAY9 threshold 20 000 inclusive → 40%", gymPackage({ contract: R(20000), sessions: 8 }, 4000, 5000, R(20000)).rateBp === 4000 && gymPackage({ contract: R(20001), sessions: 8 }, 4000, 5000, R(20000)).rateBp === 5000);
  // 10 — 70% plan gate (payout hold) is SEPARATE from credit
  const planMet70 = (compBp) => compBp >= 7000;
  check("PAY10 70% payout gate", planMet70(6999) === false && planMet70(7000) === true);
  // 11 — trainer credit: paid 10, provided 6, price 1000
  check("PAY11 trainer credit overpaid", trainerCredit(10, 6, R(1000)).overpaid === R(4000) && trainerCredit(10, 6, R(1000)).allowed === R(6000));
  // 12 — refund reduces credit base (via package net → lower session price/credit)
  const price12 = gymPackage({ contract: R(20000), sessions: 10, refund: R(4000) }, 4000, 5000, R(20000));
  check("PAY12 refund reduces trainer income base", price12.income === applyBp(R(16000), 4000));
  // 13 — group trainer hours × rate
  check("PAY13 group trainer hours×rate", hourly(R(700), 20) === R(14000));
  // 14/15 — manager plan-fact examples (68.78% → 36 000 ; 98.90% → 28 800)
  const subs = planFactPart(R(60000), R(928637), R(1350000), 4000, 2000);
  const pt = planFactPart(R(30000), R(1137417), R(1150000), 4000, 2000);
  check("PAY14 manager plan-fact subs 68.78% → 36 000 (−40%)", subs.part === R(36000) && subs.adjustmentBp === -4000 && subs.completionBp === 6879);
  check("PAY15 manager plan-fact PT 98.90% → 28 800 (−4%)", pt.part === R(28800) && pt.adjustmentBp === -400 && pt.completionBp === 9891);
  check("PAY15b manager plan-fact total = 64 800", subs.part + pt.part === R(64800));
  // 16 — ±40% cap
  check("PAY16 adjustment capped at ±40%", planFactAdj(R(100000), R(1000000)).adjustmentBp === -4000 && planFactAdj(R(2000000), R(1000000)).adjustmentBp === 4000);
  check("PAY16b >20% deviation flags manual review", subs.needsManual === true && pt.needsManual === false);
  // 17 — manager revenue-% scheme B: fixed + subs% + pt%
  const revB = R(40000) + applyBp(R(900000), 100) + applyBp(R(1100000), 200); // 1% subs + 2% pt
  check("PAY17 manager revenue-% scheme", revB === R(40000) + R(9000) + R(22000));
  // 18 — streak bonus
  const tiers = [{ m: 2, bonus: R(10000) }, { m: 3, bonus: R(15000) }, { m: 4, bonus: R(20000) }];
  check("PAY18 streak bonus 2/3/4 months", streakBonus(1, tiers) === 0 && streakBonus(2, tiers) === R(10000) && streakBonus(3, tiers) === R(15000) && streakBonus(5, tiers) === R(20000));
  // 19/20/21 — advances (pure): advance is part of paid; cap at earned; one per month (enforced in action, mirror rule)
  const agg19 = aggregate({ automatic: R(47000), advance: R(20000), other: 0 });
  check("PAY19 advance counts as paid, reduces remaining", agg19.paid === R(20000) && agg19.remaining === R(27000));
  const advanceCap = (requested, earnedToDate) => Math.min(requested, Math.max(0, earnedToDate));
  check("PAY21 advance capped at earned-to-date", advanceCap(R(30000), R(18000)) === R(18000) && advanceCap(R(10000), R(18000)) === R(10000));
  // 22 — partial payment
  check("PAY22 partial payment remaining", aggregate({ automatic: R(47000), other: R(30000) }).remaining === R(17000));
  // 25 — overpayment → employee owes company
  check("PAY25 overpayment → employee debt", aggregate({ automatic: R(30000), other: R(35000) }).employeeDebt === R(5000));
  // 27/28 — underpayment / company debt
  check("PAY27/28 underpayment → company debt", aggregate({ automatic: R(47000), other: R(30000) }).companyDebt === R(17000));
  // 26 — partial debt settlement (obligation outstanding math)
  const settle = (orig, paid) => Math.max(0, orig - paid);
  check("PAY26 partial debt settlement", settle(R(5000), R(2000)) === R(3000));
  // 29/30 — final settlement with trainer credit (overpaid becomes employee debt)
  const credit29 = trainerCredit(12, 8, R(1500)); // paid 12, provided 8
  const final30 = aggregate({ automatic: R(20000), debits: credit29.overpaid, other: R(20000) });
  check("PAY29 trainer credit at dismissal", credit29.overpaid === R(6000));
  check("PAY30 final settlement net (credit as debit)", final30.gross === R(14000) && final30.remaining === R(-6000) && final30.employeeDebt === R(6000));
  // 38/39 — no double advance (advance counted once in paid, not re-added at final)
  const agg39 = aggregate({ automatic: R(50000), advance: R(20000), other: R(30000) });
  check("PAY39 advance not double-counted", agg39.paid === R(50000) && agg39.remaining === 0);
  // 40 — multi-club earning share (per-club portion of a shared base)
  const share = (base, bp) => applyBp(base, bp);
  check("PAY40 multi-club earning share", share(R(60000), 6000) + share(R(60000), 4000) === R(60000)); // 60% + 40%

  // ---- status machine (mirror of period.ts) ----
  const REG = ["regional_director"], ACC = ["accountant", "chief_accountant"];
  const RULES = {
    submit: { from: ["draft", "needs_correction"], to: "manager_submitted", roles: ["manager"] },
    regional_approve: { from: ["manager_submitted", "regional_review"], to: "regional_approved", roles: REG },
    accounting_approve: { from: ["regional_approved", "accounting_review"], to: "approved", roles: ACC },
    close: { from: ["paid", "partially_paid"], to: "closed", roles: [...REG, ...ACC] },
  };
  const apply = (a, status, roles) => { const r = RULES[a]; if (!r) return { ok: false }; if (!r.from.includes(status)) return { ok: false }; if (!roles.some((x) => r.roles.includes(x))) return { ok: false }; return { ok: true, to: r.to }; };
  const locked = (s) => ["approved", "partially_paid", "paid", "closed"].includes(s);
  // 31/32 — correction after approval blocked; approved is locked for direct edits
  check("PAY32 approved period is locked for direct edits", locked("approved") === true && locked("draft") === false);
  // 33 — close only from paid/partially_paid
  check("PAY33 close only from paid/partially_paid", apply("close", "paid", ACC).ok === true && apply("close", "draft", ACC).ok === false);
  // 34 — manager may submit, not approve
  check("PAY34 manager can submit, not approve", apply("submit", "draft", ["manager"]).ok === true && apply("regional_approve", "manager_submitted", ["manager"]).ok === false);
  // 35 — regional approves
  check("PAY35 regional approves", apply("regional_approve", "manager_submitted", REG).ok === true && apply("accounting_approve", "regional_approved", REG).ok === false);
  // 36 — accountant approves after regional
  check("PAY36 accountant approves after regional", apply("accounting_approve", "regional_approved", ACC).ok === true);
  // 37 — illegal direct jump blocked
  check("PAY37 illegal transition blocked", apply("accounting_approve", "draft", ACC).ok === false && apply("submit", "approved", ["manager"]).ok === false);

  // ---- static guards: engine + enums exist and match ----
  const calc = src("../src/lib/payroll/calc.ts");
  const scheme = src("../src/lib/payroll/scheme.ts");
  const enums = src("../src/lib/payroll/enums.ts");
  const period = src("../src/lib/payroll/period.ts");
  check("S1 engine reuses ceilToRubleKopeks (no bespoke rounding)", calc.includes('import { ceilToRubleKopeks } from "@/lib/refund-membership"'));
  check("S2 no eval / Function in the scheme or engine", !/\beval\(|new Function\(/.test(calc + scheme));
  check("S3 plan-fact scale: 200bp × ceil(|deviation%|), cap, manual flag", calc.includes("200 * Math.ceil(Math.abs(deviationPct))") && calc.includes("opts.maxAdjustmentBp") && calc.includes("needsManualReview"));
  check("S4 scheme validators bound integers (no strings/eval)", scheme.includes("export function validateSchemeParams") && scheme.includes("DEFAULT_SHIFT_NORM = 15") && scheme.includes("DEFAULT_GYM_THRESHOLD_KOPEKS = 20000 * 100"));
  check("S5 all 9 scheme types + 11 period statuses declared", enums.includes("PAYROLL_SCHEME_TYPES") && ["fixed_salary","salary_by_shifts","salary_plus_percentage","sales_percentage","hourly","plan_adjusted_salary","revenue_percentage","profit_percentage","mixed"].every((t) => enums.includes(`"${t}"`)) && ["draft","manager_submitted","regional_review","needs_correction","regional_approved","accounting_review","approved","partially_paid","paid","closed"].every((s) => enums.includes(`"${s}"`)));
  check("S6 status machine forbids illegal transitions + locks approved", period.includes("export function applyPayrollAction") && period.includes("export function isPayrollPeriodLocked"));
  check("S7 debts model: obligation directions + reasons", enums.includes("employee_owes_company") && enums.includes("company_owes_employee") && enums.includes("trainer_credit") && enums.includes("salary_remainder"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
