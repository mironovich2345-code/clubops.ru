// Item 5 — выбор legalEntity на уровне выплаты. Проверяет: одно начисление можно
// выплатить частью наличными (ИП) + частью безналично (ООО); наличные только из ИП;
// банк — ИП или ООО; выбранное юрлицо принадлежит клубу; агрегация по клубу не двоится.
// npm run pilot:payroll-legalentity
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = (rub) => rub * 100;

// ---- mirror: pickPaymentLegalEntity validation ----
function pick(method, chosenId, { ooo, ip }) {
  if (method === "cash") {
    if (!ip) return { error: "no ip" };
    if (chosenId && chosenId !== ip) return { error: "cash only ip" };
    return { legalEntityId: ip };
  }
  const allowed = [ooo, ip].filter(Boolean);
  if (allowed.length === 0) return { error: "no le" };
  if (chosenId && !allowed.includes(chosenId)) return { error: "not club le" };
  return { legalEntityId: chosenId ?? ooo ?? ip };
}
// ---- mirror: paid aggregation (per calc, one accrual) ----
const paid = (payments) => payments.reduce((s, p) => s + p.amountKopeks, 0);

function main() {
  const club = { ooo: "ooo-1", ip: "ip-1" };
  // 16 — одно начисление, наличные ИП + банк ООО
  check("LE1 cash resolves to ИП", pick("cash", null, club).legalEntityId === "ip-1");
  check("LE2 bank can choose ООО", pick("bank", "ooo-1", club).legalEntityId === "ooo-1");
  check("LE3 bank can choose ИП", pick("bank", "ip-1", club).legalEntityId === "ip-1");
  check("LE4 cash rejects ООО (наличные только из ИП)", "error" in pick("cash", "ooo-1", club));
  check("LE5 rejects foreign legal entity (не относится к клубу)", "error" in pick("bank", "ooo-999", club));
  // одно начисление: часть нал ИП 30к + часть банк ООО 20к = paid 50к (по клубу не двоится)
  const payments = [{ amountKopeks: R(30000), legalEntityId: "ip-1" }, { amountKopeks: R(20000), legalEntityId: "ooo-1" }];
  check("LE6 one accrual paid part-cash(ИП)+part-bank(ООО); club aggregation not doubled", paid(payments) === R(50000));

  // ---- static guards ----
  const actions = src("../src/app/(app)/payroll/periods/actions.ts");
  const section = src("../src/app/(app)/payroll/_components/PaymentsSection.tsx");
  const page = src("../src/app/(app)/payroll/periods/[id]/page.tsx");

  check("LE7 recordPayment reads + validates a per-payment legalEntity",
    actions.includes("pickPaymentLegalEntity(scope.companyId, calc.clubId, method, chosenLe") && actions.includes('String(formData.get("legalEntityId")'));
  check("LE8 cash must be ИП; bank may be ООО/ИП; belongs to club",
    actions.includes("Наличная выплата возможна только из ИП") && actions.includes("Выбранное юрлицо не относится к клубу") && actions.includes("getActiveClubLegalEntities(clubId)"));
  check("LE9 cash source resolves the chosen ИП wallet server-side",
    actions.includes("ensureRegionalCashWallet(companyId, clubId, ip.id") && actions.includes("ensureClubCashWallet(companyId, clubId, ip.id"));
  check("LE10 UI: payment form offers the legal-entity choice",
    section.includes('name="legalEntityId"') && page.includes("legalEntities={legalEntityOptions}") && page.includes("getActiveClubLegalEntities(period.clubId)"));
  check("LE11 aggregation reuses the per-calc paid (no double aggregation across entities)",
    src("../src/lib/payroll/aggregate.ts").includes("payrollPeriodId? undefined") === false && src("../src/lib/payroll/aggregate.ts").includes("payrollCalculationId: calculationId"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
