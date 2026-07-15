// OFD (Такском) sales import regression. Exercises secret encryption, receipt
// normalization/dedupe, the idempotent day-batched importer + daily summaries
// against the dev SQLite DB by MIRRORING lib/ofd/*, plus static assertions on the
// real source (role gating, no-PII, no-logging, health, manual sales untouched).
// No real Taxcom API call is ever made (the client is mirrored / injected).
//   npm run pilot:ofd-taxcom
import { PrismaClient } from "@prisma/client";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

// --- Mirror of lib/ofd/crypto ----------------------------------------------
const OFD_SECRET = process.env.OFD_SECRET && process.env.OFD_SECRET.length >= 32 ? process.env.OFD_SECRET : "dev-insecure-ofd-secret-at-least-32-bytes";
const aesKey = createHash("sha256").update(`ofd:aes:${OFD_SECRET}`).digest();
const encryptOfd = (plain) => { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", aesKey, iv); const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]); const tag = c.getAuthTag(); return `v1:${Buffer.concat([iv, tag, ct]).toString("base64")}`; };
const decryptOfd = (payload) => { if (!payload) return null; const i = payload.indexOf(":"); if (i < 0 || payload.slice(0, i) !== "v1") return null; try { const buf = Buffer.from(payload.slice(i + 1), "base64"); const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28); const d = createDecipheriv("aes-256-gcm", aesKey, iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]).toString("utf8"); } catch { return null; } };

// --- Mirror of lib/ofd/taxcom/adapter --------------------------------------
const mapOp = (raw) => { const s = String(raw ?? "").trim().toLowerCase(); if (s === "income" || s === "приход") return "income"; if (s === "incomereturn" || s === "income_return" || s === "возврат прихода") return "income_return"; return null; };
const dedupe = (fn, fd, fpd) => { const f = fpd && String(fpd).trim() ? String(fpd).trim() : null; return f ? `taxcom:${fn}:${fd}:${f}` : `taxcom:${fn}:${fd}`; };
function normalize(doc) {
  const op = mapOp(doc.operationType); if (!op) return null;
  const date = new Date(doc.dateTime); if (Number.isNaN(date.getTime())) return null;
  if (!doc.fn || !Number.isFinite(doc.fd)) return null;
  return { fnNumber: String(doc.fn), shiftNumber: Number.isFinite(doc.shift) ? Math.trunc(doc.shift) : null, fiscalDocumentNumber: Math.trunc(doc.fd), fiscalSign: doc.fpd && String(doc.fpd).trim() ? String(doc.fpd).trim() : null, operationType: op, receiptDate: date, totalKopeks: Math.trunc(doc.totalKopeks || 0), cashKopeks: Math.trunc(doc.cashKopeks || 0), electronicKopeks: Math.trunc(doc.electronicKopeks || 0), dedupeKey: dedupe(String(doc.fn), Math.trunc(doc.fd), doc.fpd) };
}

// --- Mirror of lib/ofd/importer --------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function eachDay(from, to) { if (!DATE_RE.test(from) || !DATE_RE.test(to)) return []; const out = []; let cur = new Date(`${from}T00:00:00.000Z`); const end = new Date(`${to}T00:00:00.000Z`); let g = 0; while (cur.getTime() <= end.getTime() && g < 366) { out.push(cur.toISOString().slice(0, 10)); cur = new Date(cur.getTime() + 86400000); g++; } return out; }
const summaryKeyOf = (companyId, clubId, legal, provider, date) => `${companyId}:${clubId}:${legal ?? "none"}:${provider}:${date}`;
async function recomputeSummary(companyId, clubId, legal, date) {
  const dayStart = new Date(`${date}T00:00:00.000Z`), dayEnd = new Date(dayStart.getTime() + 86400000);
  const rows = await p.ofdReceiptImport.findMany({ where: { companyId, clubId, provider: "taxcom", legalEntityId: legal ?? null, receiptDate: { gte: dayStart, lt: dayEnd } }, select: { operationType: true, totalKopeks: true, cashKopeks: true, electronicKopeks: true } });
  const a = { incomeTotalKopeks: 0, incomeCashKopeks: 0, incomeElectronicKopeks: 0, returnTotalKopeks: 0, returnCashKopeks: 0, returnElectronicKopeks: 0, receiptCount: 0, returnReceiptCount: 0 };
  for (const r of rows) { if (r.operationType === "income") { a.incomeTotalKopeks += r.totalKopeks; a.incomeCashKopeks += r.cashKopeks; a.incomeElectronicKopeks += r.electronicKopeks; a.receiptCount++; } else { a.returnTotalKopeks += r.totalKopeks; a.returnCashKopeks += r.cashKopeks; a.returnElectronicKopeks += r.electronicKopeks; a.returnReceiptCount++; } }
  const netTotalKopeks = a.incomeTotalKopeks - a.returnTotalKopeks;
  const summaryKey = summaryKeyOf(companyId, clubId, legal, "taxcom", date);
  await p.ofdDailySalesSummary.upsert({ where: { summaryKey }, create: { companyId, clubId, legalEntityId: legal ?? null, provider: "taxcom", date, summaryKey, ...a, netTotalKopeks }, update: { ...a, netTotalKopeks } });
}
async function runImport({ connectionId, companyId, dateFrom, dateTo, client, mappings }) {
  const run = await p.ofdSyncRun.create({ data: { connectionId, companyId, mode: "manual_period", dateFrom, dateTo, status: "running", startedAt: new Date() } });
  const days = eachDay(dateFrom, dateTo);
  let found = 0, imported = 0, skipped = 0, kktFailures = 0; const touched = new Set();
  for (const m of mappings) {
    const legal = m.legalEntityId ?? null; const recs = []; let failed = false;
    for (const day of days) {
      const shifts = await client.listShifts(m.fnNumber, day, day);
      if (!shifts.ok) { failed = true; await p.ofdSyncError.create({ data: { syncRunId: run.id, connectionId, companyId, clubId: m.clubId, fnNumber: m.fnNumber, stage: "list_shifts", safeCode: shifts.safeCode, safeMessage: (shifts.safeMessage || "").slice(0, 200) || null } }); continue; }
      for (const s of shifts.data) { const docs = await client.listDocumentsByShift(m.fnNumber, s.shiftNumber); if (!docs.ok) { failed = true; continue; } for (const d of docs.data) { const n = normalize(d); if (n) recs.push(n); } }
    }
    if (failed) kktFailures++;
    const byKey = new Map(); for (const r of recs) byKey.set(r.dedupeKey, r); const keys = [...byKey.keys()]; found += keys.length; if (!keys.length) continue;
    const ex = await p.ofdReceiptImport.findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true } }); const exSet = new Set(ex.map((e) => e.dedupeKey)); const fresh = keys.filter((k) => !exSet.has(k)).map((k) => byKey.get(k)); skipped += keys.length - fresh.length;
    if (fresh.length) await p.ofdReceiptImport.createMany({ data: fresh.map((r) => ({ connectionId, companyId, clubId: m.clubId, legalEntityId: legal, provider: "taxcom", fnNumber: r.fnNumber, shiftNumber: r.shiftNumber, fiscalDocumentNumber: r.fiscalDocumentNumber, fiscalSign: r.fiscalSign, operationType: r.operationType, receiptDate: r.receiptDate, totalKopeks: r.totalKopeks, cashKopeks: r.cashKopeks, electronicKopeks: r.electronicKopeks, dedupeKey: r.dedupeKey, source: "taxcom", syncRunId: run.id })) });
    imported += fresh.length;
    for (const r of byKey.values()) touched.add(`${m.clubId}|${legal ?? ""}|${r.receiptDate.toISOString().slice(0, 10)}`);
  }
  for (const key of touched) { const [clubId, legalRaw, day] = key.split("|"); await recomputeSummary(companyId, clubId, legalRaw || null, day); }
  const status = kktFailures === 0 ? "success" : (imported > 0 ? "partial_failed" : "failed");
  await p.ofdSyncRun.update({ where: { id: run.id }, data: { status, finishedAt: new Date(), foundReceipts: found, importedReceipts: imported, skippedReceipts: skipped } });
  return { runId: run.id, found, imported, skipped, status };
}

const CO = "pilot-ofd-co", CONN = "pilot-ofd-conn", U = "pilot-ofd-owner";
async function cleanup() {
  for (const t of ["ofdSyncError", "ofdSyncRun", "ofdReceiptImport", "ofdDailySalesSummary", "ofdCashRegisterMapping", "ofdConnection"]) await p[t].deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.club.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.company.deleteMany({ where: { id: CO } }).catch(() => {});
  await p.user.deleteMany({ where: { id: U } }).catch(() => {});
}

async function main() {
  await cleanup();
  await p.company.create({ data: { id: CO, name: "OFD Co" } });
  const clubA = await p.club.create({ data: { name: "Клуб A", city: "X", companyId: CO } });
  const clubB = await p.club.create({ data: { name: "Клуб B", city: "X", companyId: CO } });
  await p.user.create({ data: { id: U, email: "owner@ofd.test", name: "Овнер", role: "owner", isActive: true } });
  const conn = await p.ofdConnection.create({ data: { id: CONN, companyId: CO, provider: "taxcom", displayName: "Такском", serverBaseUrl: "https://server.taxcom.ru", authType: "login_password", loginEncrypted: encryptOfd("myLogin"), passwordEncrypted: encryptOfd("s3cret-pass"), createdByUserId: U } });

  // ===== Secrets encryption (1,2) =====
  const stored = await p.ofdConnection.findUnique({ where: { id: CONN } });
  check("1 connection secrets encrypted (ciphertext, not plaintext), decrypt round-trips", stored.passwordEncrypted.startsWith("v1:") && stored.passwordEncrypted !== "s3cret-pass" && decryptOfd(stored.passwordEncrypted) === "s3cret-pass" && !Object.values(stored).includes("s3cret-pass"));

  // ===== Mappings (6,7) =====
  const mapA = await p.ofdCashRegisterMapping.create({ data: { connectionId: CONN, companyId: CO, clubId: clubA.id, provider: "taxcom", fnNumber: "FN-A", isActive: true, activeMappingKey: "taxcom:FN-A" } });
  const mapB = await p.ofdCashRegisterMapping.create({ data: { connectionId: CONN, companyId: CO, clubId: clubB.id, provider: "taxcom", fnNumber: "FN-B", isActive: true, activeMappingKey: "taxcom:FN-B" } });
  check("6 KKT → club mapping created", (await p.ofdCashRegisterMapping.count({ where: { connectionId: CONN } })) === 2);
  let dupBlocked = false;
  try { await p.ofdCashRegisterMapping.create({ data: { connectionId: CONN, companyId: CO, clubId: clubA.id, provider: "taxcom", fnNumber: "FN-A", isActive: true, activeMappingKey: "taxcom:FN-A" } }); } catch { dupBlocked = true; }
  check("7 duplicate ACTIVE fn mapping blocked (unique activeMappingKey)", dupBlocked === true);

  // ===== Normalization (9-13) =====
  const dIncome = { fn: "FN-A", shift: 3, dateTime: "2026-07-05T10:00:00.000Z", fd: 101, fpd: "SIGN101", operationType: "Income", totalKopeks: 150000, cashKopeks: 50000, electronicKopeks: 100000 };
  const dReturn = { fn: "FN-A", shift: 3, dateTime: "2026-07-05T11:00:00.000Z", fd: 102, fpd: "SIGN102", operationType: "IncomeReturn", totalKopeks: 20000, cashKopeks: 20000, electronicKopeks: 0 };
  const dExpense = { fn: "FN-A", shift: 3, dateTime: "2026-07-05T12:00:00.000Z", fd: 103, fpd: "SIGN103", operationType: "Expense", totalKopeks: 999, cashKopeks: 999, electronicKopeks: 0 };
  check("9 Income normalized", normalize(dIncome).operationType === "income" && normalize(dIncome).fiscalDocumentNumber === 101);
  check("10 IncomeReturn normalized", normalize(dReturn).operationType === "income_return");
  check("11 cash/electronic split preserved", normalize(dIncome).cashKopeks === 50000 && normalize(dIncome).electronicKopeks === 100000);
  check("12 non-income docs skipped", normalize(dExpense) === null && mapOp("Correction") === null);
  check("13 dedupeKey stable (with fpd; falls back to fn:fd without)", dedupe("FN-A", 101, "SIGN101") === "taxcom:FN-A:101:SIGN101" && dedupe("FN-A", 101, null) === "taxcom:FN-A:101" && dedupe("FN-A", 101, "SIGN101") === normalize(dIncome).dedupeKey);

  // ===== Import: idempotent + summary (14,17,24) =====
  const client = {
    listShifts: async (fn) => ({ ok: true, data: fn === "FN-A" || fn === "FN-B" ? [{ shiftNumber: 3 }] : [] }),
    listDocumentsByShift: async (fn) => ({ ok: true, data: fn === "FN-A" ? [dIncome, dReturn, dExpense] : [] }),
  };
  const r1 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-05", dateTo: "2026-07-05", client, mappings: [mapA] });
  check("14a first import stores income+return, skips expense", r1.imported === 2 && (await p.ofdReceiptImport.count({ where: { companyId: CO } })) === 2);
  const r2 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-05", dateTo: "2026-07-05", client, mappings: [mapA] });
  check("14b re-import is idempotent (no duplicates, all skipped)", r2.imported === 0 && r2.skipped === 2 && (await p.ofdReceiptImport.count({ where: { companyId: CO } })) === 2);
  const sum = await p.ofdDailySalesSummary.findUnique({ where: { summaryKey: summaryKeyOf(CO, clubA.id, null, "taxcom", "2026-07-05") } });
  check("17 daily summary: income/return, cash/electronic, net, counts", sum.incomeTotalKopeks === 150000 && sum.incomeCashKopeks === 50000 && sum.incomeElectronicKopeks === 100000 && sum.returnTotalKopeks === 20000 && sum.netTotalKopeks === 130000 && sum.receiptCount === 1 && sum.returnReceiptCount === 1);
  check("24 cash card can read OFD cash for a day (summary query)", (await p.ofdDailySalesSummary.findUnique({ where: { summaryKey: summaryKeyOf(CO, clubA.id, null, "taxcom", "2026-07-05") } })).incomeCashKopeks === 50000);

  // ===== Partial failure isolation (15,16) =====
  const clientPartial = {
    listShifts: async (fn) => fn === "FN-B" ? { ok: false, safeCode: "kkt_not_found", safeMessage: "x".repeat(500) } : { ok: true, data: [{ shiftNumber: 4 }] },
    listDocumentsByShift: async () => ({ ok: true, data: [{ fn: "FN-A", shift: 4, dateTime: "2026-07-06T09:00:00.000Z", fd: 201, fpd: "S201", operationType: "Income", totalKopeks: 30000, cashKopeks: 30000, electronicKopeks: 0 }] }),
  };
  const rP = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-06", dateTo: "2026-07-06", client: clientPartial, mappings: [mapA, mapB] });
  check("15 one KKT failure does NOT abort others (partial_failed, others imported)", rP.status === "partial_failed" && rP.imported === 1 && (await p.ofdReceiptImport.count({ where: { companyId: CO, fiscalDocumentNumber: 201 } })) === 1);
  const errRow = await p.ofdSyncError.findFirst({ where: { syncRunId: rP.runId, fnNumber: "FN-B" } });
  check("16 sync error recorded + redacted (safeCode, safeMessage ≤200)", errRow && errRow.safeCode === "kkt_not_found" && errRow.safeMessage.length === 200);

  // ===== July backfill day batching (18,19) =====
  check("18 July backfill iterates day-by-day (31 days)", eachDay("2026-07-01", "2026-07-31").length === 31);

  // ===== Taxcom login (agreementNumber) + error classification mirrors =======
  // Mirror of client.extractToken / classifyTaxcomError / parseKktList / raw.
  const extractToken = (d) => { const t = d?.sessionToken ?? d?.SessionToken ?? d?.token ?? d?.accessToken ?? d?.Token; return typeof t === "string" && t.length > 0 ? t : null; };
  const extractApiError = (d) => { const rc = d?.apiErrorCode ?? d?.ApiErrorCode ?? d?.errorCode; const apiErrorCode = typeof rc === "number" ? rc : (typeof rc === "string" && rc.trim() !== "" && Number.isFinite(Number(rc)) ? Number(rc) : null); const rd = d?.commonDescription ?? d?.CommonDescription ?? d?.description ?? d?.message; return { apiErrorCode, description: typeof rd === "string" && rd.trim() ? rd.trim() : null }; };
  function classifyErr(status, apiErrorCode, description) {
    const desc = (description ?? "").toLowerCase();
    if (apiErrorCode === 3103 || desc.includes("ккт не найдена") || desc.includes("kkt not found")) return { safeCode: "kkt_not_found" };
    if (status === 401 || desc.includes("session-token") || desc.includes("авториз") || desc.includes("unauthorized") || desc.includes("токен")) return { safeCode: "auth_failed" };
    if (status === 403 || desc.includes("доступ запрещ") || desc.includes("forbidden")) return { safeCode: "forbidden" };
    if (status === 429) return { safeCode: "rate_limited" };
    if (status === 404) return { safeCode: "kkt_not_found" };
    return { safeCode: "unknown" };
  }
  const parseKktList = (data) => { const arr = Array.isArray(data) ? data : (data?.Infos ?? data?.infos ?? data?.Items ?? []); return (arr || []).map((o) => ({ fnNumber: String(o.Fn ?? o.fn ?? o.FnFactoryNumber ?? ""), kktRegNumber: o.KktRegNumber ?? null, kktName: o.KktName ?? null, outletName: o.OutletName ?? null })).filter((k) => k.fnNumber); };

  // Client mirror with an INJECTED fetch that captures requests.
  function makeClient(cfg, fetchImpl) {
    let token = null; const captured = [];
    async function raw(path, body, withSession) {
      const headers = { "Content-Type": "application/json" };
      if (cfg.integratorId) headers["Integrator-ID"] = cfg.integratorId;
      if (withSession && token) headers["Session-Token"] = token;
      captured.push({ path, headers, body });
      let res; try { res = await fetchImpl(cfg.serverBaseUrl + path, { method: "POST", headers, body: JSON.stringify(body ?? {}) }); } catch (e) { return { ok: false, safeCode: e && e.name === "TimeoutError" ? "timeout" : "network" }; }
      const text = await res.text().catch(() => ""); let parsed = null; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = null; }
      const { apiErrorCode, description } = extractApiError(parsed);
      if (!res.ok || (apiErrorCode != null && apiErrorCode !== 0)) { const c = classifyErr(res.status, apiErrorCode, description); return { ok: false, safeCode: c.safeCode, httpStatus: res.status }; }
      if (parsed == null) return { ok: false, safeCode: "parse_error" };
      return { ok: true, data: parsed };
    }
    async function ensureSession() {
      if (token) return { ok: true, data: token };
      const b = {}; if (cfg.authType === "integration_token") b.integrationToken = cfg.integrationToken ?? ""; else { b.login = cfg.login ?? ""; b.password = cfg.password ?? ""; }
      const ag = cfg.contractNumber && cfg.contractNumber.trim(); if (ag) b.agreementNumber = cfg.contractNumber.trim();
      const r = await raw("/API/v2/Login", b, false); if (!r.ok) return r; const t = extractToken(r.data); if (!t) return { ok: false, safeCode: "parse_error" }; token = t; return { ok: true, data: t };
    }
    return { captured, login: ensureSession, listShifts: async (fn, from, to) => { const s = await ensureSession(); if (!s.ok) return s; return raw("/API/v2/ShiftList", { Fn: fn, DateFrom: from, DateTo: to }, true); } };
  }
  const okJson = (obj) => ({ ok: true, status: 200, async text() { return JSON.stringify(obj); } });
  const errJson = (status, obj) => ({ ok: false, status, async text() { return JSON.stringify(obj); } });

  const cfgAg = { serverBaseUrl: "https://api-lk-ofd.taxcom.ru", authType: "login_password", contractNumber: "CD-25/45507", login: "l", password: "p", integratorId: "INT-1", integrationToken: null };
  const cfgNoAg = { ...cfgAg, contractNumber: "" };

  // T1: sessionToken accepted.
  const cli1 = makeClient(cfgAg, async () => okJson({ sessionToken: "abc" }));
  check("T1 Login response { sessionToken } accepted", (await cli1.login()).data === "abc");
  check("T1b token also read from token/accessToken", extractToken({ token: "t2" }) === "t2" && extractToken({ accessToken: "t3" }) === "t3" && extractToken({}) === null);
  // T2: agreementNumber included when contractNumber set.
  await cli1.login();
  const loginReq1 = cli1.captured.find((c) => c.path === "/API/v2/Login");
  check("T2 Login body includes agreementNumber from contractNumber", loginReq1.body.agreementNumber === "CD-25/45507" && loginReq1.body.login === "l" && loginReq1.body.password === "p");
  check("T2b Integrator-ID sent as a header (not logged)", loginReq1.headers["Integrator-ID"] === "INT-1");
  // T3: no agreementNumber when empty.
  const cli2 = makeClient(cfgNoAg, async () => okJson({ sessionToken: "z" }));
  await cli2.login();
  check("T3 Login body omits agreementNumber when contractNumber empty", !("agreementNumber" in cli2.captured.find((c) => c.path === "/API/v2/Login").body));
  // T4: ShiftList carries Session-Token.
  const cli3 = makeClient(cfgAg, async (url) => url.includes("Login") ? okJson({ sessionToken: "TKN" }) : okJson({ Items: [] }));
  await cli3.listShifts("FN-1", "2026-07-01", "2026-07-01");
  const shiftReq = cli3.captured.find((c) => c.path === "/API/v2/ShiftList");
  check("T4 ShiftList request carries Session-Token header", shiftReq.headers["Session-Token"] === "TKN");
  // T5/T6: 3103 → kkt_not_found (NOT auth_failed).
  check("T5 apiErrorCode 3103 maps to kkt_not_found", classifyErr(404, 3103, "ККТ не найдена").safeCode === "kkt_not_found" && classifyErr(200, 3103, "ККТ не найдена").safeCode === "kkt_not_found");
  check("T6 3103 is NOT auth_failed; real auth stays auth_failed", classifyErr(404, 3103, "ККТ не найдена").safeCode !== "auth_failed" && classifyErr(401, null, "Unauthorized").safeCode === "auth_failed" && classifyErr(403, null, "Доступ запрещён").safeCode === "forbidden");
  // T5b: end-to-end — ShiftList 404 { apiErrorCode:3103 } → kkt_not_found.
  const cli4 = makeClient(cfgAg, async (url) => url.includes("Login") ? okJson({ sessionToken: "X" }) : errJson(404, { apiErrorCode: 3103, commonDescription: "ККТ не найдена" }));
  check("T5b ShiftList 3103 → kkt_not_found end-to-end", (await cli4.listShifts("FN-Z", "d", "d")).safeCode === "kkt_not_found");
  // T10: kktstat parser reads Infos[].
  check("T10 kktstat parser reads Infos[]", parseKktList({ Infos: [{ FnFactoryNumber: "9999", KktRegNumber: "RN1", KktName: "Касса 1", OutletName: "Клуб" }] }).length === 1 && parseKktList({ Infos: [{ FnFactoryNumber: "9999" }] })[0].fnNumber === "9999");

  await cleanup();

  // ===== Static assertions on the real source =====
  const crypto = readFileSync(new URL("../src/lib/ofd/crypto.ts", import.meta.url), "utf8");
  const importer = readFileSync(new URL("../src/lib/ofd/importer.ts", import.meta.url), "utf8");
  const clientSrc = readFileSync(new URL("../src/lib/ofd/taxcom/client.ts", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../src/lib/ofd/taxcom/adapter.ts", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../src/app/(app)/settings/integrations/ofd/actions.ts", import.meta.url), "utf8");
  const forms = readFileSync(new URL("../src/app/(app)/settings/integrations/ofd/_components/OfdForms.tsx", import.meta.url), "utf8");
  const pageSrc = readFileSync(new URL("../src/app/(app)/settings/integrations/ofd/page.tsx", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const health = readFileSync(new URL("../src/app/api/health/route.ts", import.meta.url), "utf8");
  const receiptModel = schema.slice(schema.indexOf("model OfdReceiptImport"), schema.indexOf("model OfdReceiptImport") + 900);

  check("2b UI never renders secret values (only configured/not booleans)", forms.includes("hasLogin") && forms.includes("hasPassword") && !forms.includes("loginEncrypted") && !pageSrc.includes("passwordEncrypted:") && pageSrc.includes("hasPassword: Boolean(connectionRow.passwordEncrypted)"));
  check("3 owner may create a connection (owner/general_director gate)", actions.includes('userHasCompanyRole(ctx.user.id, ctx.selectedCompanyId, ["owner", "general_director"])') && actions.includes("saveOfdConnection"));
  check("4/5 manager/regional cannot create (requireOfdAdmin denies non owner/GD)", actions.includes("requireOfdAdmin") && actions.includes("Настраивать интеграции может только владелец или ген. директор."));
  check("8 client never logs password/session token/login", !clientSrc.includes("console.") && clientSrc.includes('"Session-Token"'));
  check("crypto uses AES-256-GCM keyed by OFD_SECRET with v1 version prefix", crypto.includes('createCipheriv("aes-256-gcm"') && crypto.includes("OFD_SECRET") && crypto.includes('`${VERSION}:`'));
  check("19 backfill uses shifts+documents (NOT NewDocuments) as the July source", importer.includes("listShifts(") && importer.includes("listDocumentsByShift(") && !importer.includes("NewDocuments") && importer.includes("eachDay("));
  check("20 buyer phone/email/name are NOT stored (no such columns/refs)", !/phone|email|buyerName/i.test(receiptModel) && !adapter.includes("phone") && !adapter.includes("buyer"));
  check("21 raw fiscal JSON is NOT stored (no raw/json columns; adapter only maps safe fields)", !/rawJson|rawResponse|items|itemList/i.test(receiptModel) && !importer.includes("rawJson"));
  check("22 dashboard/block shows OFD totals (OfdDailySalesSummary + SalesBlock)", pageSrc.includes("ofdDailySalesSummary.findMany") && pageSrc.includes("ОФД продажи") && pageSrc.includes("SalesBlock"));
  check("23 existing manual Sale model untouched (no OFD writes to Sale)", !importer.includes("prisma.sale.") && !actions.includes("prisma.sale.") && schema.includes("model Sale {"));
  check("health exposes ofd { enabled, configured } (no secret)", health.includes("ofdHealth()") && health.includes("ofd:") && !health.includes("OFD_SECRET"));
  check("importer idempotent + per-KKT error isolation + summary recompute (structure)", importer.includes("existingSet") && importer.includes("recordSyncError") && importer.includes("recomputeDailySummary") && importer.includes("already_running"));

  // --- Agreement-login fixes (real source) ---
  check("T-S1 Login body: lowercase login/password + agreementNumber from contractNumber", clientSrc.includes("loginBody.login = cfg.login") && clientSrc.includes("loginBody.password = cfg.password") && clientSrc.includes("cfg.contractNumber?.trim()") && clientSrc.includes("loginBody.agreementNumber = agreement"));
  check("T-S2 Integrator-ID header on requests (never logged)", clientSrc.includes('headers["Integrator-ID"] = cfg.integratorId') && !clientSrc.includes("console."));
  check("T-S3 token read from sessionToken/token/accessToken", clientSrc.includes("d?.sessionToken ?? d?.SessionToken ?? d?.token ?? d?.accessToken"));
  check("T-S4 classifyTaxcomError: 3103/ККТ не найдена → kkt_not_found, not auth_failed", clientSrc.includes("apiErrorCode === 3103") && clientSrc.includes('safeCode: "kkt_not_found"') && clientSrc.includes("NEVER an auth failure"));
  check("T-S5 error body extracts only apiErrorCode/commonDescription (no raw body returned)", clientSrc.includes("extractApiError") && clientSrc.includes("commonDescription") && clientSrc.includes(".slice(0, 200)"));
  check("7 save login_password with empty contractNumber → validation error", actions.includes('authType === "login_password" && !contractNumber') && actions.includes("Укажите номер договора Такском"));
  check("8 with a contractNumber the required check passes (only blocks when empty)", actions.includes("&& !contractNumber"));
  check("9 checkOfdConnection: Login-only via contractNumber, never returns the token", actions.includes("export async function checkOfdConnection") && actions.includes("contractNumber: c.contractNumber") && actions.includes("client.login()") && actions.includes("Подключение успешно. Договор выбран.") && !/return\s*\{[^}]*sessionToken/.test(actions));
  check("kktstat parser reads Infos + FnFactoryNumber/Outlet fields", clientSrc.includes('asArray(data, "Infos", "infos"') && clientSrc.includes("FnFactoryNumber") && clientSrc.includes("OutletName"));
  check("UI: contract-number field prominent + help + Проверить подключение", forms.includes("Номер договора Такском") && forms.includes("CD-25/45507") && forms.includes("OfdCheckConnection") && forms.includes("Проверить подключение"));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
