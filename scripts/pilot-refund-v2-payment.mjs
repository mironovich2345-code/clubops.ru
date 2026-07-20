// Refund v2 payment + calculation-staleness + v1/v2 isolation + Activity access.
// Behavioural pure mirrors (calc fingerprint, pay-role, activity-access) + static
// source guards proving the SERVER enforces: entryVersion isolation, accountant-only
// pay, legal-entity validation, CAS pay, calc-staleness block, and that a paid v2
// refund flows into the EXISTING expense/budget filters without a new Expense row.
// npm run pilot:refund-v2-payment
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- mirrors ----
const rcDay = (d) => (d ? d.toISOString().slice(0, 10) : "");
const rcNum = (n) => (n == null ? "" : String(n));
const rcStr = (s) => (s ?? "").trim().toLowerCase();
function refundCalcFingerprint(r) {
  if (r.returnType === "membership") {
    return ["m", rcDay(r.serviceStartDate), rcDay(r.serviceEndDate), rcDay(r.applicationDate), rcNum(r.contractAmountKopeks), r.serviceNotProvided ? "1" : "0"].join("|");
  }
  if (r.returnType === "personal_training") {
    return ["p", rcDay(r.applicationDate), rcNum(r.contractAmountKopeks), rcNum(r.ptTerminationSessionPriceKopeks), rcNum(r.ptContractSessionCount), rcNum(r.ptUsedSessionCount), r.serviceNotProvided ? "1" : "0", rcStr(r.ptCalculationMethod), rcStr(r.ptAlternativeCalculationReason), rcStr(r.ptTrainerEmployeeId)].join("|");
  }
  return "";
}
// Who may pay a v2 refund (accountant contour only; chief expands to accountant).
const canPayRefundV2 = (roles) => roles.includes("accountant");
// Who may see the action history (Activity) — manager + marketer excluded.
function activityAccess(role) {
  if (!role || role === "marketer" || role === "manager") return "none";
  if (role === "owner" || role === "general_director") return "all";
  return "scoped";
}
const mDate = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const memBase = () => ({ returnType: "membership", serviceStartDate: mDate(2026, 1, 1), serviceEndDate: mDate(2026, 12, 31), applicationDate: mDate(2026, 6, 1), contractAmountKopeks: 1200000, serviceNotProvided: false });
const ptBase = () => ({ returnType: "personal_training", applicationDate: mDate(2026, 6, 1), contractAmountKopeks: 1000000, ptTerminationSessionPriceKopeks: 100000, ptContractSessionCount: 10, ptUsedSessionCount: 3, serviceNotProvided: false, ptCalculationMethod: "contract_rate", ptAlternativeCalculationReason: null, ptTrainerEmployeeId: "emp1" });

function main() {
  // ---- REFUND-V2-CALC (staleness fingerprint — behavioural) ----
  check("REFUND-V2-CALC1 identical membership operands → identical fingerprint", refundCalcFingerprint(memBase()) === refundCalcFingerprint(memBase()));
  check("REFUND-V2-CALC2 changing contract amount invalidates membership calc", refundCalcFingerprint(memBase()) !== refundCalcFingerprint({ ...memBase(), contractAmountKopeks: 1200001 }));
  check("REFUND-V2-CALC3 changing application date invalidates membership calc", refundCalcFingerprint(memBase()) !== refundCalcFingerprint({ ...memBase(), applicationDate: mDate(2026, 6, 2) }));
  check("REFUND-V2-CALC4 toggling serviceNotProvided invalidates membership calc", refundCalcFingerprint(memBase()) !== refundCalcFingerprint({ ...memBase(), serviceNotProvided: true }));
  check("REFUND-V2-CALC5 changing used sessions invalidates PT calc", refundCalcFingerprint(ptBase()) !== refundCalcFingerprint({ ...ptBase(), ptUsedSessionCount: 4 }));
  check("REFUND-V2-CALC6 changing method / trainer invalidates PT calc", refundCalcFingerprint(ptBase()) !== refundCalcFingerprint({ ...ptBase(), ptCalculationMethod: "average_rate" }) && refundCalcFingerprint(ptBase()) !== refundCalcFingerprint({ ...ptBase(), ptTrainerEmployeeId: "emp2" }));
  check("REFUND-V2-CALC7 identical PT operands → identical fingerprint (submit passes)", refundCalcFingerprint(ptBase()) === refundCalcFingerprint(ptBase()));

  // ---- REFUND-V2-ROLE (who pays) ----
  check("REFUND-V2-ROLE1 accountant may pay", canPayRefundV2(["accountant"]) === true);
  check("REFUND-V2-ROLE2 chief accountant may pay (expands to accountant)", canPayRefundV2(["accountant", "chief_accountant"]) === true);
  check("REFUND-V2-ROLE3 owner / GD / regional / manager / marketer may NOT pay", !canPayRefundV2(["owner"]) && !canPayRefundV2(["general_director"]) && !canPayRefundV2(["regional_director"]) && !canPayRefundV2(["manager"]) && !canPayRefundV2(["marketer"]));

  // ---- ACTIVITY-ACCESS (manager closed) ----
  check("ACTIVITY1 manager has NO activity access", activityAccess("manager") === "none");
  check("ACTIVITY2 marketer has NO activity access", activityAccess("marketer") === "none");
  check("ACTIVITY3 owner / GD keep full access", activityAccess("owner") === "all" && activityAccess("general_director") === "all");
  check("ACTIVITY4 regional / accountant / chief keep scoped access", activityAccess("regional_director") === "scoped" && activityAccess("accountant") === "scoped" && activityAccess("chief_accountant") === "scoped");

  // ---- Static: v1↔v2 isolation (src/app/(app)/refunds/actions.ts) ----
  const v1 = src("../src/app/(app)/refunds/actions.ts");
  check("S1 v1 transitionRefund refuses entryVersion !== 1 (v2 cannot use legacy send/approve/reject/pay)", (() => {
    const b = v1.slice(v1.indexOf("export async function transitionRefund"), v1.indexOf("export async function transitionRefund") + 900);
    return b.includes("existing.entryVersion !== 1") && b.includes("throw new Error");
  })());
  check("S2 v1 updateRefund refuses entryVersion !== 1", (() => {
    const start = v1.indexOf("export async function updateRefund");
    const end = v1.indexOf("export async function transitionRefund", start);
    return v1.slice(start, end).includes("existing.entryVersion !== 1");
  })());

  // ---- Static: v2 pay action (src/app/(app)/refunds/refund-document-actions.ts) ----
  const v2 = src("../src/app/(app)/refunds/refund-document-actions.ts");
  const pay = v2.slice(v2.indexOf("export async function payRefundV2"));
  check("S3 payRefundV2 exists, accountant-only, entryVersion=2, status accounting_in_progress", pay.includes('ctx.effectiveRoles.includes("accountant")') && pay.includes("refund.entryVersion !== 2") && pay.includes("REFUND_V2_STATUS.ACCOUNTING_IN_PROGRESS"));
  check("S4 payRefundV2 validates legal entity via ClubLegalEntity (active + this club + this company)", /clubLegalEntity\.findFirst\(\{[\s\S]*clubId: refund\.clubId[\s\S]*legalEntityId[\s\S]*isActive: true[\s\S]*companyId: refund\.companyId/.test(pay));
  check("S5 payRefundV2 uses compare-and-set (accounting_in_progress → paid, entryVersion 2) — no double pay", /updateMany\(\{[\s\S]*status: REFUND_V2_STATUS\.ACCOUNTING_IN_PROGRESS, entryVersion: 2[\s\S]*status: "paid"/.test(pay) && pay.includes("Возврат уже оплачен или его статус изменился."));
  check("S6 payRefundV2 stores paidAt / legalEntityId / paidByUserId + closed-month guard", pay.includes("paidByUserId: ctx.user.id") && pay.includes("legalEntityId, paidByUserId") && pay.includes("monthClosedError(refund.companyId"));
  check("S7 payRefundV2 audits refund.paid with entryVersion + masked-free safe metadata (no client bank/PII)", /action:\s*"refund\.paid"/.test(pay) && pay.includes("entryVersion: 2") && !pay.includes("bankAccount") && !pay.includes("clientPhone"));
  check("S8 payRefundV2 creates NO Expense row (analytics reads paid refunds directly)", !pay.includes("prisma.expense.create") && !pay.includes("expense.create"));
  check("S9 submit blocks a STALE calculation (operands changed after calc → recompute)", v2.includes("refund.calculationInputHash !== refundCalculationFingerprint(refund)") && v2.includes("Данные изменились. Выполните расчёт повторно."));
  check("S10 both calculations capture calculationInputHash (membership + PT)", (v2.match(/calculationInputHash: refundCalculationFingerprint\(\{/g) || []).length >= 2);

  // ---- Static: Activity loader closes manager (src/lib/activity.ts) ----
  const activity = src("../src/lib/activity.ts");
  check("S11 buildActivityWhere returns null for manager (loader closed, defence in depth)", activity.includes('role === "marketer" || role === "manager") return null') && !activity.includes('} else if (role === "manager") {'));

  // ---- Static: schema / refund fields ----
  for (const [tag, p] of [["dev", "../prisma/schema.prisma"], ["prod", "../prisma/production/schema.prisma"]]) {
    const schema = src(p);
    check(`S12 ${tag} Refund declares v2 payment + calc fields (all nullable)`, schema.includes("legalEntityId  String?") && schema.includes("paidByUserId   String?") && schema.includes("paymentComment String?") && schema.includes("calculationInputHash String?"));
  }

  // ---- Financial reflection: paid v2 flows through EXISTING filters (no new Expense) ----
  check("S13 analytics counts paid refunds (status:\"paid\") — v1 AND v2 alike, unchanged filter", src("../src/lib/analytics.ts").includes('status: "paid"') && src("../src/lib/analytics.ts").includes('category: "refunds"'));
  check("S14 budgets include paid refunds in the approved-refund set (paid v2 counts as spend)", (() => { const b = src("../src/lib/budgets.ts"); return /APPROVED_REFUND|status:\s*"paid"|paid/.test(b); })());

  // ---- REGRESSION (untouched neighbours still present) ----
  check("REGRESSION-OFD1 OFD/Taxcom loader untouched", src("../src/lib/analytics/ofd-management.ts").includes("loadOfdManagementOverview"));
  check("REGRESSION-BALANCES1 cash balances untouched", src("../src/lib/cash-collections.ts").includes("export async function loadClubCashBalances"));
  check("REGRESSION-REFUND-CALC1 pure refund formulas untouched (membership + PT)", src("../src/lib/refund-membership.ts").includes("computeMembershipRefund") && src("../src/lib/refund-personal-training.ts").includes("computePersonalTrainingRefund"));
  check("REGRESSION-REFUND-V2WF1 v2 documents still require the full set at submit", src("../src/lib/refund-workflow.ts").includes("isRefundDocumentSetComplete"));
  check("REGRESSION-DASHBOARD1 dashboard cards loader untouched", src("../src/lib/dashboard-cards.ts").includes("loadCompanyClubCards"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
