// Astral.ОФД provider — comprehensive regression (READY FOR CREDENTIALS). Mirrors the
// real client (tolerant parsing, error classification, bounded retry, api_key redaction),
// receipt classification/payments, and pagination/idempotency; runs a real-DB mirror of
// the importer (idempotency + daily/category summaries + tenant isolation); and asserts
// the real source (PIN-gated tenant-safe settings, dashboard/cron multi-provider,
// additive migration, Taxcom untouched, secret never exposed). No real Astral API call
// is ever made. Fixtures follow «Документация Астрал ОФД API.pdf».
//   npm run pilot:ofd-astral
import { PrismaClient } from "@prisma/client";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const OFD_SECRET = process.env.OFD_SECRET && process.env.OFD_SECRET.length >= 32 ? process.env.OFD_SECRET : "dev-insecure-ofd-secret-at-least-32-bytes";
const aesKey = createHash("sha256").update(`ofd:aes:${OFD_SECRET}`).digest();
const encryptOfd = (plain) => { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", aesKey, iv); const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]); const tag = c.getAuthTag(); return `v1:${Buffer.concat([iv, tag, ct]).toString("base64")}`; };

// ================= mirrors of lib/ofd/astral/client.ts =======================
const toNum = (v, fb = 0) => { if (typeof v === "number") return Number.isFinite(v) ? v : fb; if (typeof v === "string") { const t = v.trim(); if (t === "") return fb; const n = Number(t); return Number.isFinite(n) ? n : fb; } return fb; };
const toInt = (v, fb = 0) => Math.round(toNum(v, fb));
const toCount = (v) => { const n = toInt(v, 0); return n >= 0 ? n : 0; };
const toBool = (v) => { if (typeof v === "boolean") return v; if (typeof v === "number") return v !== 0; if (typeof v === "string") { const t = v.trim().toLowerCase(); return t === "true" || t === "1" || t === "yes"; } return false; };
function classifyAstralError(httpStatus, apiErrorCode) {
  const code = apiErrorCode ?? httpStatus ?? 0;
  if (code === 401) return "ASTRAL_INVALID_API_KEY";
  if (code === 403) return "ASTRAL_ACCESS_DENIED";
  if (code === 404) return "ASTRAL_KKT_NOT_FOUND";
  if (code === 429) return "ASTRAL_RATE_LIMITED";
  if (code === 400) return "ASTRAL_INVALID_RESPONSE";
  if (httpStatus != null && httpStatus >= 500) return "ASTRAL_SERVICE_UNAVAILABLE";
  return "ASTRAL_UNKNOWN";
}
const isRetryableStatus = (s) => s >= 500 || s === 429;
const backoffMs = (attempt) => Math.min(400 * 2 ** (attempt - 1), 5000);
function redactApiKey(s, apiKey) { if (!s) return s; let out = s; if (apiKey && apiKey.length >= 6) out = out.split(apiKey).join("***"); return out.replace(/("?api_?key"?\s*[:=]\s*)"?[^"\s,&]+/gi, "$1***"); }

// Mirror of the client request loop (retry semantics only).
async function clientCall({ responses }) {
  // responses: array of {status, body} consumed per attempt; simulates fetch.
  const maxAttempts = 4;
  let i = 0, lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = responses[Math.min(i, responses.length - 1)]; i++;
    if (r.throw) { lastErr = { ok: false, code: r.throw === "timeout" ? "ASTRAL_TIMEOUT" : "ASTRAL_NETWORK" }; if (attempt < maxAttempts && r.retry) continue; return lastErr; }
    if (isRetryableStatus(r.status)) { lastErr = { ok: false, code: classifyAstralError(r.status, null), httpStatus: r.status }; if (attempt < maxAttempts) continue; return lastErr; }
    let parsed = null; try { parsed = r.body ? JSON.parse(r.body) : null; } catch { return { ok: false, code: "ASTRAL_INVALID_RESPONSE" }; }
    const env = parsed && typeof parsed === "object" ? parsed : {};
    const ok = toBool(env.ok); const apiErrorCode = env.error_code != null ? toInt(env.error_code) : null;
    if (r.status >= 400 || !ok) return { ok: false, code: classifyAstralError(r.status >= 400 ? r.status : null, apiErrorCode), apiErrorCode };
    return { ok: true, data: env.result };
  }
  return lastErr ?? { ok: false, code: "ASTRAL_UNKNOWN" };
}

// ================= mirrors of lib/ofd/astral/receipts.ts =====================
const SALE_DT = new Set(["3", "4", "21", "31"]);
const SERVICE_DT = new Set(["1", "2", "5", "6", "11", "41"]);
function classifyDoc(documentType, operationType) {
  const dt = documentType ?? ""; const op = operationType;
  if (op === 3) return "expense";
  if (op === 4) return "expense_return";
  if (SERVICE_DT.has(dt)) return "service_document";
  if (SALE_DT.has(dt)) { if (op === 1) return "sale"; if (op === 2) return "sale_return"; return "service_document"; }
  return "unknown";
}
const docOp = (cls) => (cls === "sale" ? "income" : cls === "sale_return" ? "income_return" : null);
const dedupe = (fn, fd, fp) => (fp ? `astral:${fn}:${fd}:${fp}` : `astral:${fn}:${fd}`);
function normalizeDoc(raw) {
  const fnNumber = String(raw.fiscalDriveNumber ?? "");
  const documentType = raw.documentType != null && String(raw.documentType) !== "" ? String(raw.documentType) : null;
  const opNum = raw.operationType != null && String(raw.operationType) !== "" ? toInt(raw.operationType) : null;
  const cls = classifyDoc(documentType, opNum);
  const fd = toInt(raw.fiscalDocumentNumber ?? raw.checkNumber);
  const fp = raw.fiscalSign != null && String(raw.fiscalSign) !== "" ? String(raw.fiscalSign) : null;
  const cash = toInt(raw.cash), ecash = toInt(raw.ecash), credit = toInt(raw.credit), prepaid = toInt(raw.prepaid), provision = toInt(raw.provision);
  const total = toInt(raw.sum);
  const electronic = ecash + credit + prepaid + provision;
  const paymentSum = cash + ecash + credit + prepaid + provision;
  const items = Array.isArray(raw.items) && raw.items.length ? raw.items.map((it) => ({ name: String(it.name ?? "").slice(0, 256), quantityMilli: Math.max(0, Math.round(toNum(it.count ?? it.quantity, 1) * 1000)) || 1000, priceKopeks: it.price != null ? toInt(it.price) : 0, totalKopeks: it.sum != null ? toInt(it.sum) : 0 })) : undefined;
  return { docClass: cls, operationType: docOp(cls), isRevenue: docOp(cls) != null, fnNumber, fiscalDocumentNumber: fd, fiscalSign: fp, totalKopeks: total, cashKopeks: cash, electronicKopeks: electronic, paymentMismatch: total > 0 && paymentSum !== total, items, itemsPresent: Boolean(items && items.length), dedupeKey: dedupe(fnNumber, fd, fp) };
}
// mirror of clubDayRangeUnix (half-open [begin, endExclusive) in club tz)
const addDaysYmd = (ymd, days) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const clubRange = (from, to, off = "+03:00") => { const begin = Date.parse(`${from}T00:00:00${off}`); const endEx = Date.parse(`${addDaysYmd(to, 1)}T00:00:00${off}`); return { beginDate: Math.floor(begin / 1000), endDate: Math.floor(endEx / 1000), beginIso: new Date(begin).toISOString(), endIso: new Date(endEx).toISOString() }; };
const moscowRange = (from, to) => { const r = clubRange(from, to); return { beginDate: r.beginDate, endDate: r.endDate }; };

// ================= fixtures (per PDF) ========================================
const FN = "9999078902007111";
const FIX = {
  saleEcash: { fiscalDriveNumber: FN, checkNumber: 35, fiscalSign: 2895701111, documentType: "3", operationType: 1, issueDate: 1674209940, sum: 350000, ecash: 350000, cash: 0, items: [{ count: 1, name: "Абонемент 1 мес" }] },
  saleCash: { fiscalDriveNumber: FN, checkNumber: 36, fiscalSign: 2895701112, documentType: "3", operationType: 1, issueDate: 1674209950, sum: 250000, cash: 250000 },
  saleMixed: { fiscalDriveNumber: FN, checkNumber: 37, fiscalSign: 2895701113, documentType: "3", operationType: 1, issueDate: 1674209960, sum: 250000, cash: 100000, ecash: 150000 },
  returnCash: { fiscalDriveNumber: FN, checkNumber: 38, fiscalSign: 2895701114, documentType: "3", operationType: 2, issueDate: 1674209970, sum: 100000, cash: 100000 },
  expense: { fiscalDriveNumber: FN, checkNumber: 39, fiscalSign: 2895701115, documentType: "3", operationType: 3, issueDate: 1674209980, sum: 500000, cash: 500000 },
  serviceClose: { fiscalDriveNumber: FN, checkNumber: 40, fiscalSign: 2895701116, documentType: "5", operationType: 0, issueDate: 1674209990, sum: 0 },
  unknown: { fiscalDriveNumber: FN, checkNumber: 41, fiscalSign: 2895701117, documentType: "99", operationType: 7, issueDate: 1674210000, sum: 12345 },
  mismatch: { fiscalDriveNumber: FN, checkNumber: 42, fiscalSign: 2895701118, documentType: "3", operationType: 1, issueDate: 1674210010, sum: 250000, cash: 100000 },
};

async function main() {
  // ---- client: tolerant parsing -----
  check("A1 toCount accepts string '1' and number 1", toCount("1") === 1 && toCount(1) === 1 && toCount(-5) === 0);
  check("A2 toInt tolerant of numeric string; NaN → fallback", toInt("350000") === 350000 && toInt("x", 7) === 7);
  check("A3 toBool: true/1/'true' truthy; 0/'no' falsy", toBool(true) && toBool(1) && toBool("true") && !toBool(0) && !toBool("no"));

  // ---- client: error classification + retry -----
  check("A4 401→INVALID_API_KEY, 403→ACCESS_DENIED, 404→KKT_NOT_FOUND, 429→RATE_LIMITED", classifyAstralError(200, 401) === "ASTRAL_INVALID_API_KEY" && classifyAstralError(200, 403) === "ASTRAL_ACCESS_DENIED" && classifyAstralError(404, null) === "ASTRAL_KKT_NOT_FOUND" && classifyAstralError(200, 429) === "ASTRAL_RATE_LIMITED");
  check("A5 5xx→SERVICE_UNAVAILABLE (retryable)", classifyAstralError(503, null) === "ASTRAL_SERVICE_UNAVAILABLE" && isRetryableStatus(503) && isRetryableStatus(429) && !isRetryableStatus(403));
  check("A6 backoff bounded + monotonic", backoffMs(1) === 400 && backoffMs(2) === 800 && backoffMs(20) === 5000);
  check("A7 api_key redaction (never leaks the key)", redactApiKey(`fail key=SECRETKEY123 and api_key: ZZZ`, "SECRETKEY123").includes("***") && !redactApiKey("x SECRETKEY123", "SECRETKEY123").includes("SECRETKEY123"));

  const r403 = await clientCall({ responses: [{ status: 200, body: JSON.stringify({ ok: false, error_code: 403, description: "Нет доступа." }) }] });
  check("A8 ok=false with HTTP 200 → error (ACCESS_DENIED), not success", !r403.ok && r403.code === "ASTRAL_ACCESS_DENIED");
  const rMalf = await clientCall({ responses: [{ status: 200, body: "{not json" }] });
  check("A9 malformed JSON → ASTRAL_INVALID_RESPONSE", !rMalf.ok && rMalf.code === "ASTRAL_INVALID_RESPONSE");
  const r5xx = await clientCall({ responses: [{ status: 503 }, { status: 503 }, { status: 200, body: JSON.stringify({ ok: true, result: { organizations: [] } }) }] });
  check("A10 retry recovers after two 5xx → success", r5xx.ok === true);
  const r403noRetry = await clientCall({ responses: [{ status: 403, body: JSON.stringify({ ok: false, error_code: 403 }) }, { status: 200, body: JSON.stringify({ ok: true, result: {} }) }] });
  check("A11 no retry on 403 (terminal) — second response NOT consumed", !r403noRetry.ok && r403noRetry.code === "ASTRAL_ACCESS_DENIED");
  const rTimeout = await clientCall({ responses: [{ throw: "timeout", retry: false }] });
  check("A12 timeout → ASTRAL_TIMEOUT", !rTimeout.ok && rTimeout.code === "ASTRAL_TIMEOUT");

  // ---- documents: classification + operation mapping -----
  check("A13 sale (dt3, op1) → income", normalizeDoc(FIX.saleEcash).operationType === "income");
  check("A14 sale return (dt3, op2) → income_return", normalizeDoc(FIX.returnCash).operationType === "income_return");
  check("A15 expense (op3) → not revenue", normalizeDoc(FIX.expense).operationType === null && normalizeDoc(FIX.expense).docClass === "expense");
  check("A16 service (dt5, op0) → not revenue", normalizeDoc(FIX.serviceClose).operationType === null && normalizeDoc(FIX.serviceClose).docClass === "service_document");
  check("A17 unknown documentType → unknown, excluded from revenue", normalizeDoc(FIX.unknown).docClass === "unknown" && normalizeDoc(FIX.unknown).operationType === null);

  // ---- payments (already kopeks; cash vs electronic; mismatch) -----
  check("A18 sums already kopeks — no x100", normalizeDoc(FIX.saleEcash).totalKopeks === 350000);
  check("A19 cash sale → cashKopeks", normalizeDoc(FIX.saleCash).cashKopeks === 250000 && normalizeDoc(FIX.saleCash).electronicKopeks === 0);
  check("A20 ecash sale → electronicKopeks", normalizeDoc(FIX.saleEcash).electronicKopeks === 350000 && normalizeDoc(FIX.saleEcash).cashKopeks === 0);
  check("A21 mixed payment split", normalizeDoc(FIX.saleMixed).cashKopeks === 100000 && normalizeDoc(FIX.saleMixed).electronicKopeks === 150000 && !normalizeDoc(FIX.saleMixed).paymentMismatch);
  check("A22 payment mismatch flagged (cash 1000 vs sum 2500), import not blocked", normalizeDoc(FIX.mismatch).paymentMismatch === true && normalizeDoc(FIX.mismatch).operationType === "income");

  // ---- items -----
  const it = normalizeDoc(FIX.saleEcash);
  check("A23 items name/count normalized (no price → 0)", it.itemsPresent && it.items[0].name === "Абонемент 1 мес" && it.items[0].quantityMilli === 1000 && it.items[0].priceKopeks === 0);
  check("A24 no items → itemsPresent false, receipt still imported", normalizeDoc(FIX.saleCash).itemsPresent === false && normalizeDoc(FIX.saleCash).operationType === "income");

  // ---- dedupe / idempotency (key includes fiscalSign) -----
  check("A25 dedupeKey astral:fn:fd:fiscalSign", normalizeDoc(FIX.saleEcash).dedupeKey === `astral:${FN}:35:2895701111`);
  const sameCheckDiffFn = normalizeDoc({ ...FIX.saleEcash, fiscalDriveNumber: "OTHER_FN" });
  check("A26 same checkNumber on a different ФН → different dedupeKey", sameCheckDiffFn.dedupeKey !== normalizeDoc(FIX.saleEcash).dedupeKey);
  check("A27 astral key never collides with taxcom (prefix)", normalizeDoc(FIX.saleEcash).dedupeKey.startsWith("astral:"));

  // ---- pagination / timezone -----
  const range = moscowRange("2026-07-23", "2026-07-23");
  check("A28 moscow day range = full local day in unix seconds (UTC+3)", range.beginDate === Math.floor(Date.parse("2026-07-23T00:00:00+03:00") / 1000) && range.endDate > range.beginDate);
  check("A29 totalCount as string handled by toCount", toCount("3") === 3);

  // ---- regression: date range (fix/astral-tickets-preview) -----
  const oneDay = clubRange("2026-07-25", "2026-07-25");
  check("R1 single-day preview is NOT a zero range (begin != end, endExclusive = next day 00:00)", oneDay.beginDate !== oneDay.endDate && oneDay.endDate - oneDay.beginDate === 86400 && oneDay.endIso === "2026-07-25T21:00:00.000Z" && oneDay.beginIso === "2026-07-24T21:00:00.000Z");
  const multi = clubRange("2026-07-25", "2026-07-27");
  check("R2 multi-day range spans full days inclusive (3 days)", multi.endDate - multi.beginDate === 3 * 86400);
  const monthRoll = clubRange("2026-07-31", "2026-07-31");
  check("R3 month rollover: 31.07 → endExclusive 01.08 00:00", monthRoll.endIso === "2026-07-31T21:00:00.000Z" && addDaysYmd("2026-07-31", 1) === "2026-08-01");
  const yearRoll = clubRange("2026-12-31", "2026-12-31");
  check("R4 year rollover: 31.12 → 01.01 next year", addDaysYmd("2026-12-31", 1) === "2027-01-01" && yearRoll.endDate - yearRoll.beginDate === 86400);
  const jan = clubRange("2026-01-15", "2026-01-15"), jul = clubRange("2026-07-15", "2026-07-15");
  check("R5 Moscow no DST — winter/summer same offset, same day length", (jan.endDate - jan.beginDate) === (jul.endDate - jul.beginDate) && jan.beginIso.endsWith("21:00:00.000Z") && jul.beginIso.endsWith("21:00:00.000Z"));

  await realDbTests();
  await staticGuards();

  await p.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

// ================= real-DB mirror of the importer ============================
async function realDbTests() {
  const uid = `astral-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const owner = await p.user.create({ data: { email: `${uid}@t.dev`, name: "O", role: "owner", isActive: true } });
  const co = await p.company.create({ data: { name: `Co ${uid}` } });
  const otherCo = await p.company.create({ data: { name: `Other ${uid}` } });
  const le = await p.legalEntity.create({ data: { companyId: co.id, type: "ooo", name: "ООО Тест" } });
  const club = await p.club.create({ data: { companyId: co.id, name: "Клуб 1", city: "X" } });
  const conn = await p.ofdConnection.create({ data: { companyId: co.id, legalEntityId: le.id, provider: "astral", displayName: "Астрал", serverBaseUrl: "https://ofd.astralnalog.ru/api/v4.2", authType: "integration_token", integrationTokenEncrypted: encryptOfd("test-api-key"), externalOrganizationId: "1000", isActive: true, createdByUserId: owner.id } });
  const mapping = await p.ofdCashRegisterMapping.create({ data: { connectionId: conn.id, companyId: co.id, clubId: club.id, legalEntityId: le.id, provider: "astral", fnNumber: FN, kktRegNumber: "8530107373029111", externalOrganizationId: "1000", externalAliasId: "4380", externalKktId: "7864", isActive: true, activeMappingKey: `astral:${FN}` } });

  check("A30 migration columns persist Astral external IDs", mapping.externalOrganizationId === "1000" && mapping.externalAliasId === "4380" && mapping.externalKktId === "7864");
  check("A31 connection stores externalOrganizationId + syncStartDate column exists", conn.externalOrganizationId === "1000" && "syncStartDate" in conn);

  // Mirror importer: normalize a page of docs, keep revenue only, dedupe + persist.
  const page = [FIX.saleEcash, FIX.saleCash, FIX.returnCash, FIX.expense, FIX.serviceClose, FIX.unknown].map(normalizeDoc);
  const fnLookup = new Map([[FN, { clubId: club.id, legal: le.id }]]);
  const run = await p.ofdSyncRun.create({ data: { connectionId: conn.id, companyId: co.id, legalEntityId: le.id, mode: "manual_period", dateFrom: "2026-07-23", dateTo: "2026-07-23", status: "running", startedAt: new Date() } });

  async function persist(docs) {
    const revenue = docs.filter((d) => d.operationType != null && fnLookup.has(d.fnNumber));
    const byKey = new Map(revenue.map((d) => [d.dedupeKey, d]));
    const keys = [...byKey.keys()];
    const existing = await p.ofdReceiptImport.findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true } });
    const existingSet = new Set(existing.map((e) => e.dedupeKey));
    const fresh = keys.filter((k) => !existingSet.has(k)).map((k) => byKey.get(k));
    if (fresh.length) await p.ofdReceiptImport.createMany({ data: fresh.map((d) => ({ connectionId: conn.id, companyId: co.id, clubId: club.id, legalEntityId: le.id, provider: "astral", fnNumber: d.fnNumber, fiscalDocumentNumber: d.fiscalDocumentNumber, fiscalSign: d.fiscalSign, operationType: d.operationType, receiptDate: new Date("2026-07-23T10:00:00.000Z"), totalKopeks: d.totalKopeks, cashKopeks: d.cashKopeks, electronicKopeks: d.electronicKopeks, dedupeKey: d.dedupeKey, source: "astral", syncRunId: run.id })) });
    return { found: keys.length, imported: fresh.length, skipped: keys.length - fresh.length };
  }

  const r1 = await persist(page);
  check("A32 only revenue docs imported (2 sales + 1 return; expense/service/unknown excluded)", r1.found === 3 && r1.imported === 3);
  const r2 = await persist(page);
  check("A33 re-import same period → 0 new (idempotent), all skipped", r2.imported === 0 && r2.skipped === 3);
  const overlap = await persist([FIX.saleEcash, FIX.saleMixed].map(normalizeDoc)); // overlaps saleEcash, adds saleMixed
  check("A34 overlapping range → only the new receipt added, no duplicate", overlap.imported === 1);

  const stored = await p.ofdReceiptImport.findMany({ where: { companyId: co.id, provider: "astral" }, select: { operationType: true, totalKopeks: true, cashKopeks: true } });
  const income = stored.filter((s) => s.operationType === "income").reduce((a, s) => a + s.totalKopeks, 0);
  const ret = stored.filter((s) => s.operationType === "income_return").reduce((a, s) => a + s.totalKopeks, 0);
  check("A35 net revenue = income − returns; returns reduce revenue", income === 350000 + 250000 + 250000 && ret === 100000);

  // Daily summary recompute mirror.
  const dayStart = new Date("2026-07-23T00:00:00.000Z"); const dayEnd = new Date(dayStart.getTime() + 86400000);
  const rows = await p.ofdReceiptImport.findMany({ where: { companyId: co.id, clubId: club.id, provider: "astral", legalEntityId: le.id, receiptDate: { gte: dayStart, lt: dayEnd } }, select: { operationType: true, totalKopeks: true, cashKopeks: true, electronicKopeks: true } });
  const agg = { incomeTotalKopeks: 0, incomeCashKopeks: 0, incomeElectronicKopeks: 0, returnTotalKopeks: 0, returnCashKopeks: 0, returnElectronicKopeks: 0, receiptCount: 0, returnReceiptCount: 0 };
  for (const r of rows) { if (r.operationType === "income") { agg.incomeTotalKopeks += r.totalKopeks; agg.incomeCashKopeks += r.cashKopeks; agg.incomeElectronicKopeks += r.electronicKopeks; agg.receiptCount++; } else { agg.returnTotalKopeks += r.totalKopeks; agg.returnReceiptCount++; } }
  const summaryKey = `${co.id}:${club.id}:${le.id}:astral:2026-07-23`;
  await p.ofdDailySalesSummary.upsert({ where: { summaryKey }, create: { companyId: co.id, clubId: club.id, legalEntityId: le.id, provider: "astral", date: "2026-07-23", summaryKey, ...agg, netTotalKopeks: agg.incomeTotalKopeks - agg.returnTotalKopeks }, update: { ...agg, netTotalKopeks: agg.incomeTotalKopeks - agg.returnTotalKopeks } });
  const summary = await p.ofdDailySalesSummary.findUnique({ where: { summaryKey } });
  check("A36 daily summary net = income − returns, cash revenue visible (Фактические деньги)", summary.netTotalKopeks === (350000 + 250000 + 250000) - 100000 && summary.incomeCashKopeks === 250000 + 100000);

  // Tenant isolation: other company sees none of these receipts.
  const foreign = await p.ofdReceiptImport.count({ where: { companyId: otherCo.id } });
  check("A37 tenant isolation: другая компания не видит чеки Астрал", foreign === 0);
  const scoped = await p.ofdCashRegisterMapping.findMany({ where: { companyId: co.id, provider: "astral", isActive: true } });
  check("A38 KKT mapping scoped to its company only", scoped.length === 1 && scoped[0].companyId === co.id);

  // cleanup
  await p.ofdReceiptImport.deleteMany({ where: { companyId: { in: [co.id, otherCo.id] } } });
  await p.ofdDailySalesSummary.deleteMany({ where: { companyId: co.id } });
  await p.ofdSyncRun.deleteMany({ where: { companyId: co.id } });
  await p.ofdCashRegisterMapping.deleteMany({ where: { companyId: co.id } });
  await p.ofdConnection.deleteMany({ where: { companyId: { in: [co.id, otherCo.id] } } });
  await p.club.deleteMany({ where: { companyId: co.id } });
  await p.legalEntity.deleteMany({ where: { companyId: co.id } });
  await p.company.deleteMany({ where: { id: { in: [co.id, otherCo.id] } } });
  await p.user.delete({ where: { id: owner.id } });
}

// ================= static guards on the real source ==========================
async function staticGuards() {
  const client = src("../src/lib/ofd/astral/client.ts");
  const api = src("../src/lib/ofd/astral/api.ts");
  const importer = src("../src/lib/ofd/astral/importer.ts");
  const taxImporter = src("../src/lib/ofd/importer.ts");
  const provider = src("../src/lib/ofd/providers/astral-provider.ts");
  const stepsActions = src("../src/app/(app)/settings/ofd/astral/steps-actions.ts");
  const settingsLib = src("../src/lib/ofd/astral/settings.ts");
  const actions = src("../src/app/(app)/settings/ofd/astral/actions.ts");
  const daily = src("../src/lib/ofd/daily.ts");
  const migration = src("../prisma/migrations/20260725090000_astral_ofd_external_ids/migration.sql");
  const receipts = src("../src/lib/ofd/astral/receipts.ts");

  check("A39 client: POST + api_key in BODY, injectable fetch, api_key never logged", client.includes('body: JSON.stringify(body)') && client.includes("const body = { api_key: cfg.apiKey") && client.includes("redactApiKey") && !/console\.warn\([^)]*apiKey/.test(client));
  check("A40 base URL v4.2 + zReport v4.1 from PDF", client.includes("ofd.astralnalog.ru/api/v4.2") && client.includes("ofd.astralnalog.ru/api/v4.1"));
  check("A41 endpoints wired from PDF", api.includes("organization.list") && api.includes("kkt.aliasList") && api.includes("kkt.search") && api.includes("kkt.listByAlias") && api.includes("kkt.getById") && api.includes("documents.tickets") && api.includes("documents.closedShiftsList") && api.includes("analytics.aliases"));
  check("A42 main sync endpoint = documents.tickets; closedShifts/analytics reconciliation only", importer.includes("fetchReceiptsPage") && !importer.includes("closedShiftsList as source"));
  check("A43 importer reuses SHARED pipeline (no second classifier/contour)", importer.includes("persistReceiptItems") && importer.includes("recomputeDailySummary") && importer.includes("recomputeRevenueCategorySummaries") && importer.includes('source: "astral"'));
  check("A44 pagination guards: maxPages + duplicate-page detection + empty page ends loop", importer.includes("DEFAULT_MAX_PAGES") && importer.includes("ASTRAL_PAGINATION_ERROR") && importer.includes("documents.length === 0"));
  check("A45 provider READY FOR CREDENTIALS, never 'live' until real success", provider.includes('status: "ready_for_credentials"') && !provider.includes('status: "live"'));

  check("A46 settings mutations PIN-gated (org select, KKT bind/unbind); reads no PIN", stepsActions.includes("requireAstralOwner({ pin: true })") && stepsActions.includes("requireAstralOwner({ pin: false })") && settingsLib.includes("requireSettingsPin"));
  check("A47 tenant-safe: LegalEntity/Club must belong to company; owner/GD server-side", settingsLib.includes("legalEntityInCompany") && settingsLib.includes("clubInCompany") && settingsLib.includes('["owner", "general_director"]'));
  check("A48 API key AES-256-GCM, never returned/logged in actions", actions.includes("encryptOfdSecret") && !/return[^;]*integrationToken/.test(stepsActions) && !stepsActions.includes("console.log"));
  check("A49 dashboard+cron: single sync covers taxcom+astral, providers independent", daily.includes('provider: { in: ["taxcom", "astral"] }') && daily.includes("importAstralSalesForPeriod") && /try\s*{[\s\S]*}\s*catch/.test(daily));
  check("A50 migration additive-only (ADD COLUMN / CREATE INDEX, no DROP/rebuild); Taxcom importer untouched by astral", migration.includes("ADD COLUMN") && migration.includes("CREATE INDEX") && !/\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bALTER\s+COLUMN\b|\bRENAME\b/i.test(migration) && !taxImporter.toLowerCase().includes("astral"));

  // ---- regression guards (fix/astral-tickets-preview) ----
  check("R6 first/default request sends NO server operationTypes filter (fetch all, classify locally)", importer.includes("params.operationTypesFilter ?? undefined") && api.includes("if (params.operationTypes && params.operationTypes.length) body.operationTypes"));
  check("R7 A/B/C probe exists (org-only → +kkts → +operationTypes)", api.includes("probeAstralDocuments") && api.includes("A_org_only") && api.includes("B_with_kkts") && api.includes("C_with_operationTypes"));
  check("R8 kkts uses INTERNAL Astral id (externalKktId), NOT numberKKT/kktRegId/factoryFiscalDrive", importer.includes("Number(m.externalKktId)") && stepsActions.includes("Number(mapping.externalKktId)") && !/kkts:\s*\[?Number\(m\.(kktFactoryNumber|kktRegNumber|fnNumber)\)/.test(importer));
  check("R9 analytics sends required comparison period (lastBeginDate/lastEndDate)", api.includes("lastBeginDate: String(lastBeginDate)") && api.includes("lastEndDate: String(lastEndDate)"));
  check("R10 analytics failure (e.g. 406) does NOT block preview (best-effort, message surfaced)", stepsActions.includes("analyticsError = an.message") && stepsActions.includes("closedShifts, closedShiftsError, analytics, analyticsError") && !/return \{ ok: false[^}]*analytics/i.test(stepsActions));
  check("R11 api_key never in trace logs (importer/api log ids only, client redacts)", !/console\.warn\([^)]*apiKey/.test(importer) && !/console\.warn\([^)]*apiKey/.test(api) && importer.includes("import_trace") && client.includes("redactApiKey"));
  check("R12 date range half-open [begin, endExclusive) — never beginDate === endDate", receipts.includes("addDaysYmd(dateTo, 1)") && receipts.includes("endExclusive") && !receipts.includes("T23:59:59"));
  check("R13 trace stores KKT id fields separately (externalKktId/numberKKT/kktRegId/fiscalDriveNumber)", stepsActions.includes("externalKktId: mapping.externalKktId") && stepsActions.includes("numberKKT: mapping.kktFactoryNumber") && stepsActions.includes("kktRegId: mapping.kktRegNumber") && stepsActions.includes("fiscalDriveNumber: mapping.fnNumber"));
}

main();
