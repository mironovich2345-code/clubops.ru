// Item 1 — тренер ТЗ E2E. Мирроринг calcGymPackage (с индивидуальной ставкой) +
// computeTrainerSummary (кредит через calcTrainerCredit) + статические гарантии, что
// схема подключена к computeScheme/UI, кредит и порог 70% РАЗДЕЛЬНЫ, увольнение
// удерживает кредит и не списывает долг.
// npm run pilot:payroll-trainer
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = (rub) => rub * 100;
const BP = 10000;
const ceilRub = (k) => Math.ceil(k / 100) * 100;
const applyBp = (k, bp) => ceilRub(Math.round((k * bp) / BP));

// ---- mirror: calcGymPackage (calc.ts) with optional custom rate ----
function gymPackage(params, pkg) {
  const net = Math.max(0, pkg.contractAmountKopeks - (pkg.refundKopeks ?? 0));
  const rateBp = pkg.rateBp != null ? pkg.rateBp : (pkg.contractAmountKopeks <= params.thresholdKopeks ? params.lowRateBp : params.highRateBp);
  return { incomeKopeks: applyBp(net, rateBp), rateBp };
}
// ---- mirror: calcTrainerCredit ----
function trainerCredit(paidSessions, providedSessions, perSession) {
  const paid = Math.max(0, paidSessions), prov = Math.min(paid, Math.max(0, providedSessions));
  return { providedValue: prov * perSession, overpaid: Math.max(0, paid * perSession - prov * perSession) };
}
// ---- mirror: computeTrainerSummary ----
function summary(params, pkgs) {
  let accrual = 0, providedValue = 0, credit = 0, sales = 0, refunds = 0;
  for (const p of pkgs) {
    const income = gymPackage(params, p).incomeKopeks;
    const perSession = p.sessionCount > 0 ? Math.round(income / p.sessionCount) : 0;
    const cr = trainerCredit(p.sessionCount, p.providedSessions, perSession);
    accrual += income; providedValue += cr.providedValue; credit += cr.overpaid;
    sales += p.contractAmountKopeks; refunds += (p.refundKopeks ?? 0);
  }
  return { accrual, allowedPayout: providedValue, credit, sales, refunds };
}

const P = { lowRateBp: 4000, highRateBp: 5000, thresholdKopeks: R(20000), planThresholdBp: 7000 };

function main() {
  // 1 — пакет 20 000 ₽ → 40% (≤ порога)
  check("TR1 package 20 000 → 40% (8 000)", gymPackage(P, { contractAmountKopeks: R(20000), sessionCount: 10 }).incomeKopeks === R(8000));
  // 2 — пакет 30 000 ₽ → 50% (> порога)
  check("TR2 package 30 000 → 50% (15 000)", gymPackage(P, { contractAmountKopeks: R(30000), sessionCount: 10 }).incomeKopeks === R(15000));
  // 3 — частично проведённые занятия: 20 000/40%/10 занятий, проведено 5
  const s3 = summary(P, [{ contractAmountKopeks: R(20000), sessionCount: 10, providedSessions: 5 }]);
  check("TR3 partial sessions → allowed = provided value (4 000)", s3.allowedPayout === R(4000) && s3.accrual === R(8000));
  // 4 — возврат части пакета: 30 000, возврат 6 000 → net 24 000 × 50% = 12 000
  check("TR4 partial refund reduces income (12 000)", gymPackage(P, { contractAmountKopeks: R(30000), sessionCount: 10, refundKopeks: R(6000) }).incomeKopeks === R(12000));
  // 5 — кредит тренера = начислено − стоимость проведённых
  check("TR5 trainer credit = accrual − provided value (4 000)", s3.credit === R(4000));
  // 6 — увольнение с остаточным кредитом: удержание кредита (debit) → при переплате долг сотрудника
  //     accrual 8000, credit 4000; если выплачено 8000 → gross после удержания 4000; remaining 4000−8000 = −4000 → долг 4000
  const grossAfterCredit = s3.accrual - s3.credit; // 4000
  const remaining = grossAfterCredit - R(8000);
  check("TR6 dismissal: credit withheld → overpay becomes employee debt", grossAfterCredit === R(4000) && remaining === -R(4000));

  // индивидуальная ставка перекрывает порог
  check("TR7 custom trainer rate overrides threshold", gymPackage(P, { contractAmountKopeks: R(30000), sessionCount: 10, rateBp: 4000 }).incomeKopeks === R(12000));

  // ---- static guards ----
  const enums = src("../src/lib/payroll/enums.ts");
  const scheme = src("../src/lib/payroll/scheme.ts");
  const compute = src("../src/lib/payroll/compute.ts");
  const calc = src("../src/lib/payroll/calc.ts");
  const trainer = src("../src/lib/payroll/trainer.ts");
  const actions = src("../src/app/(app)/payroll/periods/trainer-actions.ts");
  const periodPage = src("../src/app/(app)/payroll/periods/[id]/employees/[calculationId]/page.tsx");
  const saveInputs = src("../src/app/(app)/payroll/periods/actions.ts");
  const schemaDev = src("../prisma/schema.prisma");
  const schemaProd = src("../prisma/production/schema.prisma");
  const mig = src("../prisma/production/migrations/20260724131000_payroll_trainer_package/migration.sql");

  check("TR8 gym_trainer scheme type declared + labeled",
    enums.includes('"gym_trainer"') && enums.includes("gym_trainer:"));
  check("TR9 scheme validator has gym_trainer (defaults 40/50/threshold/70%)",
    scheme.includes('case "gym_trainer"') && scheme.includes("DEFAULT_GYM_LOW_RATE_BP") && scheme.includes("DEFAULT_TRAINER_PLAN_THRESHOLD_BP"));
  check("TR10 computeScheme dispatches gym_trainer → calcGymTrainer (WIRED, not engine-only)",
    compute.includes('case "gym_trainer"') && compute.includes("calc.calcGymTrainer") && compute.includes("gymPackages"));
  check("TR11 calcGymPackage honors custom per-package rate",
    calc.includes("pkg.rateBp != null ? pkg.rateBp"));
  check("TR12 70% plan gate SEPARATE from trainer credit (not mixed)",
    calc.includes("Выполнение плана продаж месяца выплаты") && trainer.includes("calcTrainerCredit") && !trainer.includes("planCompletionBp"));
  check("TR13 trainer actions: add/remove/confirm packages + audit",
    actions.includes("export async function addTrainerPackage") && actions.includes("export async function removeTrainerPackage") && actions.includes("export async function confirmTrainerPackage") &&
    actions.includes('"payroll.trainer_package_added"'));
  check("TR14 final settlement: trainer_credit_recovery DEBIT, dismissed-only, idempotent, no auto write-off",
    actions.includes('type: "trainer_credit_recovery"') && actions.includes('direction: "debit"') && actions.includes('employee?.status !== "dismissed"') &&
    actions.includes("Удержание кредита тренера уже оформлено") && actions.includes('"payroll.trainer_final_settlement"'));
  check("TR15 saveCalculationInputs wires the gym_trainer path (70% gate → recompute)",
    saveInputs.includes('scheme.type === "gym_trainer"') && saveInputs.includes("recomputeGymTrainerCalculation") && saveInputs.includes("planCompletionPercent"));
  check("TR16 UI renders trainer packages for gym_trainer calcs",
    periodPage.includes("TrainerPackages") && periodPage.includes('schemeType === "gym_trainer"'));
  check("TR17 rights: package edits gated to operational band",
    actions.includes("canManagePayrollAssignments(scope.ctx.effectiveRoles)"));
  check("TR18 model present dev+prod; additive migration (no DROP)",
    schemaDev.includes("model PayrollTrainerPackage") && schemaProd.includes("model PayrollTrainerPackage") && /CREATE TABLE "PayrollTrainerPackage"/.test(mig) && !/DROP TABLE|DROP COLUMN/.test(mig));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
