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
const mapOp = (raw) => { const s = String(raw ?? "").trim().toLowerCase(); if (s === "income" || s === "приход") return "income"; if (s === "incomereturn" || s === "income_return" || s === "return" || s === "возврат прихода") return "income_return"; return null; };
const isServiceDocumentType = (t) => { const s = String(t ?? "").trim(); return s === "2" || s === "5"; };
const dedupe = (fn, fd, fpd) => { const f = fpd && String(fpd).trim() ? String(fpd).trim() : null; return f ? `taxcom:${fn}:${fd}:${f}` : `taxcom:${fn}:${fd}`; };
function normalize(doc) {
  if (isServiceDocumentType(doc.documentType)) return null; // opening/closing shift
  const op = mapOp(doc.operationType); if (!op) return null;
  const date = new Date(doc.dateTime); if (Number.isNaN(date.getTime())) return null;
  if (!doc.fn || !Number.isFinite(doc.fd) || Math.trunc(doc.fd) <= 0) return null;
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
async function runImport({ connectionId, companyId, dateFrom, dateTo, client, mappings, contractNumber, normalizeContract }) {
  const run = await p.ofdSyncRun.create({ data: { connectionId, companyId, mode: "manual_period", dateFrom, dateTo, status: "running", startedAt: new Date() } });
  const days = eachDay(dateFrom, dateTo);
  // Account guard (mirror of importer): if the connection targets a договор but the
  // current ЛК differs, fail fast with account_check — never touch ShiftList.
  if (contractNumber && contractNumber.trim() && normalizeContract && client.listAccounts) {
    const accounts = await client.listAccounts();
    const want = accounts.ok ? normalizeContract(contractNumber) : null;
    const cur = accounts.ok ? accounts.data.currentAgreementNumber : null;
    const available = accounts.ok ? (accounts.data.records || []).map((r) => r.agreementNumber) : [];
    const hasCurrent = Boolean(cur && String(cur).trim());
    const valid = accounts.ok && (normalizeContract(cur) === want || (!hasCurrent && available.length === 1 && normalizeContract(available[0]) === want));
    if (accounts.ok && !valid) {
      await p.ofdSyncError.create({ data: { syncRunId: run.id, connectionId, companyId, clubId: null, fnNumber: null, stage: "account_check", safeCode: "taxcom_wrong_current_account", safeMessage: "Текущий ЛК Такском не соответствует выбранному договору." } });
      await p.ofdSyncRun.update({ where: { id: run.id }, data: { status: "failed", finishedAt: new Date(), safeErrorCode: "taxcom_wrong_current_account", safeErrorMessage: "Текущий ЛК Такском не соответствует выбранному договору." } });
      return { runId: run.id, found: 0, imported: 0, skipped: 0, status: "failed", blocked: true };
    }
  }
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
  const readSession = (v) => { if (typeof v === "string") return s2(v); if (v && typeof v === "object") return s2(v.agreementNumber ?? v.AgreementNumber ?? v.contractNumber ?? v.ContractNumber); return null; };
  const parseAccountList = (data) => {
    const d = data ?? {};
    // currentSession may be a plain STRING or an object — accept both, all casings.
    const currentAgreementNumber = readSession(d.currentSession) ?? readSession(d.CurrentSession) ?? readSession(d.current_session) ?? readSession(d.current) ?? readSession(d.currentAccount) ?? readSession(d.CurrentAccount) ?? s2(d.currentAgreementNumber ?? d.CurrentAgreementNumber);
    const arr = Array.isArray(d) ? d : (d.records ?? d.Records ?? d.Items ?? d.items ?? d.accounts ?? []);
    const records = (arr || []).map((o) => ({ agreementNumber: s2(o.agreementNumber ?? o.AgreementNumber ?? o.contractNumber), companyName: s2(o.companyName ?? o.CompanyName ?? o.name), inn: s2(o.inn ?? o.Inn ?? o.INN), kpp: s2(o.kpp ?? o.Kpp ?? o.KPP) }));
    return { currentAgreementNumber, records };
  };
  const parseShiftList = (data) => asArr(data, ["records", "Records", "Items", "items", "Shifts", "shifts", "ShiftList"]).map((o) => ({ shiftNumber: num2(o.Shift ?? o.ShiftNumber ?? o.shift ?? o.shiftNumber ?? o.Number ?? o.number), dateOpen: s2(o.OpenDate ?? o.openDate ?? o.openedAt ?? o.DateOpen ?? o.dateOpen), dateClose: s2(o.CloseDate ?? o.closeDate ?? o.closedAt ?? o.DateClose ?? o.dateClose) })).filter((s) => Number.isFinite(s.shiftNumber));
  const parseDocumentList = (data, ctx) => asArr(data, ["records", "Records", "Items", "items", "Documents", "documents", "DocumentList"]).map((o) => ({ fn: s2(o.FnFactoryNumber ?? o.fnFactoryNumber ?? o.Fn ?? o.fn) ?? (ctx?.fn ?? ""), shift: num2(o.ShiftNumber ?? o.shiftNumber ?? o.Shift ?? o.shift) || (ctx?.shift ?? 0), documentType: s2(o.documentType ?? o.DocumentType ?? o.Type ?? o.type), numberInShift: (o.numberInShift ?? o.NumberInShift) != null ? num2(o.numberInShift ?? o.NumberInShift) : null, dateTime: String(o.DateTime ?? o.dateTime ?? o.Date ?? o.date ?? ""), fd: num2(o.FdNumber ?? o.fdNumber ?? o.Fd ?? o.fd ?? o.FiscalDocumentNumber), fpd: s2(o.Fpd ?? o.fpd ?? o.FiscalSign), operationType: s2(o.accountingType ?? o.AccountingType ?? o.OperationType ?? o.operationType ?? o.Operation), totalKopeks: num2(o.Sum ?? o.sum ?? o.TotalKopeks ?? o.totalKopeks ?? o.Total), cashKopeks: num2(o.Cash ?? o.cash ?? o.CashKopeks ?? o.cashKopeks), electronicKopeks: num2(o.Electronic ?? o.electronic ?? o.ElectronicKopeks ?? o.electronicKopeks) }));

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

  // ===== PRODUCTION DocumentList (records[] + documentType/accountingType) ====
  // Exact production response: top keys reportDate/counts/records, 15 documents:
  // 1× documentType '2' (open shift), 13× '3' Income, 1× '5' (close shift).
  const PROD_FN = "7381440800719861", PROD_SHIFT = 463;
  const prodIncomeDocs = [
    // 5 cash receipts → cash total 1 280 000 (first two match the real examples)
    { fdNumber: 4935, fpd: "767269098", dateTime: "2026-07-15T10:27:00", sum: 200000, cash: 200000, electronic: 0 },
    { fdNumber: 4936, fpd: "3784382549", dateTime: "2026-07-15T14:22:00", sum: 570000, cash: 570000, electronic: 0 },
    { fdNumber: 4937, fpd: "111", dateTime: "2026-07-15T15:00:00", sum: 150000, cash: 150000, electronic: 0 },
    { fdNumber: 4938, fpd: "112", dateTime: "2026-07-15T15:10:00", sum: 150000, cash: 150000, electronic: 0 },
    { fdNumber: 4939, fpd: "113", dateTime: "2026-07-15T15:20:00", sum: 210000, cash: 210000, electronic: 0 },
    // 8 electronic receipts → electronic total 3 349 900
    { fdNumber: 4940, fpd: "114", dateTime: "2026-07-15T15:30:00", sum: 400000, cash: 0, electronic: 400000 },
    { fdNumber: 4941, fpd: "115", dateTime: "2026-07-15T16:00:00", sum: 400000, cash: 0, electronic: 400000 },
    { fdNumber: 4942, fpd: "116", dateTime: "2026-07-15T16:10:00", sum: 400000, cash: 0, electronic: 400000 },
    { fdNumber: 4943, fpd: "117", dateTime: "2026-07-15T16:20:00", sum: 400000, cash: 0, electronic: 400000 },
    { fdNumber: 4944, fpd: "118", dateTime: "2026-07-15T16:30:00", sum: 400000, cash: 0, electronic: 400000 },
    { fdNumber: 4945, fpd: "119", dateTime: "2026-07-15T17:00:00", sum: 400000, cash: 0, electronic: 400000 },
    { fdNumber: 4946, fpd: "120", dateTime: "2026-07-15T17:10:00", sum: 400000, cash: 0, electronic: 400000 },
    { fdNumber: 4947, fpd: "121", dateTime: "2026-07-15T17:20:00", sum: 549900, cash: 0, electronic: 549900 },
  ].map((d, i) => ({ documentType: "3", accountingType: "Income", numberInShift: i + 1, ...d }));
  const prodDocResponse = { reportDate: "2026-07-15", counts: { total: 15 }, records: [
    { documentType: "2", accountingType: null, dateTime: "2026-07-15T10:00:00", fdNumber: 4934, numberInShift: 0, fpd: "1571686074", sum: 0, cash: 0, electronic: 0 },
    ...prodIncomeDocs,
    { documentType: "5", accountingType: null, dateTime: "2026-07-15T21:47:00", fdNumber: 4948, numberInShift: 0, fpd: "780047272", sum: 0, cash: 0, electronic: 0 },
  ] };
  const prodParsed = parseDocumentList(prodDocResponse, { fn: PROD_FN, shift: PROD_SHIFT });
  check("TD1 production DocumentList: 15 records parsed, fields fdNumber/fpd/dateTime/sum/cash/electronic read", prodParsed.length === 15 && prodParsed[1].fd === 4935 && prodParsed[1].fpd === "767269098" && prodParsed[1].dateTime === "2026-07-15T10:27:00" && prodParsed[1].totalKopeks === 200000 && prodParsed[1].cashKopeks === 200000 && prodParsed[1].electronicKopeks === 0 && prodParsed[1].operationType === "Income" && prodParsed[1].documentType === "3" && prodParsed[1].fn === PROD_FN && prodParsed[1].shift === PROD_SHIFT);
  const prodNorm = prodParsed.map(normalize).filter(Boolean);
  check("TD2 service documentType 2/5 skipped, only 13 Income receipts normalized", prodNorm.length === 13 && prodNorm.every((r) => r.operationType === "income") && normalize(prodParsed[0]) === null && normalize(prodParsed[14]) === null);
  const tSum = prodNorm.reduce((a, r) => a + r.totalKopeks, 0), tCash = prodNorm.reduce((a, r) => a + r.cashKopeks, 0), tEl = prodNorm.reduce((a, r) => a + r.electronicKopeks, 0);
  check("TD3 totals: income 4629900 / cash 1280000 / electronic 3349900 (sum=cash+electronic)", tSum === 4629900 && tCash === 1280000 && tEl === 3349900 && tCash + tEl === tSum);
  check("TD4 dedupeKey uses taxcom:<fn>:<fd>:<fpd>; empty fpd falls back to fn:fd", prodNorm[0].dedupeKey === `taxcom:${PROD_FN}:4935:767269098` && dedupe(PROD_FN, 4935, "") === `taxcom:${PROD_FN}:4935`);
  // DB-backed import of the production shift → 13/13/0, then idempotent re-run.
  const mapProd = await p.ofdCashRegisterMapping.create({ data: { connectionId: CONN, companyId: CO, clubId: clubA.id, provider: "taxcom", fnNumber: PROD_FN, isActive: true, activeMappingKey: `taxcom:${PROD_FN}` } });
  const prodClient = { listShifts: async () => ({ ok: true, data: [{ shiftNumber: PROD_SHIFT }] }), listDocumentsByShift: async (fn, shift) => ({ ok: true, data: parseDocumentList(prodDocResponse, { fn, shift }) }) };
  const pr1 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-15", dateTo: "2026-07-15", client: prodClient, mappings: [mapProd] });
  check("TD5 first import: found 13 / imported 13 / skipped 0 (13 real receipts, service docs skipped)", pr1.found === 13 && pr1.imported === 13 && pr1.skipped === 0 && pr1.status === "success" && (await p.ofdReceiptImport.count({ where: { companyId: CO, fnNumber: PROD_FN } })) === 13);
  const pr2 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-15", dateTo: "2026-07-15", client: prodClient, mappings: [mapProd] });
  check("TD6 re-import idempotent: found 13 / imported 0 / skipped 13, no duplicates", pr2.found === 13 && pr2.imported === 0 && pr2.skipped === 13 && (await p.ofdReceiptImport.count({ where: { companyId: CO, fnNumber: PROD_FN } })) === 13);
  const prodSummary = await p.ofdDailySalesSummary.findUnique({ where: { summaryKey: summaryKeyOf(CO, clubA.id, null, "taxcom", "2026-07-15") } });
  check("TD7 OfdDailySalesSummary recomputed: income 4629900 / cash 1280000 / electronic 3349900 / return 0 / net 4629900 / receiptCount 13", prodSummary.incomeTotalKopeks === 4629900 && prodSummary.incomeCashKopeks === 1280000 && prodSummary.incomeElectronicKopeks === 3349900 && prodSummary.returnTotalKopeks === 0 && prodSummary.netTotalKopeks === 4629900 && prodSummary.receiptCount === 13 && prodSummary.returnReceiptCount === 0);
  const noErr = await p.ofdSyncError.count({ where: { syncRunId: { in: [pr1.runId, pr2.runId] } } });
  check("TD8 no OfdSyncError for production import (service docs are NOT errors)", noErr === 0);
  const storedProd = await p.ofdReceiptImport.findFirst({ where: { companyId: CO, fnNumber: PROD_FN } });
  const storedKeys = Object.keys(storedProd);
  check("TD9 stored receipt has NO raw JSON / PII columns (no phone/email/name/items/rawJson)", !storedKeys.some((k) => /phone|email|name|buyer|customer|items|rawjson|rawresponse|fio/i.test(k)));
  const oldShapeDoc = { Fn: "FN-X", Shift: 7, Fd: 900, Fpd: "Z", DateTime: "2026-07-15T12:00:00.000Z", OperationType: "Income", Sum: 5000, Cash: 5000 };
  check("TD10 old DocumentList shapes still parse (Fn/Fd/OperationType/Sum + Items key)", parseDocumentList({ Items: [oldShapeDoc] })[0].fd === 900 && normalize(parseDocumentList({ Items: [oldShapeDoc] })[0]).totalKopeks === 5000 && normalize(parseDocumentList({ Items: [oldShapeDoc] })[0]).operationType === "income");
  await p.ofdCashRegisterMapping.delete({ where: { id: mapProd.id } });
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
  // Mirror of isCurrentAccountValid (contract.ts): active ЛК must equal contract,
  // with a safe single-record fallback when currentSession is absent.
  const isCurrentAccountValid = (currentSession, contractNumber, available) => {
    const want = normalizeContract(contractNumber);
    if (!want) return true;
    if (normalizeContract(currentSession) === want) return true;
    const hasCurrent = Boolean(currentSession && String(currentSession).trim());
    if (!hasCurrent && available.length === 1 && normalizeContract(available[0]) === want) return true;
    return false;
  };

  // Mirror of checkOfdConnection: build availableContracts ONCE, match the
  // requested договор against THAT SAME array, then require the CURRENT ЛК
  // (currentSession) to be valid — a listed-but-not-current договор is a warning,
  // not a green success (ShiftList runs on currentSession).
  function buildCheckResult(cfg, accountData) {
    const availableContracts = accountData.records.map((r) => ({ agreementNumber: r.agreementNumber, companyName: r.companyName ?? null, inn: r.inn ?? null, kpp: r.kpp ?? null }));
    const requestedContractNumber = cfg.contractNumber && cfg.contractNumber.trim();
    const requestedNormalized = normalizeContract(requestedContractNumber);
    const matchedContract = requestedContractNumber ? availableContracts.find((cn) => normalizeContract(cn.agreementNumber) === requestedNormalized) : undefined;
    const currentSession = accountData.currentAgreementNumber;
    if (!requestedContractNumber) return { ok: true, notice: "Подключение успешно. Укажите номер договора, если в логине несколько ЛК." };
    if (matchedContract) {
      if (isCurrentAccountValid(currentSession, requestedContractNumber, availableContracts.map((cn) => cn.agreementNumber))) return { ok: true, notice: "Подключение успешно. Текущий ЛК Такском соответствует выбранному договору.", matchedContract, currentSession };
      return { ok: false, code: "taxcom_wrong_current_account", error: "Подключение выполнено, договор доступен, но текущий ЛК Такском отличается от выбранного договора. Импорт будет невозможен, пока API-сессия не будет открыта в нужном ЛК.", matchedContract, diagnostics: { currentSession, requestedContractNumber, matchedContract, availableContracts } };
    }
    return { ok: false, code: "contract_not_found", error: "Подключение выполнено, но номер договора не найден среди доступных ЛК Такском.", diagnostics: { currentSession, requestedContractNumber, availableContracts } };
  }
  // Production AccountList (records_count=3, target CD-25/45507 is record 3).
  // MATCH variant: currentSession = the target договор → import works.
  const rawAccountList = { sessionToken: "SECRET-SESSION-TOKEN", currentSession: { agreementNumber: "CD-25/45507", accessRights: "full" }, records: [
    { agreementNumber: "CD-22/380310", companyName: "ИП АЛМАКАЕВ", inn: "744605538886", accessRights: "full" },
    { agreementNumber: "CD-22/368037", companyName: "ООО ФИТНЕС", inn: "6678088885", kpp: "661701001", accessRights: "read" },
    { agreementNumber: "CD-25/45507", companyName: "ООО СПОРТ ТЕХНОЛОГИИ", inn: "6679182168", kpp: "667901001", accessRights: "full" },
  ] };
  const parsedAcc = parseAccountList(rawAccountList);
  // WRONG-CURRENT variant: the EXACT production bug — договор listed, but the
  // API session is open in CD-22/368037, so kktstat returns the wrong ККТ.
  const rawAccountListWrong = { ...rawAccountList, currentSession: { agreementNumber: "CD-22/368037", accessRights: "read" } };
  const parsedAccWrong = parseAccountList(rawAccountListWrong);
  const secretCfg = { contractNumber: "CD-25/45507", login: "myLogin", password: "s3cret-pass", integratorId: "INT-1", integrationToken: null };
  // T11 — the EXACT production scenario: requested CD-25/45507, present among ЛК → success, NOT contract_not_found.
  const prodOk = buildCheckResult(secretCfg, parsedAcc);
  check("T11 contract present AND currentSession matches -> green success (текущий ЛК соответствует)", prodOk.ok === true && prodOk.code !== "contract_not_found" && prodOk.code !== "taxcom_wrong_current_account" && prodOk.notice.includes("Текущий ЛК Такском соответствует выбранному договору") && prodOk.matchedContract && prodOk.matchedContract.agreementNumber === "CD-25/45507" && prodOk.matchedContract.inn === "6679182168" && prodOk.matchedContract.kpp === "667901001");
  check("T11b match runs against the SAME availableContracts the UI shows (matchedContract in availableContracts)", notFoundList(secretCfg).some((a) => a.agreementNumber === prodOk.matchedContract.agreementNumber));
  function notFoundList(cfg) { return buildCheckResult({ ...cfg, contractNumber: "CD-00/00000" }, parsedAcc).diagnostics.availableContracts; }
  check("T12 match with spaces around ('  CD-25/45507  ')", buildCheckResult({ ...secretCfg, contractNumber: "  CD-25/45507  " }, parsedAcc).ok === true);
  check("T13 match with non-breaking space (U+00A0) + zero-width space (U+200B) folded", buildCheckResult({ ...secretCfg, contractNumber: "CD-25/ 45507" }, parsedAcc).ok === true && buildCheckResult({ ...secretCfg, contractNumber: "CD-25/​45507" }, parsedAcc).ok === true && normalizeContract("CD-25/ 45507") === "cd-25/45507");
  check("T14 match with long dash (en-dash U+2013 / em-dash U+2014 / minus U+2212 / NB-hyphen U+2011)", buildCheckResult({ ...secretCfg, contractNumber: "CD–25/45507" }, parsedAcc).ok === true && buildCheckResult({ ...secretCfg, contractNumber: "CD—25/45507" }, parsedAcc).ok === true && normalizeContract("CD−25/45507") === "cd-25/45507" && normalizeContract("CD‑25/45507") === "cd-25/45507");
  check("T14b PRODUCTION-likely cause: Cyrillic homoglyph C (U+0421) in stored value still matches", buildCheckResult({ ...secretCfg, contractNumber: "СD-25/45507" }, parsedAcc).ok === true && normalizeContract("СD-25/45507") === "cd-25/45507");
  check("T15 parser reads data.records[] (3 records, target is record 3)", parsedAcc.records.length === 3 && parsedAcc.records[2].agreementNumber === "CD-25/45507" && parsedAcc.records[2].inn === "6679182168" && parsedAcc.records[2].kpp === "667901001");
  // contract_not_found -> safe diagnostics with availableContracts.
  const notFound = buildCheckResult({ ...secretCfg, contractNumber: "CD-00/00000" }, parsedAcc);
  check("T16 contract_not_found returns availableContracts (agreementNumber/companyName/inn/kpp)", notFound.ok === false && notFound.code === "contract_not_found" && notFound.diagnostics.requestedContractNumber === "CD-00/00000" && notFound.diagnostics.availableContracts.length === 3 && notFound.diagnostics.availableContracts[2].agreementNumber === "CD-25/45507" && notFound.diagnostics.availableContracts[2].inn === "6679182168" && notFound.diagnostics.currentSession === "CD-25/45507");
  const successJson = JSON.stringify(prodOk);
  const notFoundJson = JSON.stringify(notFound);
  check("T17 no secrets / raw AccountList in EITHER result (no login/password/Integrator-ID/SessionToken/accessRights)", [successJson, notFoundJson].every((j) => !j.includes("myLogin") && !j.includes("s3cret-pass") && !j.includes("INT-1") && !/sessionToken/i.test(j) && !j.includes("SECRET-SESSION-TOKEN") && !j.includes("accessRights")));
  check("T18 matchedContract + availableContracts carry ONLY safe fields (no accessRights key survives parser)", Object.keys(prodOk.matchedContract).sort().join(",") === "agreementNumber,companyName,inn,kpp" && notFound.diagnostics.availableContracts.every((a) => Object.keys(a).sort().join(",") === "agreementNumber,companyName,inn,kpp"));

  // ===== Wrong current ЛК (taxcom_wrong_current_account) =====================
  // The EXACT production bug: договор CD-25/45507 IS listed, but currentSession is
  // CD-22/368037, so kktstat/ShiftList hit the wrong ККТ (3103). Must be a warning,
  // never a green success.
  const wrong = buildCheckResult(secretCfg, parsedAccWrong);
  check("TW1 contract present but currentSession differs -> taxcom_wrong_current_account (NOT success)", wrong.ok === false && wrong.code === "taxcom_wrong_current_account" && wrong.matchedContract && wrong.matchedContract.agreementNumber === "CD-25/45507");
  check("TW2 wrong-account diagnostics carry safe fields (currentSession + requestedContractNumber + matchedContract + availableContracts)", wrong.diagnostics.currentSession === "CD-22/368037" && wrong.diagnostics.requestedContractNumber === "CD-25/45507" && wrong.diagnostics.matchedContract.agreementNumber === "CD-25/45507" && wrong.diagnostics.availableContracts.length === 3);
  check("TW3 wrong-account diagnostics are SAFE-fields-only (no accessRights key survives)", Object.keys(wrong.diagnostics.matchedContract).sort().join(",") === "agreementNumber,companyName,inn,kpp" && wrong.diagnostics.availableContracts.every((a) => Object.keys(a).sort().join(",") === "agreementNumber,companyName,inn,kpp"));
  const wrongJson = JSON.stringify(wrong);
  check("TW4 no secrets / SessionToken / raw AccountList / accessRights in wrong-account result", !wrongJson.includes("myLogin") && !wrongJson.includes("s3cret-pass") && !wrongJson.includes("INT-1") && !/sessionToken/i.test(wrongJson) && !wrongJson.includes("SECRET-SESSION-TOKEN") && !wrongJson.includes("accessRights"));
  // Homoglyph/whitespace tolerance for currentSession comparison too.
  check("TW5 currentSession match is normalized (homoglyph / dash / case tolerant)", buildCheckResult({ ...secretCfg, contractNumber: "СD-25/45507" }, parsedAcc).ok === true && buildCheckResult({ ...secretCfg, contractNumber: "cd-25/45507" }, parsedAcc).ok === true);

  // Importer account guard (DB-backed): wrong current ЛК must block BEFORE ShiftList.
  let shiftCalledWrong = false;
  const wrongClient = {
    listAccounts: async () => ({ ok: true, data: { currentAgreementNumber: "CD-22/368037", records: [] } }),
    listShifts: async () => { shiftCalledWrong = true; return { ok: true, data: [] }; },
    listDocumentsByShift: async () => ({ ok: true, data: [] }),
  };
  const blockRun = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-10", dateTo: "2026-07-10", client: wrongClient, mappings: [mapA], contractNumber: "CD-25/45507", normalizeContract });
  check("TW6 importer BLOCKS before ShiftList on wrong current ЛК (status failed, ShiftList NOT called, found 0)", blockRun.blocked === true && blockRun.status === "failed" && blockRun.found === 0 && blockRun.imported === 0 && shiftCalledWrong === false);
  const acErr = await p.ofdSyncError.findFirst({ where: { syncRunId: blockRun.runId, stage: "account_check" } });
  check("TW7 account_check OfdSyncError = taxcom_wrong_current_account, safe message (no secrets/token)", acErr && acErr.stage === "account_check" && acErr.safeCode === "taxcom_wrong_current_account" && !/token|password|login|integrator|sessionToken/i.test(acErr.safeMessage || "") && acErr.fnNumber === null);
  const blockRunRow = await p.ofdSyncRun.findUnique({ where: { id: blockRun.runId } });
  check("TW7b run row marked failed with safeErrorCode, zero receipts", blockRunRow.status === "failed" && blockRunRow.safeErrorCode === "taxcom_wrong_current_account" && blockRunRow.foundReceipts === 0);
  // When currentSession matches, import proceeds to ShiftList as usual.
  let shiftCalledOk = false;
  const rightClient = {
    listAccounts: async () => ({ ok: true, data: { currentAgreementNumber: "CD-25/45507", records: [] } }),
    listShifts: async () => { shiftCalledOk = true; return { ok: true, data: [] }; },
    listDocumentsByShift: async () => ({ ok: true, data: [] }),
  };
  const okRun = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-11", dateTo: "2026-07-11", client: rightClient, mappings: [mapA], contractNumber: "CD-25/45507", normalizeContract });
  check("TW8 importer PROCEEDS to ShiftList when currentSession matches (no account_check block)", okRun.blocked === undefined && okRun.status === "success" && shiftCalledOk === true);

  // ===== currentSession as a STRING — the EXACT production shape (CD-25/455507) =====
  // Production AccountList returns currentSession: "CD-25/455507" (STRING), records_count=1.
  const prodStringAcc = { sessionToken: "SECRET-SESSION-TOKEN", currentSession: "CD-25/455507", records: [{ agreementNumber: "CD-25/455507", companyName: "ООО СПОРТ ТЕХНОЛОГИИ", inn: "6679182168", kpp: "667901001", accessRights: "full" }] };
  const parsedStr = parseAccountList(prodStringAcc);
  check("TS1 parseAccountList reads currentSession STRING -> CD-25/455507 (not null — the bug)", parsedStr.currentAgreementNumber === "CD-25/455507" && parsedStr.records.length === 1 && parsedStr.records[0].agreementNumber === "CD-25/455507");
  check("TS2 parseAccountList reads CurrentSession / current_session / current.* / currentAccount.* variants", parseAccountList({ CurrentSession: "CD-25/455507", records: [] }).currentAgreementNumber === "CD-25/455507" && parseAccountList({ current_session: "CD-25/455507", records: [] }).currentAgreementNumber === "CD-25/455507" && parseAccountList({ current: { agreementNumber: "CD-25/455507" }, records: [] }).currentAgreementNumber === "CD-25/455507" && parseAccountList({ current: { AgreementNumber: "CD-25/455507" }, records: [] }).currentAgreementNumber === "CD-25/455507" && parseAccountList({ currentAccount: { agreementNumber: "CD-25/455507" }, records: [] }).currentAgreementNumber === "CD-25/455507");
  const prodCfg = { contractNumber: "CD-25/455507", login: "myLogin", password: "s3cret-pass", integratorId: "INT-1", integrationToken: null };
  const prodCheck = buildCheckResult(prodCfg, parsedStr);
  check("TS3 checkOfdConnection: string currentSession == contract CD-25/455507 -> success (текущий ЛК соответствует)", prodCheck.ok === true && prodCheck.code !== "taxcom_wrong_current_account" && prodCheck.notice.includes("Текущий ЛК Такском соответствует выбранному договору") && prodCheck.currentSession === "CD-25/455507" && prodCheck.matchedContract.agreementNumber === "CD-25/455507");
  const prodCheckJson = JSON.stringify(prodCheck);
  check("TS3b success result has NO secrets / SessionToken / accessRights / raw AccountList", !prodCheckJson.includes("myLogin") && !prodCheckJson.includes("s3cret-pass") && !prodCheckJson.includes("INT-1") && !/sessionToken/i.test(prodCheckJson) && !prodCheckJson.includes("SECRET-SESSION-TOKEN") && !prodCheckJson.includes("accessRights"));
  // Safe fallback: currentSession absent, exactly 1 record matching contract -> valid.
  const noCurrentAcc = parseAccountList({ records: [{ agreementNumber: "CD-25/455507", companyName: "ООО СПОРТ ТЕХНОЛОГИИ", inn: "6679182168", kpp: "667901001" }] });
  check("TS4 fallback: no currentSession but exactly 1 matching договор -> valid (success), NOT wrong-account", noCurrentAcc.currentAgreementNumber === null && buildCheckResult(prodCfg, noCurrentAcc).ok === true && buildCheckResult(prodCfg, noCurrentAcc).code !== "taxcom_wrong_current_account");
  check("TS4b fallback only fires for a SINGLE record; present-but-different currentSession never overridden", isCurrentAccountValid(null, "CD-25/455507", ["CD-25/455507"]) === true && isCurrentAccountValid(null, "CD-25/455507", ["CD-25/455507", "CD-22/000000"]) === false && isCurrentAccountValid("CD-22/368037", "CD-25/455507", ["CD-25/455507"]) === false);
  // Importer: string currentSession that matches -> proceeds to ShiftList.
  let shiftCalledStr = false;
  const strClient = { listAccounts: async () => ({ ok: true, data: parseAccountList({ currentSession: "CD-25/455507", records: [{ agreementNumber: "CD-25/455507" }] }) }), listShifts: async () => { shiftCalledStr = true; return { ok: true, data: [] }; }, listDocumentsByShift: async () => ({ ok: true, data: [] }) };
  const strRun = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-12", dateTo: "2026-07-12", client: strClient, mappings: [mapA], contractNumber: "CD-25/455507", normalizeContract });
  check("TS5 importer: string currentSession == contract -> ShiftList CALLED (no account_check block)", strRun.blocked === undefined && strRun.status === "success" && shiftCalledStr === true);
  // Importer fallback: no currentSession, 1 matching record -> proceeds to ShiftList.
  let shiftCalledFb = false;
  const fbClient = { listAccounts: async () => ({ ok: true, data: parseAccountList({ records: [{ agreementNumber: "CD-25/455507" }] }) }), listShifts: async () => { shiftCalledFb = true; return { ok: true, data: [] }; }, listDocumentsByShift: async () => ({ ok: true, data: [] }) };
  const fbRun = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-13", dateTo: "2026-07-13", client: fbClient, mappings: [mapA], contractNumber: "CD-25/455507", normalizeContract });
  check("TS6 importer fallback: no currentSession + single matching договор -> ShiftList CALLED", fbRun.blocked === undefined && fbRun.status === "success" && shiftCalledFb === true);

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
  check("T-S6b parseAccountList reads currentSession as STRING and object variants (currentSession/CurrentSession/current_session/current/currentAccount)", clientSrc.includes("const readSession = (v: unknown): string | null =>") && clientSrc.includes('if (typeof v === "string") return str(v)') && clientSrc.includes("readSession(d.currentSession)") && clientSrc.includes("readSession(d.CurrentSession)") && clientSrc.includes("readSession(d.current_session)") && clientSrc.includes("readSession(d.current)") && clientSrc.includes("readSession(d.currentAccount)"));
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
  // --- Production DocumentList parsing (real source) ---
  check("T-S8 parseDocumentList reads production fields (fdNumber/accountingType/sum/cash/electronic/documentType) + fn/shift from ctx", clientSrc.includes("o.FdNumber ?? o.fdNumber") && clientSrc.includes("o.accountingType ?? o.AccountingType") && clientSrc.includes("o.Sum ?? o.sum") && clientSrc.includes("o.Cash ?? o.cash") && clientSrc.includes("o.Electronic ?? o.electronic") && clientSrc.includes("o.documentType ?? o.DocumentType") && clientSrc.includes("o.FnFactoryNumber ?? o.fnFactoryNumber") && clientSrc.includes("ctx?.fn") && clientSrc.includes("ctx?.shift"));
  check("T-S8b listDocumentsByShift passes { fn, shift } context to parseDocumentList", clientSrc.includes("parseDocumentList(r.data, { fn: fnNumber, shift: shiftNumber })"));
  check("T-S8c adapter skips service documentType 2/5 (isServiceDocumentType) before mapping accountingType", adapter.includes("export function isServiceDocumentType") && adapter.includes('t === "2" || t === "5"') && adapter.includes("if (isServiceDocumentType(doc.documentType)) return null") && adapter.includes("Math.trunc(doc.fd) <= 0"));
  check("T-S8d dedupe key = taxcom:<fn>:<fd>:<fpd> (fpd optional) — service docs never persisted", adapter.includes("`taxcom:${fnNumber}:${fiscalDocumentNumber}:${fpd}`") && adapter.includes("`taxcom:${fnNumber}:${fiscalDocumentNumber}`"));
  // Static guard: no buyer PII / raw fiscal JSON is parsed, stored or logged.
  check("T-S7g no phone/email/buyer/customer/rawJson fields, no console logging in client.ts", !/phone|email|buyerName|customer|rawJson|rawResponse/i.test(clientSrc) && !clientSrc.includes("console.") && !/phone|email|buyerName|customer|rawJson/i.test(adapter));
  check("7 save NO LONGER blocks on empty contractNumber (contract is non-blocking)", !actions.includes('authType === "login_password" && !contractNumber') && !actions.includes("Укажите номер договора Такском"));
  check("8 secret masks / empty fields never overwrite stored ciphertext (enc guards mask+empty)", actions.includes("MASK_RE") && actions.includes("!MASK_RE.test(v)") && actions.includes("enc(\"login\") !== undefined"));
  check("9 checkOfdConnection: match availableContracts + require currentSession valid via isCurrentAccountValid; success (+ currentSession) / wrong-account; never token", actions.includes("export async function checkOfdConnection") && actions.includes("client.login()") && actions.includes("client.listAccounts()") && actions.includes("availableContracts.find((cn) => normalizeContractNumber(cn.agreementNumber) === requestedNormalized)") && actions.includes("isCurrentAccountValid(currentSession, requestedContractNumber, availableContracts.map((cn) => cn.agreementNumber))") && actions.includes("if (currentAccountValid)") && actions.includes("Текущий ЛК Такском соответствует выбранному договору") && actions.includes("matchedContract, currentSession }") && actions.includes('code: "taxcom_wrong_current_account"') && actions.includes("не найден среди доступных ЛК") && !/return\s*\{[^}]*sessionToken/.test(actions));
  check("9a match is by agreementNumber only — companyName/inn/kpp do NOT gate success", actions.includes("normalizeContractNumber(cn.agreementNumber) === requestedNormalized") && !/find\(\(cn\) => [^)]*companyName[^)]*===/.test(actions) && !/find\(\(cn\) => [^)]*inn[^)]*===/.test(actions));
  check("9b normalizeContractNumber (lib/ofd/contract) folds dashes + strips whitespace/zero-width + Cyrillic homoglyphs + NFKC; NOT a server export", contractSrc.includes("export function normalizeContractNumber") && contractSrc.includes("HOMOGLYPHS") && contractSrc.includes('.normalize("NFKC")') && contractSrc.includes(".toLowerCase()") && actions.includes('from "@/lib/ofd/contract"') && !actions.includes("export function normalizeContractNumber"));
  check("9c contract_not_found returns SAFE diagnostics (currentSession/requestedContractNumber/availableContracts, no secret accessors)", actions.includes('code: "contract_not_found"') && actions.includes("requestedContractNumber,") && actions.includes("availableContracts,") && actions.includes("const currentSession = accounts.data.currentAgreementNumber") && actions.includes("agreementNumber: r.agreementNumber") && actions.includes("companyName: r.companyName") && actions.includes("inn: r.inn") && actions.includes("kpp: r.kpp") && !/diagnostics:\s*\{[\s\S]{0,300}(cfg\.login|cfg\.password|c\.login|c\.password|integratorId|sessionToken|decryptOfdSecret|loginEncrypted)/i.test(actions));
  check("9d taxcom_wrong_current_account warning: договор доступен but current ЛК differs; safe diagnostics incl matchedContract; never blocks with token", actions.includes('code: "taxcom_wrong_current_account"') && actions.includes("текущий ЛК Такском отличается от выбранного договора") && /diagnostics:\s*\{\s*currentSession,\s*requestedContractNumber,\s*matchedContract,\s*availableContracts,/.test(actions) && !/taxcom_wrong_current_account[\s\S]{0,400}(login|password|integratorId|sessionToken)/i.test(actions));
  check("9e importer AccountList guard: blocks before ShiftList when current ЛК invalid (isCurrentAccountValid, account_check + taxcom_wrong_current_account, status failed)", importer.includes("client.listAccounts()") && importer.includes("!isCurrentAccountValid(accounts.data.currentAgreementNumber, connection.contractNumber, accounts.data.records.map((r) => r.agreementNumber))") && importer.includes('"account_check"') && importer.includes('"taxcom_wrong_current_account"') && importer.includes('status: "failed"') && /account_check[\s\S]*?listShifts\(/.test(importer) && importer.includes('from "@/lib/ofd/contract"'));
  check("9f importer account guard runs BEFORE the ShiftList loop (fail fast, no 3103)", importer.indexOf('"account_check"') < importer.indexOf("client.listShifts(") && importer.indexOf("client.listAccounts()") < importer.indexOf("for (const m of mappings)"));
  check("9g isCurrentAccountValid (lib/ofd/contract): matches OR safe single-record fallback; present-but-different never overridden", contractSrc.includes("export function isCurrentAccountValid") && contractSrc.includes("normalizeContractNumber(currentSession) === want") && contractSrc.includes("availableAgreementNumbers.length === 1") && contractSrc.includes("!hasCurrent") && contractSrc.includes("normalizeContractNumber(availableAgreementNumbers[0]) === want"));
  check("kktstat parser reads Infos + FnFactoryNumber/Outlet fields", clientSrc.includes('asArray(data, "Infos", "infos"') && clientSrc.includes("FnFactoryNumber") && clientSrc.includes("OutletName"));
  check("UI: contract field non-blocking + new help + per-authType secrets + Проверить подключение", forms.includes("Номер договора Такском") && !/name="contractNumber"[^>]*required/.test(forms) && forms.includes("Сам Login Такском выполняется без этого поля") && forms.includes("isTokenAuth") && forms.includes("OfdCheckConnection") && forms.includes("Проверить подключение"));
  check("UI: contract_not_found panel shows Искомый договор / Текущий ЛК / Доступные договоры + availableContracts list", forms.includes('state.code === "contract_not_found"') && forms.includes("notFoundDiag.availableContracts") && forms.includes("items.map((a, i)") && forms.includes("Искомый договор") && forms.includes("Текущий ЛК Такском") && forms.includes("Доступные договоры Такском") && forms.includes("a.agreementNumber") && forms.includes("a.companyName") && forms.includes("a.inn") && forms.includes("a.kpp"));
  check("UI: success shows green matchedContract line 'Договор найден: …' + 'Текущий ЛК Такском: <currentSession>'", forms.includes("state.matchedContract") && forms.includes("Договор найден:") && forms.includes("contractLabel(matched)") && forms.includes("border-emerald") && forms.includes("a.kpp ? `КПП") && forms.includes("state.currentSession") && /Текущий ЛК Такском[\s\S]{0,80}state\.currentSession/.test(forms));
  check("UI: taxcom_wrong_current_account shows yellow block (текущий ЛК / нужен текущий ЛК / отдельный пользователь + available list)", forms.includes('state.code === "taxcom_wrong_current_account"') && forms.includes("но текущий ЛК Такском:") && forms.includes("Для импорта нужен текущий ЛК:") && forms.includes("Создайте отдельного пользователя Такском") && forms.includes("wrongAccountDiag.availableContracts"));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
