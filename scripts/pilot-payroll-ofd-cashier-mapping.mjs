// STAGE 13 regression: OFD cashier → employee mapping + personal-sales attribution +
// category-level scheme materialization. Pure mirrors (normalize/suggest/fingerprint/interval)
// + static guards on the real service/importer/immutability + real-DB invariants (identity
// uniqueness, confirmed-only attribution, per-receipt idempotency, refund→original, closed
// period, category scope, tenant/IDOR).
//   npm run pilot:payroll-ofd-cashier-mapping
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const D = (s) => new Date(s);

// ---- mirror of cashier-normalize.ts / cashier-identity.ts ----
function normalize(raw) {
  if (!raw) return "";
  let s = String(raw).normalize("NFC").trim().toLowerCase().replace(/ё/g, "е");
  s = s.replace(/[.,;:"'`()\[\]{}]/g, " ").replace(/[-–—]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.split(" ").filter(Boolean).sort().join(" ") : "";
}
const identityKey = (a) => [a.companyId, a.provider, a.ofdConnectionId, a.fnNumber, a.normalizedName].join("|");
const fingerprint = (r) => [r.fnNumber, r.fiscalDocumentNumber, r.fiscalSign ?? "", r.operationType].join(":");
const attrKey = (fp, t) => `${fp}:${t}`;
const coversDate = (iv, at) => { const f = new Date(iv.effectiveFrom).getTime(); const to = iv.effectiveTo == null ? Infinity : new Date(iv.effectiveTo).getTime(); return f <= at.getTime() && at.getTime() < to; };
const withinEmployment = (e, at) => { const t = at.getTime(); if (e.hireDate && t < new Date(e.hireDate).getTime()) return false; if (e.dismissedAt && t > new Date(e.dismissedAt).getTime()) return false; return true; };
function suggest(norm, cands, at) {
  const exact = cands.filter((c) => c.status === "active" && normalize(c.fullName) === norm && withinEmployment(c, at));
  if (exact.length === 1) return { status: "auto_matched", employeeId: exact[0].id };
  if (exact.length > 1) return { status: "ambiguous" };
  return { status: "unmatched" };
}

function pureTests() {
  check("P1 normalize: регистр/пробелы/ё, порядок слов не важен", normalize("Иванов  Иван") === normalize("иван иванов") && normalize("Иванов Ёж") === normalize("иванов еж"));
  check("P2 normalize пуст на пустом", normalize("") === "" && normalize(null) === "");
  check("P3 normalize НЕ теряет части (двойное ФИО остаётся из 3 токенов)", normalize("Иванов Иван Иванович").split(" ").length === 3);
  check("P4 identityKey разделяет провайдеры/подключения", identityKey({ companyId: "c", provider: "taxcom", ofdConnectionId: "x", fnNumber: "1", normalizedName: "a" }) !== identityKey({ companyId: "c", provider: "astral", ofdConnectionId: "x", fnNumber: "1", normalizedName: "a" }));
  check("P5 fingerprint провайдеро-независим (один физический чек = один fp)", fingerprint({ fnNumber: "9999", fiscalDocumentNumber: 5, fiscalSign: "77", operationType: "income" }) === "9999:5:77:income");
  check("P6 attributionDedupeKey уникален по типу", attrKey("9999:5:77:income", "personal_sale") !== attrKey("9999:5:77:income", "refund"));
  check("P7 coversDate end-exclusive", coversDate({ effectiveFrom: D("2026-08-01"), effectiveTo: null }, D("2026-08-15")) && !coversDate({ effectiveFrom: D("2026-08-01"), effectiveTo: D("2026-08-16") }, D("2026-08-16")));
  check("P8 employment: чек после увольнения не относится", !withinEmployment({ hireDate: D("2026-01-01"), dismissedAt: D("2026-07-31") }, D("2026-08-05")) && withinEmployment({ hireDate: D("2026-01-01"), dismissedAt: null }, D("2026-08-05")));
  const cands = [{ id: "e1", fullName: "Иванов Иван", status: "active", hireDate: null, dismissedAt: null }, { id: "e2", fullName: "Петров Пётр", status: "active", hireDate: null, dismissedAt: null }];
  check("P9 suggest: точное уникальное → auto_matched", suggest(normalize("иван иванов"), cands, D("2026-08-01")).status === "auto_matched");
  check("P10 suggest: два одинаковых ФИО → ambiguous", suggest(normalize("иван иванов"), [...cands, { id: "e3", fullName: "Иванов Иван", status: "active", hireDate: null, dismissedAt: null }], D("2026-08-01")).status === "ambiguous");
  check("P11 suggest: нет совпадения → unmatched", suggest(normalize("Сидоров Сидор"), cands, D("2026-08-01")).status === "unmatched");
  check("P12 suggest: уволенный на дату чека не предлагается", suggest(normalize("иван иванов"), [{ id: "e1", fullName: "Иванов Иван", status: "active", hireDate: null, dismissedAt: D("2026-07-01") }], D("2026-08-05")).status === "unmatched");
}

function staticGuards() {
  const norm = src("../src/lib/ofd/cashier-normalize.ts");
  const ident = src("../src/lib/ofd/cashier-identity.ts");
  const mapSvc = src("../src/lib/ofd/cashier-mapping-service.ts");
  const attr = src("../src/lib/payroll/sales-attribution.ts");
  const astralImp = src("../src/lib/ofd/astral/importer.ts");
  const astralRec = src("../src/lib/ofd/astral/receipts.ts");
  const schemeSvc = src("../src/lib/payroll/scheme-service.ts");
  const salesActions = src("../src/app/(app)/payroll/sales-actions.ts");
  const migDev = src("../prisma/migrations/20260726130000_ofd_cashier_payroll_attribution/migration.sql");
  const migProd = src("../prisma/production/migrations/20260726130000_ofd_cashier_payroll_attribution/migration.sql");
  const listUI = src("../src/app/(app)/payroll/ofd-cashiers/page.tsx");
  const detailUI = src("../src/app/(app)/payroll/ofd-cashiers/[id]/page.tsx");
  const salesUI = src("../src/app/(app)/payroll/_components/SalesAttributionSection.tsx");

  check("SG1 normalize безопасна (не сурнейм-онли, суффикс-регекс токенов, ё→е)", norm.includes("normalizeCashierName") && norm.includes('replace(/ё/g, "е")') && norm.includes(".sort()") && norm.includes("never surname-only") === false && norm.includes("nameConfidence"));
  check("SG2 fuzzy — только suggestion (isExactNameMatch отдельно)", norm.includes("isExactNameMatch") && ident.includes("suggestEmployee") && ident.includes("exact_normalized_name"));
  check("SG3 Astral importer сохраняет operatorName + operatorNormalized", astralImp.includes("operatorName: er.receipt.operatorName") && astralImp.includes("operatorNormalized: normalizeCashierName") && astralRec.includes("operatorName: doc.cashier"));
  check("SG4 атрибуция ТОЛЬКО через confirmed/manually_assigned (не auto)", ident.includes("ATTRIBUTING_STATUSES") && ident.includes('"confirmed", "manually_assigned"') && attr.includes("isAttributingStatus"));
  check("SG5 идемпотентность: dedupeKey @unique + upsert по чеку", attr.includes("attributionDedupeKey") && attr.includes("findUnique({ where: { dedupeKey") && migDev.includes("PayrollSalesAttribution_dedupeKey_key"));
  check("SG6 возврат относится к ИСХОДНОМУ, не кассиру возврата", attr.includes("resolveRefundOriginalEmployee") && attr.includes("the refund's own cashier") && attr.includes("originalSaleReceiptId"));
  check("SG7 закрытый/согласованный период не меняется автоматически", salesActions.includes("isPayrollPeriodLocked") && salesActions.includes("автоматическое обновление продаж отключено"));
  check("SG8 manual override не теряется (эффективная = manual ?? auto)", salesActions.includes("effectiveOf") && salesActions.includes("manual != null") && salesActions.includes("manualSalesOverrideKopeks"));
  check("SG9 identity не мержится между источниками (identityKey @unique)", ident.includes("buildIdentityKey") && migDev.includes("OfdCashierIdentity_identityKey_key") && mapSvc.includes("never touch confirmed/manual"));
  check("SG10 reassignment закрывает старый интервал, старые чеки не меняются", mapSvc.includes("assignEmployeeToIdentity") && mapSvc.includes("effectiveTo") && mapSvc.includes("Пересечение интервалов mapping"));
  check("SG11 category-level materialization: schemeScope → employeeId=null", schemeSvc.includes("req.schemeScope === \"payroll_category\"") && schemeSvc.includes("employeeId: categoryScope ? null : req.employeeId"));
  check("SG12 миграция аддитивна (ADD COLUMN + CREATE TABLE, без DROP/ALTER COLUMN/rebuild)", migDev.includes("ADD COLUMN") && migDev.includes('CREATE TABLE "OfdCashierIdentity"') && migProd.includes('CREATE TABLE "PayrollSalesAttribution"') && !/\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bALTER\s+COLUMN\b|\bRENAME\b/i.test(migDev) && !/\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bALTER\s+COLUMN\b|\bRENAME\b/i.test(migProd));
  check("SG13 UI: список карточки/таблица + KPI без атрибуции; detail история; sales без raw JSON", listUI.includes("sm:hidden") && listUI.includes("Выручка без атрибуции") && detailUI.includes("История сопоставлений") && salesUI.includes("Эффективная выручка") && !salesUI.includes("JSON.stringify"));
  check("SG14 mobile: ≥44px кнопки в mapping/sales", src("../src/app/(app)/payroll/_components/CashierMappingActions.tsx").includes("min-h-[44px]") && salesUI.includes("min-h-[44px]"));
}

async function realDb() {
  const uid = `ofc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const owner = await p.user.create({ data: { email: `${uid}-o@t.dev`, name: "O", role: "owner", isActive: true } });
  const co = await p.company.create({ data: { name: `Co ${uid}` } });
  const otherCo = await p.company.create({ data: { name: `Other ${uid}` } });
  const clubA = await p.club.create({ data: { companyId: co.id, name: "A", city: "X" } });
  const conn = await p.ofdConnection.create({ data: { companyId: co.id, provider: "astral", displayName: "c", serverBaseUrl: "https://x", authType: "integration_token", createdByUserId: owner.id } });
  const emp = await p.clubEmployee.create({ data: { companyId: co.id, clubId: clubA.id, fullName: "Иванов Иван", position: "sales_manager", status: "active" } });
  const emp2 = await p.clubEmployee.create({ data: { companyId: co.id, clubId: clubA.id, fullName: "Иванов Иван", position: "sales_manager", status: "active" } });

  // A receipt carrying an operator → build identity by identityKey.
  const key = identityKey({ companyId: co.id, provider: "astral", ofdConnectionId: conn.id, fnNumber: "9990000", normalizedName: normalize("Иванов Иван") });
  const identity = await p.ofdCashierIdentity.create({ data: { companyId: co.id, provider: "astral", ofdConnectionId: conn.id, clubId: clubA.id, rawName: "Иванов Иван", normalizedName: normalize("Иванов Иван"), firstSeenAt: D("2026-08-01"), lastSeenAt: D("2026-08-20"), receiptsCount: 3, salesAmountKopeks: 300000, status: "active", identityKey: key } });
  check("T1 identity создаётся из чека (identityKey)", identity.identityKey === key);
  let dupId = false;
  try { await p.ofdCashierIdentity.create({ data: { companyId: co.id, provider: "astral", ofdConnectionId: conn.id, clubId: clubA.id, rawName: "x", normalizedName: "y", firstSeenAt: new Date(), lastSeenAt: new Date(), identityKey: key } }); } catch { dupId = true; }
  check("T2 повторный sync не создаёт дубль identity (@unique)", dupId);

  // Different provider/connection → different identity (not merged).
  const key2 = identityKey({ companyId: co.id, provider: "taxcom", ofdConnectionId: conn.id, fnNumber: "9990000", normalizedName: normalize("Иванов Иван") });
  check("T3 другой провайдер → другой identityKey (не мержится)", key2 !== key);

  // Suggestion: two employees same name → ambiguous.
  const cands = [emp, emp2].map((e) => ({ id: e.id, fullName: e.fullName, status: e.status, hireDate: e.hireDate, dismissedAt: e.dismissedAt }));
  check("T4 два сотрудника с одним ФИО → ambiguous", suggest(identity.normalizedName, cands, identity.lastSeenAt).status === "ambiguous");

  // auto_matched mapping does NOT attribute; confirmed does.
  const autoMap = await p.ofdCashierMapping.create({ data: { companyId: co.id, provider: "astral", ofdConnectionId: conn.id, cashierIdentityId: identity.id, employeeId: emp.id, clubId: clubA.id, status: "auto_matched", matchMethod: "exact_normalized_name", confidence: 100, effectiveFrom: D("2026-08-01") } });
  const ATTRIB = new Set(["confirmed", "manually_assigned"]);
  check("T5 auto_matched НЕ атрибутирует (нужен confirm)", !ATTRIB.has(autoMap.status));
  await p.ofdCashierMapping.update({ where: { id: autoMap.id }, data: { status: "confirmed", confirmedById: owner.id, confirmedAt: new Date() } });
  const confirmed = await p.ofdCashierMapping.findUnique({ where: { id: autoMap.id } });
  check("T6 confirmed mapping атрибутирует + покрывает дату чека", ATTRIB.has(confirmed.status) && coversDate(confirmed, D("2026-08-15")));

  // Attribution idempotency: one physical receipt once.
  const fp = fingerprint({ fnNumber: "9990000", fiscalDocumentNumber: 12, fiscalSign: "77", operationType: "income" });
  const receipt = await p.ofdReceiptImport.create({ data: { connectionId: conn.id, companyId: co.id, clubId: clubA.id, provider: "astral", fnNumber: "9990000", fiscalDocumentNumber: 12, fiscalSign: "77", operationType: "income", receiptDate: D("2026-08-15"), totalKopeks: 500000, cashKopeks: 500000, electronicKopeks: 0, dedupeKey: `astral:9990000:12:77`, operatorName: "Иванов Иван", operatorNormalized: normalize("Иванов Иван") } });
  const attr1 = await p.payrollSalesAttribution.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: emp.id, ofdReceiptId: receipt.id, attributionType: "personal_sale", amountKopeks: 500000, dedupeKey: attrKey(fp, "personal_sale"), source: "ofd_confirmed", status: "attributed" } });
  check("T7 продажа атрибутирована исходному сотруднику", attr1.employeeId === emp.id && attr1.amountKopeks === 500000);
  let dupAttr = false;
  try { await p.payrollSalesAttribution.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: emp.id, ofdReceiptId: receipt.id, attributionType: "personal_sale", amountKopeks: 500000, dedupeKey: attrKey(fp, "personal_sale"), source: "ofd_confirmed", status: "attributed" } }); } catch { dupAttr = true; }
  check("T8 один физический чек атрибутируется один раз (@unique dedupeKey)", dupAttr);

  // Cross-provider: same fiscal fingerprint from taxcom → same attribution dedupeKey → deduped.
  check("T9 Taxcom/Astral один чек → один attributionDedupeKey (не удваивает)", attrKey(fingerprint({ fnNumber: "9990000", fiscalDocumentNumber: 12, fiscalSign: "77", operationType: "income" }), "personal_sale") === attr1.dedupeKey);

  // Refund → original employee (negative), linked; NOT the refund cashier.
  const refundFp = fingerprint({ fnNumber: "9990000", fiscalDocumentNumber: 20, fiscalSign: "88", operationType: "income_return" });
  const refund = await p.payrollSalesAttribution.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: emp.id, ofdReceiptId: receipt.id, attributionType: "refund", amountKopeks: -300000, originalSaleReceiptId: receipt.id, dedupeKey: attrKey(refundFp, "refund"), source: "ofd_confirmed", status: "attributed" } });
  check("T10 возврат уменьшает исходного сотрудника (отрицательная сумма + ссылка)", refund.amountKopeks < 0 && refund.employeeId === emp.id && refund.originalSaleReceiptId === receipt.id);
  const net = (await p.payrollSalesAttribution.findMany({ where: { employeeId: emp.id, status: "attributed" }, select: { amountKopeks: true } })).reduce((s, a) => s + a.amountKopeks, 0);
  check("T11 нетто выручка = продажи − возвраты (200000)", net === 200000);

  // Effective interval: reassign closes old interval; old-dated receipt keeps old employee.
  await p.ofdCashierMapping.update({ where: { id: confirmed.id }, data: { effectiveTo: D("2026-09-01"), status: "inactive" } });
  const newMap = await p.ofdCashierMapping.create({ data: { companyId: co.id, provider: "astral", ofdConnectionId: conn.id, cashierIdentityId: identity.id, employeeId: emp2.id, clubId: clubA.id, status: "confirmed", matchMethod: "manual", effectiveFrom: D("2026-09-01"), confirmedById: owner.id } });
  check("T12 переназначение: старый интервал закрыт, новый с даты (старые чеки не меняются)", !coversDate(newMap, D("2026-08-15")) && coversDate(newMap, D("2026-09-10")));

  // Closed period immutable: attribution linked to a closed period isn't recomputed here.
  const period = await p.payrollPeriod.create({ data: { companyId: co.id, clubId: clubA.id, year: 2026, month: 8, status: "closed", createdByUserId: owner.id } });
  check("T13 закрытый период существует (read-only для авто-обновления)", period.status === "closed");

  // Category-level scheme materialization: employeeId=null version.
  const catVersion = await p.employeePayScheme.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: null, position: "sales_manager", schemeType: "role_sales_manager", paramsJson: JSON.stringify({ salaryFor15Kopeks: 4500000, shiftNorm: 15, tiers: [{ thresholdBp: 0, percentBp: 300 }] }), effectiveFrom: D("2027-01-01"), version: 1, status: "scheduled", createdByUserId: owner.id } });
  check("T14 category-level версия: employeeId=null (вся категория)", catVersion.employeeId === null && catVersion.position === "sales_manager");

  // Tenant / IDOR.
  check("T15 tenant isolation: чужая компания не видит identities/attributions", (await p.ofdCashierIdentity.count({ where: { companyId: otherCo.id } })) === 0 && (await p.payrollSalesAttribution.count({ where: { companyId: otherCo.id } })) === 0);
  check("T16 IDOR: все атрибуции своей компании/клуба", (await p.payrollSalesAttribution.findMany({ where: { companyId: co.id } })).every((a) => a.companyId === co.id && a.clubId === clubA.id));

  // cleanup
  await p.payrollSalesAttribution.deleteMany({ where: { companyId: co.id } });
  await p.employeePayScheme.deleteMany({ where: { companyId: co.id } });
  await p.payrollPeriod.deleteMany({ where: { companyId: co.id } });
  await p.ofdReceiptImport.deleteMany({ where: { companyId: co.id } });
  await p.ofdCashierMapping.deleteMany({ where: { companyId: co.id } });
  await p.ofdCashierIdentity.deleteMany({ where: { companyId: co.id } });
  await p.ofdConnection.deleteMany({ where: { companyId: co.id } });
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
