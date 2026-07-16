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

  // ===== Taxcom login (NO agreementNumber) + AccountList + error mirrors ======
  // Mirror of client.extractToken / classifyTaxcomError / parseKktList /
  // parseAccountList / raw. Login sends ONLY { login, password } — agreementNumber
  // is NEVER sent (it triggered Taxcom 2108); the договор is checked via AccountList.
  const extractToken = (d) => { const t = d?.sessionToken ?? d?.SessionToken ?? d?.token ?? d?.accessToken ?? d?.Token; return typeof t === "string" && t.length > 0 ? t : null; };
  const extractApiError = (d) => { const rc = d?.apiErrorCode ?? d?.ApiErrorCode ?? d?.errorCode; const apiErrorCode = typeof rc === "number" ? rc : (typeof rc === "string" && rc.trim() !== "" && Number.isFinite(Number(rc)) ? Number(rc) : null); const rd = d?.commonDescription ?? d?.CommonDescription ?? d?.description ?? d?.message; return { apiErrorCode, description: typeof rd === "string" && rd.trim() ? rd.trim() : null }; };
  function classifyErr(status, apiErrorCode, description) {
    const desc = (description ?? "").toLowerCase();
    if (status === 405 || desc.includes("does not support http method") || desc.includes("method not allowed") || desc.includes("method not supported") || desc.includes("http method")) return { safeCode: "taxcom_method_not_allowed" };
    if (apiErrorCode === 2108) return { safeCode: "auth_failed" };
    if (apiErrorCode === 3103 || desc.includes("ккт не найдена") || desc.includes("kkt not found")) return { safeCode: "kkt_not_found" };
    if (apiErrorCode === 3106) return { safeCode: "no_kkt_found" };
    if (status === 401 || desc.includes("session-token") || desc.includes("авториз") || desc.includes("unauthorized") || desc.includes("токен")) return { safeCode: "auth_failed" };
    if (status === 403 || desc.includes("доступ запрещ") || desc.includes("forbidden")) return { safeCode: "forbidden" };
    if (status === 429) return { safeCode: "rate_limited" };
    if (status === 404) return { safeCode: "kkt_not_found" };
    return { safeCode: "unknown" };
  }
  const s2 = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num2 = (v) => { const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? n : 0; };
  const asArr = (data, keys) => { if (Array.isArray(data)) return data; const d = data ?? {}; for (const k of keys) if (Array.isArray(d[k])) return d[k]; return []; };
  const parseKktList = (data) => { const arr = Array.isArray(data) ? data : (data?.Infos ?? data?.infos ?? data?.Items ?? data?.Records ?? []); return (arr || []).map((o) => ({ fnNumber: String(o.Fn ?? o.fn ?? o.FnFactoryNumber ?? ""), kktRegNumber: o.KktRegNumber ?? null, kktName: o.KktName ?? null, outletName: o.OutletName ?? null })).filter((k) => k.fnNumber); };
  const parseAccountList = (data) => {
    const d = data ?? {};
    const session = d.currentSession ?? d.CurrentSession ?? d.current ?? null;
    const currentAgreementNumber = s2(session?.agreementNumber ?? session?.AgreementNumber) ?? s2(d.currentAgreementNumber ?? d.CurrentAgreementNumber);
    const arr = Array.isArray(d) ? d : (d.records ?? d.Records ?? d.Items ?? d.items ?? d.accounts ?? []);
    const records = (arr || []).map((o) => ({ agreementNumber: s2(o.agreementNumber ?? o.AgreementNumber ?? o.contractNumber), companyName: s2(o.companyName ?? o.CompanyName ?? o.name), inn: s2(o.inn ?? o.Inn ?? o.INN), kpp: s2(o.kpp ?? o.Kpp ?? o.KPP) }));
    return { currentAgreementNumber, records };
  };
  const parseShiftList = (data) => asArr(data, ["records", "Records", "Items", "items", "Shifts", "shifts", "ShiftList"]).map((o) => ({ shiftNumber: num2(o.Shift ?? o.ShiftNumber ?? o.shift ?? o.shiftNumber ?? o.Number ?? o.number), dateOpen: s2(o.OpenDate ?? o.openDate ?? o.openedAt ?? o.DateOpen ?? o.dateOpen), dateClose: s2(o.CloseDate ?? o.closeDate ?? o.closedAt ?? o.DateClose ?? o.dateClose) })).filter((s) => Number.isFinite(s.shiftNumber));
  const parseDocumentList = (data) => asArr(data, ["records", "Records", "Items", "items", "Documents", "documents", "DocumentList"]).map((o) => ({ fn: String(o.Fn ?? o.fn ?? ""), shift: num2(o.Shift ?? o.shift), fd: num2(o.Fd ?? o.fd ?? o.FiscalDocumentNumber), fpd: s2(o.Fpd ?? o.fpd ?? o.FiscalSign), operationType: s2(o.OperationType ?? o.operationType ?? o.Operation), totalKopeks: num2(o.TotalKopeks ?? o.totalKopeks ?? o.Sum ?? o.Total) }));

  // Client mirror with an INJECTED fetch that captures requests (method + query).
  function makeClient(cfg, fetchImpl) {
    let token = null; const captured = [];
    async function raw(path, opts = {}) {
      const method = opts.method ?? "POST"; const withSession = opts.withSession ?? false;
      const headers = { Accept: "application/json" }; if (method === "POST") headers["Content-Type"] = "application/json";
      if (cfg.integratorId) headers["Integrator-ID"] = cfg.integratorId;
      if (withSession && token) headers["Session-Token"] = token;
      let url = cfg.serverBaseUrl + path;
      if (opts.query) { const qs = new URLSearchParams(); for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && String(v) !== "") qs.set(k, String(v)); const s = qs.toString(); if (s) url += (url.includes("?") ? "&" : "?") + s; }
      const init = { method, headers, ...(method === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}) };
      captured.push({ path, method, headers, query: opts.query, body: opts.body, url, hasBody: "body" in init });
      let res; try { res = await fetchImpl(url, init); } catch (e) { return { ok: false, safeCode: e && e.name === "TimeoutError" ? "timeout" : "network" }; }
      const text = await res.text().catch(() => ""); let parsed = null; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = null; }
      const { apiErrorCode, description } = extractApiError(parsed);
      if (!res.ok || (apiErrorCode != null && apiErrorCode !== 0)) { const c = classifyErr(res.status, apiErrorCode, description); return { ok: false, safeCode: c.safeCode, httpStatus: res.status }; }
      if (parsed == null) return { ok: false, safeCode: "parse_error" };
      return { ok: true, data: parsed };
    }
    async function ensureSession() {
      if (token) return { ok: true, data: token };
      const b = {}; if (cfg.authType === "integration_token") b.integrationToken = cfg.integrationToken ?? ""; else { b.login = cfg.login ?? ""; b.password = cfg.password ?? ""; }
      const r = await raw("/API/v2/Login", { method: "POST", body: b, withSession: false }); if (!r.ok) return r; const t = extractToken(r.data); if (!t) return { ok: false, safeCode: "parse_error" }; token = t; return { ok: true, data: t };
    }
    return {
      captured, login: ensureSession,
      listAccounts: async () => { const s = await ensureSession(); if (!s.ok) return s; const r = await raw("/API/v2/AccountList", { method: "GET", withSession: true }); if (!r.ok) return r; return { ok: true, data: parseAccountList(r.data) }; },
      listShifts: async (fn, from, to) => { const s = await ensureSession(); if (!s.ok) return s; const r = await raw("/API/v2/ShiftList", { method: "GET", withSession: true, query: { fn, begin: from, end: to, pn: 1, ps: 100 } }); if (!r.ok) return r; return { ok: true, data: parseShiftList(r.data) }; },
      listDocumentsByShift: async (fn, shift) => { const s = await ensureSession(); if (!s.ok) return s; const r = await raw("/API/v2/DocumentList", { method: "GET", withSession: true, query: { fn, shift } }); if (!r.ok) return r; return { ok: true, data: parseDocumentList(r.data) }; },
    };
  }
  const okJson = (obj) => ({ ok: true, status: 200, async text() { return JSON.stringify(obj); } });
  const errJson = (status, obj) => ({ ok: false, status, async text() { return JSON.stringify(obj); } });

  const cfgAg = { serverBaseUrl: "https://api-lk-ofd.taxcom.ru", authType: "login_password", contractNumber: "CD-25/45507", login: "l", password: "p", integratorId: "INT-1", integrationToken: null };
  const cfgNoAg = { ...cfgAg, contractNumber: "" };
  const cfgToken = { ...cfgAg, authType: "integration_token", login: null, password: null, integrationToken: "ITOK" };

  // T1: sessionToken accepted (also token/accessToken aliases).
  const cli1 = makeClient(cfgAg, async () => okJson({ sessionToken: "abc" }));
  check("T1 Login response { sessionToken } accepted", (await cli1.login()).data === "abc");
  check("T1b token also read from token/accessToken", extractToken({ token: "t2" }) === "t2" && extractToken({ accessToken: "t3" }) === "t3" && extractToken({}) === null);
  // T2: Login body must NOT contain agreementNumber even when contractNumber set.
  await cli1.login();
  const loginReq1 = cli1.captured.find((c) => c.path === "/API/v2/Login");
  check("T2 Login body is ONLY { login, password } — NO agreementNumber even with contractNumber set", !("agreementNumber" in loginReq1.body) && !("contractNumber" in loginReq1.body) && loginReq1.body.login === "l" && loginReq1.body.password === "p" && Object.keys(loginReq1.body).length === 2);
  check("T2b Integrator-ID sent as a header (not in body, not logged)", loginReq1.headers["Integrator-ID"] === "INT-1" && !("integratorId" in loginReq1.body));
  // T3: empty contractNumber also sends no agreementNumber (unchanged behaviour).
  const cli2 = makeClient(cfgNoAg, async () => okJson({ sessionToken: "z" }));
  await cli2.login();
  check("T3 Login body omits agreementNumber when contractNumber empty too", !("agreementNumber" in cli2.captured.find((c) => c.path === "/API/v2/Login").body));
  // T3b: integration_token auth sends only integrationToken.
  const cliT = makeClient(cfgToken, async () => okJson({ sessionToken: "z2" }));
  await cliT.login();
  const loginReqT = cliT.captured.find((c) => c.path === "/API/v2/Login");
  check("T3c integration_token Login body has integrationToken, no agreementNumber/login", loginReqT.body.integrationToken === "ITOK" && !("agreementNumber" in loginReqT.body) && !("login" in loginReqT.body));
  // T4: ShiftList + DocumentList are GET with query params, no body, Session-Token + Integrator-ID.
  let shiftInit = null, docInit = null;
  const cli3 = makeClient(cfgAg, async (url, init) => { if (url.includes("Login")) return okJson({ sessionToken: "TKN" }); if (url.includes("ShiftList")) { shiftInit = init; return okJson({ records: [{ shift: 7, openDate: "2026-07-01T08:00:00" }] }); } docInit = init; return okJson({ records: [] }); });
  await cli3.listShifts("7381440800719861", "2026-07-01", "2026-07-01");
  await cli3.listDocumentsByShift("7381440800719861", 7);
  const shiftReq = cli3.captured.find((c) => c.path === "/API/v2/ShiftList");
  const docReq = cli3.captured.find((c) => c.path === "/API/v2/DocumentList");
  check("T4 ShiftList is GET (not POST) with fn/begin/end/pn/ps query params, no body", shiftReq.method === "GET" && shiftReq.url.includes("/API/v2/ShiftList?") && shiftReq.url.includes("fn=7381440800719861") && shiftReq.url.includes("begin=2026-07-01") && shiftReq.url.includes("end=2026-07-01") && shiftReq.url.includes("pn=1") && shiftReq.url.includes("ps=100") && shiftReq.hasBody === false && !("body" in shiftInit));
  check("T4b ShiftList carries Session-Token + Integrator-ID + Accept headers", shiftReq.headers["Session-Token"] === "TKN" && shiftReq.headers["Integrator-ID"] === "INT-1" && shiftReq.headers["Accept"] === "application/json" && !shiftReq.headers["Content-Type"]);
  check("T4c DocumentList is GET (not POST) with fn/shift query params, no body", docReq.method === "GET" && docReq.url.includes("/API/v2/DocumentList?") && docReq.url.includes("fn=7381440800719861") && docReq.url.includes("shift=7") && docReq.hasBody === false && !("body" in docInit));
  check("T4d DocumentList carries Session-Token + Integrator-ID headers", docReq.headers["Session-Token"] === "TKN" && docReq.headers["Integrator-ID"] === "INT-1");
  check("T4e ShiftList/DocumentList requests never send a JSON body", shiftReq.body === undefined && docReq.body === undefined);
  // T4f: method-not-supported error is classified taxcom_method_not_allowed.
  const cliMethod = makeClient(cfgAg, async (url) => url.includes("Login") ? okJson({ sessionToken: "X" }) : errJson(405, { commonDescription: "The requested resource does not support http method 'POST'" }));
  check("T4f method-not-supported → taxcom_method_not_allowed", (await cliMethod.listShifts("FN", "d", "d")).safeCode === "taxcom_method_not_allowed" && classifyErr(200, null, "The requested resource does not support http method 'POST'").safeCode === "taxcom_method_not_allowed" && classifyErr(405, null, "").safeCode === "taxcom_method_not_allowed");
  // T4g: empty ShiftList is NOT an error — success with 0 shifts.
  const cliEmpty = makeClient(cfgAg, async (url) => url.includes("Login") ? okJson({ sessionToken: "X" }) : okJson({ records: [] }));
  const emptyShifts = await cliEmpty.listShifts("FN", "d", "d");
  check("T4g empty ShiftList = success with 0 shifts (NOT an error)", emptyShifts.ok === true && Array.isArray(emptyShifts.data) && emptyShifts.data.length === 0);
  // T4h: ShiftList parser reads records/Records/Items/items/shifts/Shifts.
  check("T4h ShiftList parser reads records/Records/Items/items/shifts/Shifts", ["records", "Records", "Items", "items", "shifts", "Shifts"].every((k) => parseShiftList({ [k]: [{ shift: 5, openDate: "d1", closeDate: "d2" }] }).length === 1) && parseShiftList({ Shifts: [{ ShiftNumber: 9, OpenDate: "o", CloseDate: "c" }] })[0].shiftNumber === 9);
  // T4i: DocumentList parser reads records/Records/Items/items/documents/Documents.
  check("T4i DocumentList parser reads records/Records/Items/items/documents/Documents", ["records", "Records", "Items", "items", "documents", "Documents"].every((k) => parseDocumentList({ [k]: [{ Fn: "F", Fd: 1, OperationType: "Income", TotalKopeks: 100 }] }).length === 1));
  // T5/T6: 3103 → kkt_not_found (NOT auth_failed); 2108 → auth_failed; 3106 → no_kkt_found/forbidden.
  check("T5 apiErrorCode 3103 maps to kkt_not_found", classifyErr(404, 3103, "ККТ не найдена").safeCode === "kkt_not_found" && classifyErr(200, 3103, "ККТ не найдена").safeCode === "kkt_not_found");
  check("T6 3103 not auth_failed; 401 auth_failed; 403 forbidden", classifyErr(404, 3103, "ККТ не найдена").safeCode !== "auth_failed" && classifyErr(401, null, "Unauthorized").safeCode === "auth_failed" && classifyErr(403, null, "Доступ запрещён").safeCode === "forbidden");
  check("T6b apiErrorCode 2108 → auth_failed (the agreement-login failure)", classifyErr(200, 2108, "Ошибка авторизации").safeCode === "auth_failed" && classifyErr(401, 2108, "Некорректная пара логин/пароль").safeCode === "auth_failed");
  check("T6c apiErrorCode 3106 → no_kkt_found (session valid, KKT not reachable — not auth)", classifyErr(200, 3106, "Нет доступных ККТ").safeCode === "no_kkt_found" && classifyErr(200, 3106, "Нет доступа к ККТ").safeCode !== "auth_failed");
  // T5b: end-to-end — ShiftList 404 { apiErrorCode:3103 } → kkt_not_found.
  const cli4 = makeClient(cfgAg, async (url) => url.includes("Login") ? okJson({ sessionToken: "X" }) : errJson(404, { apiErrorCode: 3103, commonDescription: "ККТ не найдена" }));
  check("T5b ShiftList 3103 → kkt_not_found end-to-end", (await cli4.listShifts("FN-Z", "d", "d")).safeCode === "kkt_not_found");
  // T7: AccountList parser reads records[] + currentSession, safe fields only.
  const acc = parseAccountList({ currentSession: { agreementNumber: "CD-25/45507" }, records: [ { agreementNumber: "CD-25/45507", companyName: 'ООО "СПОРТ ТЕХНОЛОГИИ"', inn: "6679182168", kpp: "667901001", accessRights: "ignored" }, { agreementNumber: "CD-24/00001", companyName: "ООО Другое", inn: "1", kpp: "2" } ] });
  check("T7 AccountList parser reads records[] + currentSession (safe fields)", acc.records.length === 2 && acc.currentAgreementNumber === "CD-25/45507" && acc.records[0].agreementNumber === "CD-25/45507" && acc.records[0].inn === "6679182168" && !("accessRights" in acc.records[0]));
  // T8: end-to-end check — Login (no agreement) then GET AccountList.
  const cliAcc = makeClient(cfgAg, async (url) => url.includes("Login") ? okJson({ sessionToken: "ST" }) : okJson({ records: [{ agreementNumber: "CD-25/45507", companyName: "ООО X", inn: "6679182168" }] }));
  const accRes = await cliAcc.listAccounts();
  const accReq = cliAcc.captured.find((c) => c.path === "/API/v2/AccountList");
  check("T8 AccountList fetched via GET with Session-Token, agreement found among records", accRes.ok && accReq.method === "GET" && accReq.headers["Session-Token"] === "ST" && accRes.data.records.some((r) => r.agreementNumber === "CD-25/45507"));
  // T8b: contractNumber NOT among records → warning path (found=false, still connected).
  const cliAcc2 = makeClient(cfgAg, async (url) => url.includes("Login") ? okJson({ sessionToken: "ST" }) : okJson({ records: [{ agreementNumber: "CD-99/00000", companyName: "ООО Y" }] }));
  const accRes2 = await cliAcc2.listAccounts();
  check("T8b contractNumber absent from records → not found (warning, login still ok)", accRes2.ok && !accRes2.data.records.some((r) => r.agreementNumber === "CD-25/45507"));
  // T9: kktstat parser reads Infos[].
  check("T9 kktstat parser reads Infos[]", parseKktList({ Infos: [{ FnFactoryNumber: "9999", KktRegNumber: "RN1", KktName: "Касса 1", OutletName: "Клуб" }] }).length === 1 && parseKktList({ Infos: [{ FnFactoryNumber: "9999" }] })[0].fnNumber === "9999");
  // T10: secret masks / empty fields never overwrite a stored secret (mirror of enc()).
  const MASK_RE = /^[•·*∙•]+$/;
  const encFromForm = (raw, old) => { const v = (raw ?? "").trim(); return v && !MASK_RE.test(v) ? encryptOfd(v) : old; };
  const oldPw = encryptOfd("s3cret-pass");
  const keptEmpty = encFromForm("", oldPw);
  const keptMask = encFromForm("••••••", oldPw);
  const replaced = encFromForm("newpass", oldPw);
  check("T10 empty / mask secret keeps old ciphertext; a real value replaces it", keptEmpty === oldPw && keptMask === oldPw && decryptOfd(keptMask) === "s3cret-pass" && replaced !== oldPw && decryptOfd(replaced) === "newpass");

  // ===== Contract normalization + safe check-connection diagnostics ==========
  // Load the REAL normalizeContractNumber from src/lib/ofd/contract.ts so these
  // tests exercise production logic (homoglyph / zero-width folding included),
  // not a drifting copy. Tricky inputs use \u escapes — never invisible literals.
  const contractSource = readFileSync(new URL("../src/lib/ofd/contract.ts", import.meta.url), "utf8");
  const homoSrc = contractSource.match(/const HOMOGLYPHS[\s\S]*?\};/)[0].replace(": Record<string, string>", "");
  const normBody = contractSource.match(/export function normalizeContractNumber\(v[^)]*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/)[1];
  const normalizeContract = new Function("v", homoSrc + "\n" + normBody);

  // Mirror of checkOfdConnection: build availableContracts ONCE, then match the
  // requested договор against THAT SAME array (never the raw records).
  function buildCheckResult(cfg, accountData) {
    const availableContracts = accountData.records.map((r) => ({ agreementNumber: r.agreementNumber, companyName: r.companyName ?? null, inn: r.inn ?? null, kpp: r.kpp ?? null }));
    const requestedContractNumber = cfg.contractNumber && cfg.contractNumber.trim();
    const requestedNormalized = normalizeContract(requestedContractNumber);
    const matchedContract = requestedContractNumber ? availableContracts.find((cn) => normalizeContract(cn.agreementNumber) === requestedNormalized) : undefined;
    if (!requestedContractNumber) return { ok: true, notice: "Подключение успешно. Укажите номер договора, если в логине несколько ЛК." };
    if (matchedContract) return { ok: true, notice: "Подключение успешно. Договор найден в доступных ЛК Такском.", matchedContract };
    return { ok: false, code: "contract_not_found", error: "Подключение выполнено, но номер договора не найден среди доступных ЛК Такском.", diagnostics: { currentSession: accountData.currentAgreementNumber, requestedContractNumber, availableContracts } };
  }
  // The real production AccountList (records_count=3, target as record 3) + secret-laden cfg + extras.
  const rawAccountList = { sessionToken: "SECRET-SESSION-TOKEN", currentSession: { agreementNumber: "CD-24/00001", accessRights: "full" }, records: [
    { agreementNumber: "CD-22/380310", companyName: "ИП АЛМАКАЕВ", inn: "744605538886", accessRights: "full" },
    { agreementNumber: "CD-22/368037", companyName: "ООО ФИТНЕС", inn: "6678088885", kpp: "661701001", accessRights: "read" },
    { agreementNumber: "CD-25/45507", companyName: "ООО СПОРТ ТЕХНОЛОГИИ", inn: "6679182168", kpp: "667901001", accessRights: "full" },
  ] };
  const parsedAcc = parseAccountList(rawAccountList);
  const secretCfg = { contractNumber: "CD-25/45507", login: "myLogin", password: "s3cret-pass", integratorId: "INT-1", integrationToken: null };
  // T11 — the EXACT production scenario: requested CD-25/45507, present among ЛК → success, NOT contract_not_found.
  const prodOk = buildCheckResult(secretCfg, parsedAcc);
  check("T11 PRODUCTION: requested CD-25/45507 present in availableContracts -> success (NOT contract_not_found)", prodOk.ok === true && prodOk.code !== "contract_not_found" && prodOk.matchedContract && prodOk.matchedContract.agreementNumber === "CD-25/45507" && prodOk.matchedContract.inn === "6679182168" && prodOk.matchedContract.kpp === "667901001");
  check("T11b match runs against the SAME availableContracts the UI shows (matchedContract in availableContracts)", notFoundList(secretCfg).some((a) => a.agreementNumber === prodOk.matchedContract.agreementNumber));
  function notFoundList(cfg) { return buildCheckResult({ ...cfg, contractNumber: "CD-00/00000" }, parsedAcc).diagnostics.availableContracts; }
  check("T12 match with spaces around ('  CD-25/45507  ')", buildCheckResult({ ...secretCfg, contractNumber: "  CD-25/45507  " }, parsedAcc).ok === true);
  check("T13 match with non-breaking space (U+00A0) + zero-width space (U+200B) folded", buildCheckResult({ ...secretCfg, contractNumber: "CD-25/ 45507" }, parsedAcc).ok === true && buildCheckResult({ ...secretCfg, contractNumber: "CD-25/​45507" }, parsedAcc).ok === true && normalizeContract("CD-25/ 45507") === "cd-25/45507");
  check("T14 match with long dash (en-dash U+2013 / em-dash U+2014 / minus U+2212 / NB-hyphen U+2011)", buildCheckResult({ ...secretCfg, contractNumber: "CD–25/45507" }, parsedAcc).ok === true && buildCheckResult({ ...secretCfg, contractNumber: "CD—25/45507" }, parsedAcc).ok === true && normalizeContract("CD−25/45507") === "cd-25/45507" && normalizeContract("CD‑25/45507") === "cd-25/45507");
  check("T14b PRODUCTION-likely cause: Cyrillic homoglyph C (U+0421) in stored value still matches", buildCheckResult({ ...secretCfg, contractNumber: "СD-25/45507" }, parsedAcc).ok === true && normalizeContract("СD-25/45507") === "cd-25/45507");
  check("T15 parser reads data.records[] (3 records, target is record 3)", parsedAcc.records.length === 3 && parsedAcc.records[2].agreementNumber === "CD-25/45507" && parsedAcc.records[2].inn === "6679182168" && parsedAcc.records[2].kpp === "667901001");
  // contract_not_found -> safe diagnostics with availableContracts.
  const notFound = buildCheckResult({ ...secretCfg, contractNumber: "CD-00/00000" }, parsedAcc);
  check("T16 contract_not_found returns availableContracts (agreementNumber/companyName/inn/kpp)", notFound.ok === false && notFound.code === "contract_not_found" && notFound.diagnostics.requestedContractNumber === "CD-00/00000" && notFound.diagnostics.availableContracts.length === 3 && notFound.diagnostics.availableContracts[2].agreementNumber === "CD-25/45507" && notFound.diagnostics.availableContracts[2].inn === "6679182168" && notFound.diagnostics.currentSession === "CD-24/00001");
  const successJson = JSON.stringify(prodOk);
  const notFoundJson = JSON.stringify(notFound);
  check("T17 no secrets / raw AccountList in EITHER result (no login/password/Integrator-ID/SessionToken/accessRights)", [successJson, notFoundJson].every((j) => !j.includes("myLogin") && !j.includes("s3cret-pass") && !j.includes("INT-1") && !/sessionToken/i.test(j) && !j.includes("SECRET-SESSION-TOKEN") && !j.includes("accessRights")));
  check("T18 matchedContract + availableContracts carry ONLY safe fields (no accessRights key survives parser)", Object.keys(prodOk.matchedContract).sort().join(",") === "agreementNumber,companyName,inn,kpp" && notFound.diagnostics.availableContracts.every((a) => Object.keys(a).sort().join(",") === "agreementNumber,companyName,inn,kpp"));

  await cleanup();

  // ===== Static assertions on the real source =====
  const crypto = readFileSync(new URL("../src/lib/ofd/crypto.ts", import.meta.url), "utf8");
  const importer = readFileSync(new URL("../src/lib/ofd/importer.ts", import.meta.url), "utf8");
  const clientSrc = readFileSync(new URL("../src/lib/ofd/taxcom/client.ts", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../src/lib/ofd/taxcom/adapter.ts", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../src/app/(app)/settings/integrations/ofd/actions.ts", import.meta.url), "utf8");
  const contractSrc = readFileSync(new URL("../src/lib/ofd/contract.ts", import.meta.url), "utf8");
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

  // --- Taxcom login/contract-diagnostics fixes (real source) ---
  check("T-S1 Login body is ONLY login/password (or integrationToken) — agreementNumber NOT built or sent", clientSrc.includes("loginBody.login = cfg.login") && clientSrc.includes("loginBody.password = cfg.password") && !clientSrc.includes("loginBody.agreementNumber") && !clientSrc.includes("agreementNumber = agreement"));
  // Static guard: the ensureSession() body (which builds the Login request) must
  // contain NO "agreementNumber" at all — the word only survives in comments and
  // in parseAccountList (parsing the AccountList RESPONSE), never in the Login body.
  const ensureRaw = clientSrc.slice(clientSrc.indexOf("async function ensureSession"), clientSrc.indexOf("async function ensureSession") + 800);
  // Strip // comment lines (the word survives in the explanatory comment) — the
  // remaining CODE that builds the Login body must never mention agreementNumber.
  const ensureCode = ensureRaw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  check("T-S1b no agreementNumber built or sent in ensureSession()/Login body", !/agreementNumber/i.test(ensureCode) && !clientSrc.includes("loginBody.agreementNumber"));
  check("T-S2 Integrator-ID header on requests (never logged)", clientSrc.includes('headers["Integrator-ID"] = cfg.integratorId') && !clientSrc.includes("console."));
  check("T-S3 token read from sessionToken/token/accessToken", clientSrc.includes("d?.sessionToken ?? d?.SessionToken ?? d?.token ?? d?.accessToken"));
  check("T-S4 classifyTaxcomError: 3103→kkt_not_found, 2108→auth_failed, 3106→no_kkt_found", clientSrc.includes("apiErrorCode === 3103") && clientSrc.includes("apiErrorCode === 2108") && clientSrc.includes("apiErrorCode === 3106") && clientSrc.includes('safeCode: "kkt_not_found"') && clientSrc.includes('safeCode: "no_kkt_found"'));
  check("T-S5 error body extracts only apiErrorCode/commonDescription (no raw body returned)", clientSrc.includes("extractApiError") && clientSrc.includes("commonDescription") && clientSrc.includes(".slice(0, 200)"));
  check("T-S6 client exposes listAccounts via GET /API/v2/AccountList + parseAccountList (safe fields)", clientSrc.includes("accountList: \"/API/v2/AccountList\"") && clientSrc.includes("async listAccounts()") && clientSrc.includes('raw(PATHS.accountList, { method: "GET"') && clientSrc.includes("export function parseAccountList") && clientSrc.includes("agreementNumber") && clientSrc.includes("companyName"));
  // --- GET verb fix for ShiftList / DocumentList (real source) ---
  const shiftCall = clientSrc.slice(clientSrc.indexOf("async listShifts("), clientSrc.indexOf("async listShifts(") + 420);
  const docCall = clientSrc.slice(clientSrc.indexOf("async listDocumentsByShift("), clientSrc.indexOf("async listDocumentsByShift(") + 420);
  check("T-S7 ShiftList uses GET with fn/begin/end/pn/ps query (NOT POST, no body)", clientSrc.includes('shiftList: "/API/v2/ShiftList"') && /raw\(PATHS\.shiftList,\s*\{\s*method:\s*"GET"/.test(shiftCall) && shiftCall.includes("query: { fn: fnNumber, begin: dateFrom, end: dateTo, pn: 1, ps: 100 }") && !/method:\s*"POST"/.test(shiftCall) && !/\bbody:/.test(shiftCall));
  check("T-S7b DocumentList uses GET with fn/shift query (NOT POST, no body)", clientSrc.includes('documentList: "/API/v2/DocumentList"') && /raw\(PATHS\.documentList,\s*\{\s*method:\s*"GET"/.test(docCall) && docCall.includes("query: { fn: fnNumber, shift: shiftNumber }") && !/method:\s*"POST"/.test(docCall) && !/\bbody:/.test(docCall));
  // Static guard: NO POST anywhere for the shift/document list endpoints.
  check("T-S7c no POST for ShiftList/DocumentList anywhere in client.ts", !/PATHS\.shiftList[\s\S]{0,120}method:\s*"POST"/.test(clientSrc) && !/PATHS\.documentList[\s\S]{0,120}method:\s*"POST"/.test(clientSrc) && !/raw\(PATHS\.shiftList,\s*\{\s*Fn:/.test(clientSrc) && !/raw\(PATHS\.documentList,\s*\{\s*Fn:/.test(clientSrc));
  check("T-S7d raw() supports GET query via URLSearchParams, body only on POST", clientSrc.includes("new URLSearchParams()") && clientSrc.includes('method === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}') && clientSrc.includes('headers: Record<string, string> = { Accept: "application/json" }'));
  check("T-S7e classifyTaxcomError maps method-not-supported → taxcom_method_not_allowed", clientSrc.includes('does not support http method') && clientSrc.includes('safeCode: "taxcom_method_not_allowed"'));
  check("T-S7f ShiftList/DocumentList parsers read records/Records/Items/items + shifts/documents keys", /parseShiftList[\s\S]*?asArray\(data, "records", "Records", "Items", "items", "Shifts", "shifts"/.test(clientSrc) && /parseDocumentList[\s\S]*?asArray\(data, "records", "Records", "Items", "items", "Documents", "documents"/.test(clientSrc));
  // Static guard: no buyer PII / raw fiscal JSON is parsed, stored or logged.
  check("T-S7g no phone/email/buyer/customer/rawJson fields, no console logging in client.ts", !/phone|email|buyerName|customer|rawJson|rawResponse/i.test(clientSrc) && !clientSrc.includes("console."));
  check("7 save NO LONGER blocks on empty contractNumber (contract is non-blocking)", !actions.includes('authType === "login_password" && !contractNumber') && !actions.includes("Укажите номер договора Такском"));
  check("8 secret masks / empty fields never overwrite stored ciphertext (enc guards mask+empty)", actions.includes("MASK_RE") && actions.includes("!MASK_RE.test(v)") && actions.includes("enc(\"login\") !== undefined"));
  check("9 checkOfdConnection: match requestedNormalized against the SAME availableContracts array (agreementNumber only), returns matchedContract; never token", actions.includes("export async function checkOfdConnection") && actions.includes("client.login()") && actions.includes("client.listAccounts()") && actions.includes("const availableContracts = accounts.data.records.map") && actions.includes("const requestedNormalized = normalizeContractNumber(requestedContractNumber)") && actions.includes("availableContracts.find((cn) => normalizeContractNumber(cn.agreementNumber) === requestedNormalized)") && actions.includes("notice: \"Подключение успешно. Договор найден в доступных ЛК Такском.\", matchedContract") && actions.includes("не найден среди доступных ЛК") && !/return\s*\{[^}]*sessionToken/.test(actions));
  check("9a match is by agreementNumber only — companyName/inn/kpp do NOT gate success", actions.includes("normalizeContractNumber(cn.agreementNumber) === requestedNormalized") && !/find\(\(cn\) => [^)]*companyName[^)]*===/.test(actions) && !/find\(\(cn\) => [^)]*inn[^)]*===/.test(actions));
  check("9b normalizeContractNumber (lib/ofd/contract) folds dashes + strips whitespace/zero-width + Cyrillic homoglyphs + NFKC; NOT a server export", contractSrc.includes("export function normalizeContractNumber") && contractSrc.includes("HOMOGLYPHS") && contractSrc.includes('.normalize("NFKC")') && contractSrc.includes(".toLowerCase()") && actions.includes('from "@/lib/ofd/contract"') && !actions.includes("export function normalizeContractNumber"));
  check("9c contract_not_found returns SAFE diagnostics (currentSession/requestedContractNumber/availableContracts, no secrets)", actions.includes('code: "contract_not_found"') && actions.includes("requestedContractNumber,") && actions.includes("availableContracts,") && actions.includes("currentSession: accounts.data.currentAgreementNumber") && actions.includes("agreementNumber: r.agreementNumber") && actions.includes("companyName: r.companyName") && actions.includes("inn: r.inn") && actions.includes("kpp: r.kpp") && !/availableContracts[\s\S]{0,200}(login|password|integratorId|sessionToken)/i.test(actions));
  check("kktstat parser reads Infos + FnFactoryNumber/Outlet fields", clientSrc.includes('asArray(data, "Infos", "infos"') && clientSrc.includes("FnFactoryNumber") && clientSrc.includes("OutletName"));
  check("UI: contract field non-blocking + new help + per-authType secrets + Проверить подключение", forms.includes("Номер договора Такском") && !/name="contractNumber"[^>]*required/.test(forms) && forms.includes("Сам Login Такском выполняется без этого поля") && forms.includes("isTokenAuth") && forms.includes("OfdCheckConnection") && forms.includes("Проверить подключение"));
  check("UI: contract_not_found panel shows Искомый договор / Текущий ЛК / Доступные договоры + availableContracts list", forms.includes('state.code === "contract_not_found"') && forms.includes("diag.availableContracts.map") && forms.includes("Искомый договор") && forms.includes("Текущий ЛК Такском") && forms.includes("Доступные договоры Такском") && forms.includes("a.agreementNumber") && forms.includes("a.companyName") && forms.includes("a.inn") && forms.includes("a.kpp"));
  check("UI: success shows green matchedContract line 'Договор найден: …' (agreementNumber/companyName/inn/kpp)", forms.includes("state.matchedContract") && forms.includes("Договор найден:") && forms.includes("contractLabel(matched)") && forms.includes("border-emerald") && forms.includes("a.kpp ? `КПП"));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
