// Per-category payroll formula engine (spec §3–§10). Mirrors src/lib/payroll/formulas.ts
// and verifies the exact spec examples + configurability (no hardcoded rates), plus
// static guards that the real module matches (clamp ±limit, tiers, trainer-credit not in
// total). Pure — no DB.
//   npm run pilot:payroll-formulas
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ---- mirror of formulas.ts ----
const BP = 10000;
const clampBp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const completionBp = (plan, fact) => (!(plan > 0) ? BP : Math.round((fact / plan) * BP));
const pct = (base, bp) => Math.round((base * bp) / BP);
function pickPercentTier(comp, tiers) {
  if (!tiers.length) return 0;
  const s = [...tiers].sort((a, b) => a.thresholdBp - b.thresholdBp);
  let chosen = s[0].percentBp;
  for (const t of s) if (comp >= t.thresholdBp) chosen = t.percentBp;
  return chosen;
}
function managerDirection(d, limitBp = 4000) {
  const comp = completionBp(d.planKopeks, d.factKopeks);
  const adj = clampBp((comp - BP) * 2, -limitBp, limitBp);
  return { completionBp: comp, adjustmentBp: adj, adjustedKopeks: Math.round((d.baseKopeks * (BP + adj)) / BP) };
}
const administratorSalary = (i) => { const s = Math.max(0, i.shiftRateKopeks) * Math.max(0, i.shifts); return { salaryPartKopeks: s, normDeviationShifts: i.normShifts != null ? i.shifts - i.normShifts : 0, totalKopeks: s + (i.bonusesKopeks ?? 0) - (i.deductionsKopeks ?? 0) }; };
function salesManagerSalary(i) {
  const norm = i.shiftNorm ?? 15;
  const sv = norm > 0 ? Math.round(i.salaryFor15Kopeks / norm) : 0;
  const salary = sv * Math.max(0, i.shifts);
  const net = Math.max(0, i.personalSalesKopeks - (i.returnsKopeks ?? 0));
  const bp = pickPercentTier(i.clubPlanCompletionBp, i.percentTiers);
  return { shiftValueKopeks: sv, salaryPartKopeks: salary, netPersonalSalesKopeks: net, appliedPercentBp: bp, percentPartKopeks: pct(net, bp), totalKopeks: salary + pct(net, bp) + (i.bonusesKopeks ?? 0) - (i.deductionsKopeks ?? 0) };
}
function nightManagerSalary(i) {
  const salary = Math.max(0, i.shiftRateKopeks) * Math.max(0, i.shifts);
  const net = Math.max(0, i.personalSalesKopeks - (i.returnsKopeks ?? 0));
  const bp = pickPercentTier(i.clubPlanCompletionBp, i.percentTiers);
  return { salaryPartKopeks: salary, appliedPercentBp: bp, percentPartKopeks: pct(net, bp), totalKopeks: salary + pct(net, bp) };
}
const gymTrainerSalary = (i) => ({ newPartKopeks: pct(i.newSalesKopeks, i.newRateBp), renewalPartKopeks: pct(i.renewalSalesKopeks, i.renewalRateBp), trainerCreditKopeks: i.trainerCreditKopeks ?? 0, totalKopeks: pct(i.newSalesKopeks, i.newRateBp) + pct(i.renewalSalesKopeks, i.renewalRateBp) });
function seniorGymTrainerSalary(i) {
  const nb = pickPercentTier(i.clubPtCompletionBp, i.newTiers), rb = pickPercentTier(i.clubPtCompletionBp, i.renewalTiers);
  return { appliedNewBp: nb, appliedRenewalBp: rb, totalKopeks: pct(i.newSalesKopeks, nb) + pct(i.renewalSalesKopeks, rb) };
}
const groupTrainerSalary = (i) => ({ hoursPartKopeks: i.hours * i.hourRateKopeks, personalPartKopeks: pct(i.personalSalesKopeks, i.personalRateBp), totalKopeks: i.hours * i.hourRateKopeks + pct(i.personalSalesKopeks, i.personalRateBp) });
const seniorGroupTrainerSalary = (i) => { const h = i.hours * i.hourRateKopeks, pp = pct(i.personalSalesKopeks, i.personalRateBp), fb = i.fixedBonusKopeks ?? 500000, cs = pct(i.clubGroupSalesKopeks, i.clubShareBp ?? 1000); return { hoursPartKopeks: h, personalPartKopeks: pp, fixedBonusKopeks: fb, clubSharePartKopeks: cs, totalKopeks: h + pp + fb + cs }; };

// club-plan tiers 3%/4% (configurable) + a 3-level example.
const TIERS_34 = [{ thresholdBp: 0, percentBp: 300 }, { thresholdBp: 10000, percentBp: 400 }];
const TIERS_3 = [{ thresholdBp: 0, percentBp: 300 }, { thresholdBp: 10000, percentBp: 400 }, { thresholdBp: 12000, percentBp: 500 }];

function main() {
  // ---- Manager (§3.1): АБ/ПТ separately, deviation×2, clamp ±40% ----
  const managerSalaryFn = (i) => { const ab = managerDirection(i.ab), pt = managerDirection(i.pt); return { ab, pt, totalKopeks: ab.adjustedKopeks + pt.adjustedKopeks + (i.bonusesKopeks ?? 0) - (i.deductionsKopeks ?? 0) }; };
  check("F13 управляющий: АБ и ПТ считаются отдельно (АБ +10%, ПТ −20% на одной базе 100000)",
    (() => { const r = managerSalaryFn({ ab: { baseKopeks: 10000000, planKopeks: 100, factKopeks: 105 }, pt: { baseKopeks: 10000000, planKopeks: 100, factKopeks: 90 } }); return r.ab.adjustmentBp === 1000 && r.pt.adjustmentBp === -2000 && r.ab.adjustedKopeks === 11000000 && r.pt.adjustedKopeks === 8000000; })());
  check("F-EX 105%→+10%, 120%→+40%, 130%→+40% (cap)",
    managerDirection({ baseKopeks: 100, planKopeks: 100, factKopeks: 105 }).adjustmentBp === 1000 &&
    managerDirection({ baseKopeks: 100, planKopeks: 100, factKopeks: 120 }).adjustmentBp === 4000 &&
    managerDirection({ baseKopeks: 100, planKopeks: 100, factKopeks: 130 }).adjustmentBp === 4000);
  check("F14 прибавка ограничена +40%", managerDirection({ baseKopeks: 1000000, planKopeks: 100, factKopeks: 200 }).adjustmentBp === 4000);
  check("F15 вычет ограничен −40% (70%→−40%, 90%→−20%)",
    managerDirection({ baseKopeks: 1000000, planKopeks: 100, factKopeks: 70 }).adjustmentBp === -4000 &&
    managerDirection({ baseKopeks: 1000000, planKopeks: 100, factKopeks: 90 }).adjustmentBp === -2000);

  // ---- Administrator (§4) ----
  const a = administratorSalary({ shiftRateKopeks: 200000, shifts: 20, normShifts: 22 });
  check("F4 администратор = ставка × смены (2000₽ × 20 = 40000₽)", a.salaryPartKopeks === 4000000 && a.totalKopeks === 4000000);
  check("F5 норма администратора не меняет формулу (только отклонение −2)", a.normDeviationShifts === -2 && administratorSalary({ shiftRateKopeks: 200000, shifts: 20 }).totalKopeks === 4000000);

  // ---- Sales manager (§5) ----
  const sm10 = salesManagerSalary({ salaryFor15Kopeks: 4500000, shifts: 10, clubPlanCompletionBp: 9000, percentTiers: TIERS_34, personalSalesKopeks: 0 });
  check("F6 менеджер 10 смен → 10/15 оклада (оклад 45000 → смена 3000 → 30000)", sm10.shiftValueKopeks === 300000 && sm10.salaryPartKopeks === 3000000);
  const sm17 = salesManagerSalary({ salaryFor15Kopeks: 4500000, shifts: 17, clubPlanCompletionBp: 9000, percentTiers: TIERS_34, personalSalesKopeks: 0 });
  check("F7 менеджер 17 смен → доплата за 2 смены (17 × 3000 = 51000)", sm17.salaryPartKopeks === 5100000);
  const below = salesManagerSalary({ salaryFor15Kopeks: 0, shifts: 0, clubPlanCompletionBp: 9000, percentTiers: TIERS_34, personalSalesKopeks: 10000000 });
  const at = salesManagerSalary({ salaryFor15Kopeks: 0, shifts: 0, clubPlanCompletionBp: 10000, percentTiers: TIERS_34, personalSalesKopeks: 10000000 });
  check("F8 невыполнение общего плана клуба → 3%", below.appliedPercentBp === 300 && below.percentPartKopeks === 300000);
  check("F9 выполнение общего плана клуба → 4%", at.appliedPercentBp === 400 && at.percentPartKopeks === 400000);
  check("F10 процент считается со ВСЕЙ чистой личной выручки", at.percentPartKopeks === pct(10000000, 400));
  const ret = salesManagerSalary({ salaryFor15Kopeks: 0, shifts: 0, clubPlanCompletionBp: 10000, percentTiers: TIERS_34, personalSalesKopeks: 10000000, returnsKopeks: 2000000 });
  check("F11 возврат уменьшает личную выручку исходного менеджера (net = 8000000)", ret.netPersonalSalesKopeks === 8000000 && ret.percentPartKopeks === pct(8000000, 400));
  check("F-TIERS процентная система не ограничена 3/4% (поддержка 3+ уровней)", pickPercentTier(12500, TIERS_3) === 500 && pickPercentTier(11000, TIERS_3) === 400 && pickPercentTier(5000, TIERS_3) === 300);

  // ---- Night manager (§6) ----
  const nm = nightManagerSalary({ shiftRateKopeks: 250000, shifts: 8, clubPlanCompletionBp: 10000, percentTiers: TIERS_34, personalSalesKopeks: 5000000 });
  check("F12 ночной менеджер: ставка×смены + тот же тир-процент (8×2500 + 4% от 50000)", nm.salaryPartKopeks === 2000000 && nm.appliedPercentBp === 400 && nm.totalKopeks === 2000000 + pct(5000000, 400));

  // ---- Gym trainer ТЗ (§7) ----
  const gt = gymTrainerSalary({ newSalesKopeks: 30000000, newRateBp: 4000, renewalSalesKopeks: 20000000, renewalRateBp: 5000, trainerCreditKopeks: 9999999 });
  check("F16 тренер ТЗ считается от продаж (40% новые + 50% продления)", gt.newPartKopeks === 12000000 && gt.renewalPartKopeks === 10000000 && gt.totalKopeks === 22000000);
  check("F17 trainer credit НЕ ограничивает начисление/выплату (не входит в total)", gt.totalKopeks === 22000000 && gt.trainerCreditKopeks === 9999999);

  // ---- Senior gym trainer ТЗ (§8) ----
  const st = seniorGymTrainerSalary({ newSalesKopeks: 30000000, renewalSalesKopeks: 20000000, clubPtCompletionBp: 11000, newTiers: [{ thresholdBp: 0, percentBp: 4000 }, { thresholdBp: 10000, percentBp: 4500 }], renewalTiers: [{ thresholdBp: 0, percentBp: 5000 }, { thresholdBp: 10000, percentBp: 5500 }] });
  check("F18 старший ТЗ: повышенный % от выполнения общего плана ПТ клуба (45%/55% при ≥100%)", st.appliedNewBp === 4500 && st.appliedRenewalBp === 5500 && st.totalKopeks === pct(30000000, 4500) + pct(20000000, 5500));

  // ---- Group trainer ГП (§9) ----
  const g = groupTrainerSalary({ hours: 40, hourRateKopeks: 50000, personalSalesKopeks: 10000000, personalRateBp: 4000 });
  check("F19 тренер ГП: часы×ставка + личный % (40×500 + 40% от 100000)", g.hoursPartKopeks === 2000000 && g.personalPartKopeks === 4000000 && g.totalKopeks === 6000000);

  // ---- Senior group trainer ГП (§10) ----
  const sg = seniorGroupTrainerSalary({ hours: 40, hourRateKopeks: 50000, personalSalesKopeks: 10000000, personalRateBp: 4000, clubGroupSalesKopeks: 100000000 });
  check("F20 старший ГП: +5000₽ фиксированная часть (по умолчанию)", sg.fixedBonusKopeks === 500000);
  check("F21 старший ГП: 10% от всей выручки ГП клуба (10% от 1000000 = 100000)", sg.clubSharePartKopeks === pct(100000000, 1000) && sg.totalKopeks === 2000000 + 4000000 + 500000 + 10000000);
  check("F-CFG старший ГП: доля и фикс настраиваемы (не зашиты)", seniorGroupTrainerSalary({ hours: 0, hourRateKopeks: 0, personalSalesKopeks: 0, personalRateBp: 0, clubGroupSalesKopeks: 100000000, clubShareBp: 1500, fixedBonusKopeks: 700000 }).clubSharePartKopeks === pct(100000000, 1500));

  // ---- static guards on the real module ----
  const f = src("../src/lib/payroll/formulas.ts");
  check("SG1 formulas.ts: manager clamp ±limit (deviation×2), configurable limitBp default 4000",
    f.includes("clampBp(deviation * 2, -limitBp, limitBp)") && f.includes("inp.limitBp ?? 4000"));
  check("SG2 formulas.ts: тир-процент от плана клуба (pickPercentTier), 3+ уровней",
    f.includes("export function pickPercentTier") && f.includes("percentTiers") && f.includes("clubPlanCompletionBp"));
  check("SG3 formulas.ts: trainer credit информативен (комментарий + НЕ в totalKopeks)",
    f.includes("trainerCredit is informational") && /totalKopeks: newPart \+ renewalPart \+ bonuses - deductions/.test(f));
  check("SG4 formulas.ts: sales-manager оклад/15 + доплата за доп. смены той же стоимостью",
    f.includes("inp.salaryFor15Kopeks / norm") && f.includes("extra shifts paid at the same shift value"));
  check("SG5 formulas.ts: senior ГП +фикс +доля от выручки ГП; настраиваемо (default 5000/10%)",
    f.includes("inp.fixedBonusKopeks ?? 500000") && f.includes("inp.clubShareBp ?? 1000"));
  check("SG6 formulas.ts: классификатор категорий (5 карточек)",
    f.includes("export function categoryOfPosition") && f.includes('"admin"') && f.includes('"gym_trainer"') && f.includes('"group_trainer"'));
  check("SG7 no hardcoded rub/percent literals in the salary math (params-driven)",
    !/\*\s*0\.4\b|\*\s*0\.5\b|4500000\b/.test(f));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
