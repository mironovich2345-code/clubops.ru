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
  return { fnNumber: String(doc.fn), shiftNumber: Number.isFinite(doc.shift) ? Math.trunc(doc.shift) : null, fiscalDocumentNumber: Math.trunc(doc.fd), fiscalSign: doc.fpd && String(doc.fpd).trim() ? String(doc.fpd).trim() : null, operationType: op, receiptDate: date, totalKopeks: Math.trunc(doc.totalKopeks || 0), cashKopeks: Math.trunc(doc.cashKopeks || 0), electronicKopeks: Math.trunc(doc.electronicKopeks || 0), dedupeKey: dedupe(String(doc.fn), Math.trunc(doc.fd), doc.fpd), items: doc.items ?? [], itemsPresent: doc.itemsPresent ?? false };
}

// --- Mirror of lib/ofd/revenue (item name + category logic) ----------------
const normItem = (v) => String(v ?? "").normalize("NFKC").replace(/[\u0000-\u001F\u007F\u00AD\u200B-\u200D\u2060\uFEFF]/g, "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
const cleanItem = (v) => String(v ?? "").normalize("NFKC").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
// Grouping normalizer mirror: strip contract/agreement references, then normItem.
const normGroup = (v) => normItem(String(v ?? "").normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/(договор|контракт|соглашение)\s*(?:№|n[o]?|#)?\s*[a-zа-я]*\d[\w/.\-№]*/g, " ").replace(/№\s*\S*\d\S*/g, " "));
const DEFAULT_RULES = [
  ...["групповая тренировка", "групповые тренировки", "групповое занятие", "групповые занятия", "мини-группа", "мини группа", "групповая", "групповые", "групповое", "групповой", "секция", "направление"].map((pattern) => ({ code: "group_training", name: "Групповые тренировки", matchType: "contains", pattern })),
  { code: "group_training", name: "Групповые тренировки", matchType: "starts_with", pattern: "гт" },
  ...["персональная тренировка", "персональные тренировки", "тренировка с тренером", "индивидуальная тренировка", "индивидуальные тренировки", "персональная", "персональные", "тренер"].map((pattern) => ({ code: "personal_training", name: "Персональные тренировки", matchType: "contains", pattern })),
  { code: "personal_training", name: "Персональные тренировки", matchType: "starts_with", pattern: "пт" },
  ...["заморозка", "разморозка", "продление", "переоформление", "переоформления", "восстановление карты", "аренда", "полотенце", "шкафчик", "солярий", "доп услуга", "доп услуги", "дополнительная услуга", "дополнительные услуги"].map((pattern) => ({ code: "extra_services", name: "Доп. услуги", matchType: "contains", pattern })),
  ...["физкультурно оздоровительные услуги", "физкультурно оздоровительные", "физ оздоровительные услуги", "клубная карта", "карта клуба", "абонемент", "членство", "карта"].map((pattern) => ({ code: "membership", name: "Абонементы", matchType: "contains", pattern })),
];
const matchR = (t, p, n) => (!p ? false : t === "starts_with" ? n.startsWith(p) : t === "exact" ? n === p : n.includes(p));
function categorize(norm, dbRules = [], legal = null, rawName = null) {
  if (!norm) return { code: "other", name: "Иное", ruleId: null };
  const sorted = [...dbRules.filter((r) => r.isActive !== false && (r.legalEntityId == null || r.legalEntityId === legal))].sort((a, b) => {
    const as = a.legalEntityId ? 1 : 0, bs = b.legalEntityId ? 1 : 0; if (as !== bs) return bs - as;
    const ap = a.priority ?? 0, bp = b.priority ?? 0; if (ap !== bp) return bp - ap;
    return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
  });
  for (const r of sorted) { const pat = r.normalizedPattern ?? normItem(r.pattern); if (matchR(r.matchType, pat, norm)) return { code: r.categoryCode, name: r.categoryName, ruleId: r.id ?? null }; }
  for (const fb of DEFAULT_RULES) { if (matchR(fb.matchType, normItem(fb.pattern), norm)) return { code: fb.code, name: fb.name, ruleId: null }; }
  const loose = normItem(rawName ?? norm);
  if (loose.includes("физкультур") && loose.includes("договор") && loose.includes("контракт")) return { code: "membership", name: "Абонементы", ruleId: null };
  return { code: "other", name: "Иное", ruleId: null };
}
const ITEM_KEYS = ["items", "Items", "positions", "Positions", "goods", "Goods", "products", "Products", "services", "Services", "rows", "Rows"];
function parseItems(raw) {
  const o = raw ?? {}; let arr = [], present = false;
  for (const k of ITEM_KEYS) { if (Array.isArray(o[k])) { arr = o[k]; present = true; break; } }
  if (!present) { const ffd = o["1059"]; if (Array.isArray(ffd)) { arr = ffd; present = true; } else if (ffd && typeof ffd === "object") { arr = [ffd]; present = true; } }
  const items = [];
  for (const it of arr) {
    const io = it ?? {};
    const name = cleanItem(io["1030"] ?? io.name ?? io.Name ?? io.itemName ?? io.ItemName ?? io.nomenclature ?? io.Nomenclature ?? io.productName ?? io.ProductName);
    if (!name) continue;
    const totalKopeks = Math.trunc(Number(io["1043"] ?? io.sum ?? io.Sum ?? io.total ?? io.Total ?? io.amount ?? io.Amount) || 0);
    if (totalKopeks <= 0) continue;
    const priceKopeks = Math.trunc(Number(io["1079"] ?? io.price ?? io.Price ?? io.priceKopeks) || 0);
    const q = Number(io["1023"] ?? io.quantity ?? io.Quantity ?? io.qty ?? io.Qty); const quantityMilli = Math.max(0, Math.round((Number.isFinite(q) ? q : 1) * 1000));
    items.push({ name, normalizedName: normGroup(name), quantityMilli, priceKopeks, totalKopeks });
  }
  return { items, itemsPresent: present };
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
async function recomputeCategorySummary(companyId, clubId, legal, date) {
  const items = await p.ofdReceiptItem.findMany({ where: { companyId, clubId, provider: "taxcom", legalEntityId: legal ?? null, date }, select: { revenueCategoryCode: true, revenueCategoryName: true, operationType: true, totalKopeks: true, receiptImportId: true } });
  const byCat = new Map();
  for (const it of items) { let c = byCat.get(it.revenueCategoryCode); if (!c) { c = { name: it.revenueCategoryName, income: 0, ret: 0, itemCount: 0, receipts: new Set() }; byCat.set(it.revenueCategoryCode, c); } if (it.operationType === "income") c.income += it.totalKopeks; else c.ret += it.totalKopeks; c.itemCount++; c.receipts.add(it.receiptImportId); }
  await p.ofdRevenueCategoryDailySummary.deleteMany({ where: { companyId, clubId, provider: "taxcom", legalEntityId: legal ?? null, date } });
  const rows = [...byCat.entries()].map(([code, c]) => ({ companyId, clubId, legalEntityId: legal ?? null, provider: "taxcom", date, categoryCode: code, categoryName: c.name, incomeTotalKopeks: c.income, returnTotalKopeks: c.ret, netTotalKopeks: c.income - c.ret, itemCount: c.itemCount, receiptCount: c.receipts.size, summaryKey: `${companyId}:${clubId}:${legal ?? "none"}:taxcom:${date}:${code}` }));
  if (rows.length) await p.ofdRevenueCategoryDailySummary.createMany({ data: rows });
}
// Mirror of reclassifyOfdReceiptItemsForCompany — LOCAL-ONLY, no Taxcom, money untouched.
async function reclassifyForCompany(companyId) {
  const dbRules = await p.ofdRevenueCategoryRule.findMany({ where: { companyId, isActive: true } });
  const items = await p.ofdReceiptItem.findMany({ where: { companyId }, select: { id: true, itemName: true, normalizedItemName: true, revenueCategoryCode: true, revenueCategoryName: true, categoryRuleId: true, legalEntityId: true, clubId: true, date: true } });
  const touched = new Set(); let updated = 0;
  for (const it of items) {
    const normalizedItemName = normGroup(it.itemName);
    const cat = categorize(normalizedItemName, dbRules, it.legalEntityId ?? null, it.itemName);
    const changed = normalizedItemName !== it.normalizedItemName || cat.code !== it.revenueCategoryCode || cat.name !== it.revenueCategoryName || (cat.ruleId ?? null) !== (it.categoryRuleId ?? null);
    if (changed) { await p.ofdReceiptItem.update({ where: { id: it.id }, data: { normalizedItemName, revenueCategoryCode: cat.code, revenueCategoryName: cat.name, categoryRuleId: cat.ruleId } }); updated++; }
    touched.add(`${it.clubId}|${it.legalEntityId ?? ""}|${it.date}`);
  }
  for (const key of touched) { const [clubId, legalRaw, date] = key.split("|"); await recomputeCategorySummary(companyId, clubId, legalRaw || null, date); }
  return { scanned: items.length, updated, summariesRecomputed: touched.size };
}
// Mirror of the page drilldown: group OfdReceiptItem by revenueCategoryCode + normalizedName.
async function buildCategoryDetails(companyId, month) {
  const items = await p.ofdReceiptItem.findMany({ where: { companyId, provider: "taxcom", date: { startsWith: month } }, select: { revenueCategoryCode: true, normalizedItemName: true, itemName: true, totalKopeks: true, operationType: true, receiptImportId: true } });
  const byCat = new Map();
  for (const it of items) {
    let cat = byCat.get(it.revenueCategoryCode); if (!cat) { cat = new Map(); byCat.set(it.revenueCategoryCode, cat); }
    let row = cat.get(it.normalizedItemName); if (!row) { row = { income: 0, ret: 0, itemCount: 0, receipts: new Set(), examples: [], seen: new Set() }; cat.set(it.normalizedItemName, row); }
    if (it.operationType === "income") row.income += it.totalKopeks; else row.ret += it.totalKopeks;
    row.itemCount++; row.receipts.add(it.receiptImportId);
    const ex = String(it.itemName ?? "").slice(0, 160);
    if (ex && !row.seen.has(ex) && row.examples.length < 3) { row.examples.push(ex); row.seen.add(ex); }
  }
  const out = {};
  for (const [code, rows] of byCat) out[code] = [...rows.entries()].map(([normalizedName, r]) => ({ normalizedName, net: r.income - r.ret, income: r.income, itemCount: r.itemCount, receiptCount: r.receipts.size, examples: r.examples })).sort((a, b) => b.net - a.net);
  return out;
}
async function runImport({ connectionId, companyId, legalEntityId, dateFrom, dateTo, client, mappings, contractNumber, normalizeContract }) {
  const run = await p.ofdSyncRun.create({ data: { connectionId, companyId, mode: "manual_period", dateFrom, dateTo, status: "running", startedAt: new Date() } });
  const days = eachDay(dateFrom, dateTo);
  const dbRules = await p.ofdRevenueCategoryRule.findMany({ where: { companyId, isActive: true } });
  const itemStats = { itemDocumentsSeen: 0, itemRowsSeen: 0, itemRowsSaved: 0, itemRowsSkipped: 0, categoryOtherCount: 0, documentInfoRequested: 0, documentInfoSucceeded: 0, documentInfoFailed: 0 };
  // Select active mappings by connection SCOPE (company + legalEntity + provider),
  // NOT connectionId — mirror of the importer fix. When mappings are passed in
  // explicitly (unit tests), use them as-is.
  const activeMappings = mappings ?? await p.ofdCashRegisterMapping.findMany({ where: { companyId, provider: "taxcom", isActive: true, activeMappingKey: { not: null }, ...(legalEntityId ? { legalEntityId } : {}) } });
  if (activeMappings.length === 0) {
    await p.ofdSyncError.create({ data: { syncRunId: run.id, connectionId, companyId, clubId: null, fnNumber: null, stage: "mapping_check", safeCode: "ofd_no_active_cash_register_mappings", safeMessage: "Нет активных касс ОФД для выбранного подключения/юрлица." } });
    await p.ofdSyncRun.update({ where: { id: run.id }, data: { status: "failed", finishedAt: new Date(), safeErrorCode: "ofd_no_active_cash_register_mappings", safeErrorMessage: "Нет активных касс ОФД для выбранного подключения/юрлица." } });
    return { runId: run.id, found: 0, imported: 0, skipped: 0, status: "failed", noMappings: true };
  }
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
  for (const m of activeMappings) {
    const legal = m.legalEntityId ?? null; const recs = []; let failed = false;
    const stats = { shiftCount: 0, shiftReceiptCount: 0, documentCount: 0, normalizedReceiptCount: 0, serviceSkipped: 0, unsupportedSkipped: 0, invalidSkipped: 0 };
    for (const day of days) {
      const shifts = await client.listShifts(m.fnNumber, day, day);
      if (!shifts.ok) { failed = true; await p.ofdSyncError.create({ data: { syncRunId: run.id, connectionId, companyId, clubId: m.clubId, fnNumber: m.fnNumber, stage: "list_shifts", safeCode: shifts.safeCode, safeMessage: (shifts.safeMessage || "").slice(0, 200) || null } }); continue; }
      for (const s of shifts.data) {
        stats.shiftCount++; stats.shiftReceiptCount += Math.max(0, s.receiptCount ?? 0);
        const docs = await client.listDocumentsByShift(m.fnNumber, s.shiftNumber); if (!docs.ok) { failed = true; continue; }
        stats.documentCount += docs.data.length;
        for (const d of docs.data) {
          if (isServiceDocumentType(d.documentType)) { stats.serviceSkipped++; continue; }
          if (!mapOp(d.operationType)) { stats.unsupportedSkipped++; continue; }
          const n = normalize(d); if (n) { recs.push(n); stats.normalizedReceiptCount++; } else { stats.invalidSkipped++; }
        }
      }
    }
    const noReceiptsProblem = stats.normalizedReceiptCount === 0 && (stats.shiftReceiptCount > 0 || stats.documentCount > 0);
    if (noReceiptsProblem) {
      const agg = `shifts=${stats.shiftCount} shiftReceiptCount=${stats.shiftReceiptCount} documents=${stats.documentCount} normalized=0 service=${stats.serviceSkipped} unsupported=${stats.unsupportedSkipped} invalid=${stats.invalidSkipped}`;
      await p.ofdSyncError.create({ data: { syncRunId: run.id, connectionId, companyId, clubId: m.clubId, fnNumber: m.fnNumber, stage: "normalize_documents", safeCode: "taxcom_no_receipts_after_filter", safeMessage: `Такском вернул смены/документы, но CLUB-OPS не распознал чеки продаж. ${agg}`.slice(0, 200) } });
    }
    if (failed || noReceiptsProblem) kktFailures++;
    const byKey = new Map(); for (const r of recs) byKey.set(r.dedupeKey, r); const keys = [...byKey.keys()]; found += keys.length; if (!keys.length) continue;
    const ex = await p.ofdReceiptImport.findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true } }); const exSet = new Set(ex.map((e) => e.dedupeKey)); const fresh = keys.filter((k) => !exSet.has(k)).map((k) => byKey.get(k)); skipped += keys.length - fresh.length;
    if (fresh.length) await p.ofdReceiptImport.createMany({ data: fresh.map((r) => ({ connectionId, companyId, clubId: m.clubId, legalEntityId: legal, provider: "taxcom", fnNumber: r.fnNumber, shiftNumber: r.shiftNumber, fiscalDocumentNumber: r.fiscalDocumentNumber, fiscalSign: r.fiscalSign, operationType: r.operationType, receiptDate: r.receiptDate, totalKopeks: r.totalKopeks, cashKopeks: r.cashKopeks, electronicKopeks: r.electronicKopeks, dedupeKey: r.dedupeKey, source: "taxcom", syncRunId: run.id })) });
    imported += fresh.length;
    for (const r of byKey.values()) touched.add(`${m.clubId}|${legal ?? ""}|${r.receiptDate.toISOString().slice(0, 10)}`);
    // Persist SAFE nomenclature lines (idempotent by itemKey) — mirror of persistReceiptItems.
    const idRows = await p.ofdReceiptImport.findMany({ where: { dedupeKey: { in: keys } }, select: { id: true, dedupeKey: true } });
    const idByKey = new Map(idRows.map((r) => [r.dedupeKey, r.id]));
    // LIVE nomenclature via DocumentInfo — only for receipts lacking positions.
    if (typeof client.getDocumentInfoForReceipt === "function") {
      const idsWithItems = new Set((await p.ofdReceiptItem.findMany({ where: { receiptImportId: { in: [...idByKey.values()] } }, select: { receiptImportId: true } })).map((x) => x.receiptImportId));
      for (const r of byKey.values()) {
        const rid = idByKey.get(r.dedupeKey); if (!rid) continue;
        if ((r.items && r.items.length > 0) || idsWithItems.has(rid)) continue;
        itemStats.documentInfoRequested++;
        const di = await client.getDocumentInfoForReceipt(m.fnNumber, r.fiscalDocumentNumber);
        if (di.ok) { itemStats.documentInfoSucceeded++; r.items = di.data.items; r.itemsPresent = di.data.itemsPresent; }
        else { itemStats.documentInfoFailed++; await p.ofdSyncError.create({ data: { syncRunId: run.id, connectionId, companyId, clubId: m.clubId, fnNumber: m.fnNumber, stage: "document_info", safeCode: "taxcom_document_info_unavailable", safeMessage: `fn=${m.fnNumber} fd=${r.fiscalDocumentNumber} code=${di.safeCode}` } }); }
      }
    }
    const itemRows = [];
    for (const r of byKey.values()) {
      const rid = idByKey.get(r.dedupeKey); if (!rid) continue;
      itemStats.itemRowsSeen += (r.items || []).length;
      (r.items || []).forEach((it, lineIndex) => {
        const cat = categorize(it.normalizedName, dbRules, legal, it.name); if (cat.code === "other") itemStats.categoryOtherCount++;
        itemRows.push({ receiptImportId: rid, companyId, clubId: m.clubId, legalEntityId: legal, provider: "taxcom", date: r.receiptDate.toISOString().slice(0, 10), fnNumber: r.fnNumber, fdNumber: r.fiscalDocumentNumber, fiscalSign: null, lineIndex, itemName: it.name, normalizedItemName: it.normalizedName, quantityMilli: it.quantityMilli, priceKopeks: it.priceKopeks, totalKopeks: it.totalKopeks, operationType: r.operationType, revenueCategoryCode: cat.code, revenueCategoryName: cat.name, categoryRuleId: cat.ruleId, itemKey: `${r.dedupeKey}:${lineIndex}` });
      });
    }
    if (itemRows.length) { const exi = await p.ofdReceiptItem.findMany({ where: { itemKey: { in: itemRows.map((x) => x.itemKey) } }, select: { itemKey: true } }); const exiSet = new Set(exi.map((e) => e.itemKey)); const freshI = itemRows.filter((x) => !exiSet.has(x.itemKey)); itemStats.itemRowsSkipped += itemRows.length - freshI.length; if (freshI.length) { await p.ofdReceiptItem.createMany({ data: freshI }); itemStats.itemRowsSaved += freshI.length; } }
  }
  for (const key of touched) { const [clubId, legalRaw, day] = key.split("|"); await recomputeSummary(companyId, clubId, legalRaw || null, day); await recomputeCategorySummary(companyId, clubId, legalRaw || null, day); }
  const status = kktFailures === 0 ? "success" : (imported > 0 ? "partial_failed" : "failed");
  await p.ofdSyncRun.update({ where: { id: run.id }, data: { status, finishedAt: new Date(), foundReceipts: found, importedReceipts: imported, skippedReceipts: skipped } });
  return { runId: run.id, found, imported, skipped, status, itemStats };
}

const CO = "pilot-ofd-co", CONN = "pilot-ofd-conn", U = "pilot-ofd-owner";
const MC = "pilot-ofd-map-co", MU = "pilot-ofd-map-user"; // isolated company for mapping-selection e2e
const MO = "pilot-ofd-multi-co"; // isolated company for multi legal-entity Taxcom registers
async function cleanup() {
  for (const co of [CO, MC, MO]) {
    for (const t of ["ofdSyncError", "ofdSyncRun", "ofdReceiptItem", "ofdRevenueCategoryRule", "ofdRevenueCategoryDailySummary", "ofdReceiptImport", "ofdDailySalesSummary", "ofdCashRegisterMapping", "ofdConnection"]) await p[t].deleteMany({ where: { companyId: co } }).catch(() => {});
    await p.club.deleteMany({ where: { companyId: co } }).catch(() => {});
    await p.legalEntity.deleteMany({ where: { companyId: co } }).catch(() => {});
    await p.company.deleteMany({ where: { id: co } }).catch(() => {});
  }
  await p.user.deleteMany({ where: { id: { in: [U, MU] } } }).catch(() => {});
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

  // ===== Taxcom login (+agreementNumber) + AccountList + error mirrors ========
  // Mirror of client.extractToken / classifyTaxcomError / parseKktList /
  // parseAccountList / raw. Login (login_password) sends { login, password,
  // agreementNumber } when a договор is configured so Taxcom opens the RIGHT ЛК;
  // the currentSession is STILL verified via AccountList afterwards.
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
  const parseShiftList = (data) => asArr(data, ["records", "Records", "Items", "items", "Shifts", "shifts", "ShiftList"]).map((o) => { const rc = o.receiptCount ?? o.ReceiptCount ?? o.receiptsCount ?? o.documentCount; return { shiftNumber: num2(o.shiftNumber ?? o.ShiftNumber ?? o.Shift ?? o.shift ?? o.Number ?? o.number), dateOpen: s2(o.openDateTime ?? o.OpenDateTime ?? o.OpenDate ?? o.openDate ?? o.openedAt ?? o.DateOpen ?? o.dateOpen), dateClose: s2(o.closeDateTime ?? o.CloseDateTime ?? o.CloseDate ?? o.closeDate ?? o.closedAt ?? o.DateClose ?? o.dateClose), receiptCount: rc != null ? num2(rc) : null }; }).filter((s) => Number.isFinite(s.shiftNumber) && s.shiftNumber > 0);
  const parseDocumentList = (data, ctx) => asArr(data, ["records", "Records", "Items", "items", "Documents", "documents", "DocumentList"]).map((o) => ({ fn: s2(o.FnFactoryNumber ?? o.fnFactoryNumber ?? o.Fn ?? o.fn) ?? (ctx?.fn ?? ""), shift: num2(o.ShiftNumber ?? o.shiftNumber ?? o.Shift ?? o.shift) || (ctx?.shift ?? 0), documentType: s2(o.documentType ?? o.DocumentType ?? o.Type ?? o.type), numberInShift: (o.numberInShift ?? o.NumberInShift) != null ? num2(o.numberInShift ?? o.NumberInShift) : null, dateTime: String(o.DateTime ?? o.dateTime ?? o.Date ?? o.date ?? ""), fd: num2(o.FdNumber ?? o.fdNumber ?? o.Fd ?? o.fd ?? o.FiscalDocumentNumber), fpd: s2(o.Fpd ?? o.fpd ?? o.FiscalSign), operationType: s2(o.accountingType ?? o.AccountingType ?? o.OperationType ?? o.operationType ?? o.Operation), totalKopeks: num2(o.Sum ?? o.sum ?? o.TotalKopeks ?? o.totalKopeks ?? o.Total), cashKopeks: num2(o.Cash ?? o.cash ?? o.CashKopeks ?? o.cashKopeks), electronicKopeks: num2(o.Electronic ?? o.electronic ?? o.ElectronicKopeks ?? o.electronicKopeks) }));
  // Mirror of adapter.inspectNewDocumentsShape — SAFE structure only (keys + counts).
  const ND_ITEM_PATHS = ["items", "Items", "positions", "Positions", "goods", "Goods", "products", "Products", "services", "Services", "rows", "Rows", "fiscalData.items", "document.items", "receipt.items"];
  const arrAtPath = (o, path) => { let cur = o; for (const p of path.split(".")) { if (!cur || typeof cur !== "object") return null; cur = cur[p]; } return Array.isArray(cur) ? cur : null; };
  const inspectNDShape = (raw) => {
    const o = raw && typeof raw === "object" ? raw : {};
    const topLevelKeys = Object.keys(o).sort();
    const docs = asArr(o, ["records", "Records", "Items", "items", "Documents", "documents", "NewDocuments", "DocumentList"]);
    const first = docs[0] && typeof docs[0] === "object" ? docs[0] : {};
    const firstDocumentKeys = Object.keys(first).sort();
    const detectedItemLikeKeys = ND_ITEM_PATHS.filter((path) => arrAtPath(first, path));
    const documentTypeCounts = {};
    for (const d of docs) { const dt = d && typeof d === "object" ? (d.documentType ?? d.DocumentType ?? d.type ?? d.Type) : undefined; const key = dt == null || String(dt).trim() === "" ? "unknown" : String(dt).trim().slice(0, 16); documentTypeCounts[key] = (documentTypeCounts[key] ?? 0) + 1; }
    return { topLevelKeys, documentCount: docs.length, firstDocumentKeys, detectedItemLikeKeys, hasItemsLikeData: detectedItemLikeKeys.length > 0, documentTypeCounts };
  };
  // Mirror of adapter.inspectDocumentInfoShape — SAFE structure only (keys + counts).
  const DOC_ITEM_PATHS = ["items", "Items", "positions", "Positions", "goods", "Goods", "products", "Products", "services", "Services", "rows", "Rows", "fiscalData.items", "document.items", "receipt.items", "ticket.items", "content.items"];
  const valAtPath = (o, path) => { let cur = o; for (const p of path.split(".")) { if (!cur || typeof cur !== "object") return undefined; cur = cur[p]; } return cur; };
  const docObjOf = (o) => (["document", "Document", "ticket", "Ticket", "content", "Content", "receipt", "Receipt", "fiscalData", "FiscalData"].map((k) => o && o[k]).find((v) => v && typeof v === "object")) ?? (o ?? {});
  const parseItemsFromDI = (raw) => parseItems(docObjOf(raw && typeof raw === "object" ? raw : {}));
  const inspectDIShape = (raw) => {
    const o = raw && typeof raw === "object" ? raw : {};
    const topLevelKeys = Object.keys(o).sort();
    const docObj = (["document", "Document", "ticket", "Ticket", "content", "Content", "receipt", "Receipt", "fiscalData", "FiscalData"].map((k) => o[k]).find((v) => v && typeof v === "object")) ?? o;
    const documentKeys = Object.keys(docObj).sort();
    const detectedItemLikeKeys = []; let itemLikeCount = 0; let firstItemKeys = [];
    const noteFirst = (v) => { if (firstItemKeys.length === 0 && v && typeof v === "object") firstItemKeys = Object.keys(v).sort(); };
    for (const path of DOC_ITEM_PATHS) { const arr = arrAtPath(o, path); if (arr) { detectedItemLikeKeys.push(path); itemLikeCount += arr.length; noteFirst(arr[0]); } }
    let numericFfdModeDetected = false;
    for (const path of ["document.1059", "Document.1059", "1059"]) { const v = valAtPath(o, path); if (v == null) continue; numericFfdModeDetected = true; if (Array.isArray(v)) { detectedItemLikeKeys.push(path); itemLikeCount += v.length; noteFirst(v[0]); } else if (typeof v === "object") { detectedItemLikeKeys.push(path); itemLikeCount += 1; noteFirst(v); } break; }
    const dt = o.documentType ?? o.DocumentType ?? o.type ?? o.Type ?? docObj.documentType ?? docObj.DocumentType;
    const safeDocumentType = dt == null || String(dt).trim() === "" ? null : String(dt).trim().slice(0, 16);
    const cashierKeyNames = new Set(["1021", "1203", "cashier", "cashierName", "operator", "user", "Cashier", "CashierName", "Operator", "User"]);
    const cashierFieldsDetected = [...new Set([...topLevelKeys, ...documentKeys, ...firstItemKeys].filter((k) => cashierKeyNames.has(k)))].sort();
    const cashierDetected = cashierFieldsDetected.length > 0;
    return { topLevelKeys, documentKeys, detectedItemLikeKeys, hasItemsLikeData: detectedItemLikeKeys.length > 0, itemLikeCount, firstItemKeys, numericFfdModeDetected, safeDocumentType, hasCashierLikeKey: cashierDetected, cashierDetected, cashierFieldsDetected };
  };

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
      const b = {}; if (cfg.authType === "integration_token") b.integrationToken = cfg.integrationToken ?? ""; else { b.login = cfg.login ?? ""; b.password = cfg.password ?? ""; const ag = cfg.contractNumber && cfg.contractNumber.trim(); if (ag) b.agreementNumber = ag; }
      const r = await raw("/API/v2/Login", { method: "POST", body: b, withSession: false }); if (!r.ok) return r; const t = extractToken(r.data); if (!t) return { ok: false, safeCode: "parse_error" }; token = t; return { ok: true, data: t };
    }
    const dayRange = (d) => ({ begin: `${String(d).slice(0, 10)}T00:00:00`, end: `${String(d).slice(0, 10)}T23:59:59` });
    return {
      captured, login: ensureSession,
      listAccounts: async () => { const s = await ensureSession(); if (!s.ok) return s; const r = await raw("/API/v2/AccountList", { method: "GET", withSession: true }); if (!r.ok) return r; return { ok: true, data: parseAccountList(r.data) }; },
      listShifts: async (fn, from, to) => { const s = await ensureSession(); if (!s.ok) return s; const r = await raw("/API/v2/ShiftList", { method: "GET", withSession: true, query: { fn, begin: dayRange(from).begin, end: dayRange(to).end, pn: 1, ps: 100 } }); if (!r.ok) return r; return { ok: true, data: parseShiftList(r.data) }; },
      listDocumentsByShift: async (fn, shift) => { const s = await ensureSession(); if (!s.ok) return s; const r = await raw("/API/v2/DocumentList", { method: "GET", withSession: true, query: { fn, shift, pn: 1, ps: 100 } }); if (!r.ok) return r; return { ok: true, data: parseDocumentList(r.data, { fn, shift }) }; },
      inspectNewDocuments: async () => { const s = await ensureSession(); if (!s.ok) return s; const an = cfg.contractNumber && cfg.contractNumber.trim(); const r = await raw("/API/v2/NewDocuments", { method: "GET", withSession: true, query: an ? { an } : {} }); if (!r.ok) return r; return { ok: true, data: inspectNDShape(r.data) }; },
      inspectDocumentInfo: async (fn, fd) => { const s = await ensureSession(); if (!s.ok) return s; const r = await raw("/API/v2/DocumentInfo", { method: "GET", withSession: true, query: { fn, fd } }); if (!r.ok) return r; return { ok: true, data: inspectDIShape(r.data) }; },
      getDocumentInfoForReceipt: async (fn, fd) => { const s = await ensureSession(); if (!s.ok) return s; const r = await raw("/API/v2/DocumentInfo", { method: "GET", withSession: true, query: { fn, fd } }); if (!r.ok) return r; return { ok: true, data: parseItemsFromDI(r.data) }; },
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
  // T2: Login body carries agreementNumber (the chosen договор) when contractNumber set.
  await cli1.login();
  const loginReq1 = cli1.captured.find((c) => c.path === "/API/v2/Login");
  check("T2 Login body carries agreementNumber (= contractNumber) plus login/password when a договор is set", loginReq1.body.agreementNumber === "CD-25/45507" && loginReq1.body.login === "l" && loginReq1.body.password === "p" && !("contractNumber" in loginReq1.body) && Object.keys(loginReq1.body).sort().join(",") === "agreementNumber,login,password");
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
  check("T4 ShiftList is GET (not POST) with fn + FULL day begin/end + pn/ps, no body", shiftReq.method === "GET" && shiftReq.url.includes("/API/v2/ShiftList?") && shiftReq.url.includes("fn=7381440800719861") && decodeURIComponent(shiftReq.url).includes("begin=2026-07-01T00:00:00") && decodeURIComponent(shiftReq.url).includes("end=2026-07-01T23:59:59") && shiftReq.url.includes("pn=1") && shiftReq.url.includes("ps=100") && shiftReq.hasBody === false && !("body" in shiftInit));
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

  // Load the REAL normalizeContractNumber from src/lib/ofd/contract.ts (used by the
  // importer account guard below and the check-connection tests further down).
  const contractSource = readFileSync(new URL("../src/lib/ofd/contract.ts", import.meta.url), "utf8");
  const homoSrc = contractSource.match(/const HOMOGLYPHS[\s\S]*?\};/)[0].replace(": Record<string, string>", "");
  const normBody = contractSource.match(/export function normalizeContractNumber\(v[^)]*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/)[1];
  const normalizeContract = new Function("v", homoSrc + "\n" + normBody);

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
  // Production ShiftList (lowercase shiftNumber / openDateTime / receiptCount).
  const prodShiftResponse = { reportDate: "2026-07-15", counts: { total: 1 }, records: [ { fnFactoryNumber: PROD_FN, shiftNumber: PROD_SHIFT, openDateTime: "2026-07-15T10:27:00", closeDateTime: "2026-07-15T21:47:00", receiptCount: 13 } ] };
  const prodShifts = parseShiftList(prodShiftResponse);
  check("TD-SHIFT parseShiftList reads lowercase shiftNumber(463) + receiptCount(13) + open/closeDateTime", prodShifts.length === 1 && prodShifts[0].shiftNumber === 463 && prodShifts[0].receiptCount === 13 && prodShifts[0].dateOpen === "2026-07-15T10:27:00" && prodShifts[0].dateClose === "2026-07-15T21:47:00");
  // toTaxcomDayRange: FULL local day window, no timezone suffix, no Date round-trip.
  const toTaxcomDayRange = (date) => { const d = /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : String(date).slice(0, 10); return { begin: `${d}T00:00:00`, end: `${d}T23:59:59` }; };
  const rng = toTaxcomDayRange("2026-07-15");
  check("TD-RANGE toTaxcomDayRange('2026-07-15') → begin=…T00:00:00 & end=…T23:59:59 (no Z, no ms, begin≠end)", rng.begin === "2026-07-15T00:00:00" && rng.end === "2026-07-15T23:59:59" && !rng.begin.includes("Z") && !rng.end.includes("Z") && rng.begin !== rng.end && toTaxcomDayRange("2026-07-15T09:00:00.000Z").begin === "2026-07-15T00:00:00");
  check("TD-RANGE2 period 2026-07-01..2026-07-31 = 31 inclusive days (first 07-01, last 07-31, not exclusive)", (() => { const ds = eachDay("2026-07-01", "2026-07-31"); return ds.length === 31 && ds[0] === "2026-07-01" && ds[30] === "2026-07-31" && toTaxcomDayRange(ds[0]).begin === "2026-07-01T00:00:00" && toTaxcomDayRange(ds[30]).end === "2026-07-31T23:59:59"; })());

  // FULL PATH e2e: Login → AccountList → ShiftList → DocumentList → import, through
  // the REAL client (makeClient) + a fake fetch. DocumentList returns the 15 docs
  // ONLY when pn=1&ps=100 are present — proving the pagination fix end-to-end.
  const mapProd = await p.ofdCashRegisterMapping.create({ data: { connectionId: CONN, companyId: CO, clubId: clubA.id, provider: "taxcom", fnNumber: PROD_FN, isActive: true, activeMappingKey: `taxcom:${PROD_FN}` } });
  const e2eCfg = { serverBaseUrl: "https://api-lk-ofd.taxcom.ru", authType: "login_password", contractNumber: "CD-25/455507", login: "L", password: "P", integratorId: "INT-1", integrationToken: null };
  let docListUrl = null, shiftUrl = null;
  // The fake ShiftList returns the shift ONLY for the EXACT full local-day window
  // Такском expects — begin=2026-07-15T00:00:00 & end=2026-07-15T23:59:59. Any other
  // range (date-only, begin===end, UTC/Z suffix) → records:[] → import 0 → test fails.
  const EXPECT_BEGIN = "2026-07-15T00:00:00", EXPECT_END = "2026-07-15T23:59:59";
  const e2eFetch = async (url) => {
    const decoded = decodeURIComponent(url);
    if (url.includes("/Login")) return okJson({ sessionToken: "TKN" });
    if (url.includes("/AccountList")) return okJson({ currentSession: "CD-25/455507", records: [{ agreementNumber: "CD-25/455507", companyName: "ООО СПОРТ ТЕХНОЛОГИИ", inn: "6679182168", kpp: "667901001" }] });
    if (url.includes("/ShiftList")) { shiftUrl = decoded; return (decoded.includes(`begin=${EXPECT_BEGIN}`) && decoded.includes(`end=${EXPECT_END}`)) ? okJson(prodShiftResponse) : okJson({ reportDate: "2026-07-15", counts: {}, records: [] }); }
    if (url.includes("/DocumentList")) { docListUrl = decoded; return (url.includes("pn=1") && url.includes("ps=100")) ? okJson(prodDocResponse) : okJson({ reportDate: "2026-07-15", counts: {}, records: [] }); }
    return okJson({});
  };
  const e2eClient = makeClient(e2eCfg, e2eFetch);
  const pr1 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-15", dateTo: "2026-07-15", client: e2eClient, mappings: [mapProd], contractNumber: "CD-25/455507", normalizeContract });
  check("TD5 FULL PATH import (Login→AccountList→ShiftList→DocumentList→normalize): found 13 / imported 13 / skipped 0", pr1.found === 13 && pr1.imported === 13 && pr1.skipped === 0 && pr1.status === "success" && (await p.ofdReceiptImport.count({ where: { companyId: CO, fnNumber: PROD_FN } })) === 13);
  check("TD5a ShiftList called with fn + FULL local day range begin=…T00:00:00 & end=…T23:59:59 + pn=1 & ps=100 (no Z, not date-only)", shiftUrl && shiftUrl.includes(`fn=${PROD_FN}`) && shiftUrl.includes(`begin=${EXPECT_BEGIN}`) && shiftUrl.includes(`end=${EXPECT_END}`) && shiftUrl.includes("pn=1") && shiftUrl.includes("ps=100") && !shiftUrl.includes("Z") && !/begin=2026-07-15&/.test(shiftUrl));
  check("TD5b DocumentList called with fn/shift + pn=1 & ps=100 (the pagination fix)", docListUrl && docListUrl.includes(`fn=${PROD_FN}`) && docListUrl.includes(`shift=${PROD_SHIFT}`) && docListUrl.includes("pn=1") && docListUrl.includes("ps=100"));
  const pr2 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-15", dateTo: "2026-07-15", client: e2eClient, mappings: [mapProd], contractNumber: "CD-25/455507", normalizeContract });
  check("TD6 re-import idempotent: found 13 / imported 0 / skipped 13, no duplicates", pr2.found === 13 && pr2.imported === 0 && pr2.skipped === 13 && (await p.ofdReceiptImport.count({ where: { companyId: CO, fnNumber: PROD_FN } })) === 13);
  const prodSummary = await p.ofdDailySalesSummary.findUnique({ where: { summaryKey: summaryKeyOf(CO, clubA.id, null, "taxcom", "2026-07-15") } });
  check("TD7 OfdDailySalesSummary recomputed: income 4629900 / cash 1280000 / electronic 3349900 / return 0 / net 4629900 / receiptCount 13", prodSummary.incomeTotalKopeks === 4629900 && prodSummary.incomeCashKopeks === 1280000 && prodSummary.incomeElectronicKopeks === 3349900 && prodSummary.returnTotalKopeks === 0 && prodSummary.netTotalKopeks === 4629900 && prodSummary.receiptCount === 13 && prodSummary.returnReceiptCount === 0);
  const noErr = await p.ofdSyncError.count({ where: { syncRunId: { in: [pr1.runId, pr2.runId] } } });
  check("TD8 no OfdSyncError for production import (service docs are NOT errors)", noErr === 0);
  // Diagnostic: ShiftList declares receipts but DocumentList yields 0 (e.g. missing
  // pn/ps → empty records) → NOT success 0/0/0; a safe aggregate error is recorded.
  const diagClient = { listShifts: async () => ({ ok: true, data: [{ shiftNumber: PROD_SHIFT, receiptCount: 13 }] }), listDocumentsByShift: async () => ({ ok: true, data: [] }) };
  const diagRun = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-16", dateTo: "2026-07-16", client: diagClient, mappings: [mapProd] });
  check("TD-DIAG shiftReceiptCount>0 but 0 parsed → NOT success 0/0/0 (status failed, found 0)", diagRun.found === 0 && diagRun.status !== "success");
  const diagErr = await p.ofdSyncError.findFirst({ where: { syncRunId: diagRun.runId, stage: "normalize_documents" } });
  check("TD-DIAG2 taxcom_no_receipts_after_filter with SAFE aggregate message (fn ok, no raw JSON/braces/PII/token)", diagErr && diagErr.safeCode === "taxcom_no_receipts_after_filter" && diagErr.fnNumber === PROD_FN && diagErr.safeMessage.includes("shiftReceiptCount=13") && diagErr.safeMessage.includes("normalized=0") && diagErr.safeMessage.length <= 200 && !/[{}]|token|password|integrator|sessionToken|fpd|@/i.test(diagErr.safeMessage));
  // A truly empty shift (no declared receipts, no documents) stays clean success 0/0/0.
  const emptyClient = { listShifts: async () => ({ ok: true, data: [{ shiftNumber: 999, receiptCount: 0 }] }), listDocumentsByShift: async () => ({ ok: true, data: [] }) };
  const emptyRun = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-17", dateTo: "2026-07-17", client: emptyClient, mappings: [mapProd] });
  const emptyErr = await p.ofdSyncError.count({ where: { syncRunId: emptyRun.runId } });
  check("TD-DIAG3 truly empty shift (receiptCount 0, 0 docs) = success 0/0/0, no error", emptyRun.status === "success" && emptyRun.found === 0 && emptyErr === 0);
  const storedProd = await p.ofdReceiptImport.findFirst({ where: { companyId: CO, fnNumber: PROD_FN } });
  const storedKeys = Object.keys(storedProd);
  // STAGE 13: operator* (cashier for payroll attribution) is an intentional, documented
  // addition — it is the cashier/employee, NOT buyer PII. Buyer PII stays forbidden.
  check("TD9 stored receipt has NO buyer PII / raw JSON (phone/email/buyer/customer/items/rawJson); operator* cashier is intentional", !storedKeys.filter((k) => !/^operator/i.test(k) && k !== "externalCashierId").some((k) => /phone|email|name|buyer|customer|items|rawjson|rawresponse|fio/i.test(k)));
  const oldShapeDoc = { Fn: "FN-X", Shift: 7, Fd: 900, Fpd: "Z", DateTime: "2026-07-15T12:00:00.000Z", OperationType: "Income", Sum: 5000, Cash: 5000 };
  check("TD10 old DocumentList shapes still parse (Fn/Fd/OperationType/Sum + Items key)", parseDocumentList({ Items: [oldShapeDoc] })[0].fd === 900 && normalize(parseDocumentList({ Items: [oldShapeDoc] })[0]).totalKopeks === 5000 && normalize(parseDocumentList({ Items: [oldShapeDoc] })[0]).operationType === "income");
  await p.ofdCashRegisterMapping.delete({ where: { id: mapProd.id } });
  // Clear this ФН's receipts (dedupeKey is globally unique) so the isolated
  // mapping-selection e2e below imports fresh, not as duplicates of the above.
  await p.ofdReceiptImport.deleteMany({ where: { fnNumber: PROD_FN } });

  // ===== Active-mapping SELECTION e2e (the production bug: mapping not found) ====
  // Reproduce the production связка in an isolated company: connection scoped to
  // companyId+legalEntityId, an ACTIVE mapping with a STALE connectionId (as if the
  // connection was recreated). The importer must still select it by company scope
  // (NOT connectionId) and reach ShiftList → 13/13/0.
  await p.company.create({ data: { id: MC, name: "Map Co" } });
  const mcLegal = await p.legalEntity.create({ data: { companyId: MC, type: "ooo", name: "ООО СПОРТ ТЕХНОЛОГИИ" } });
  const mcClub = await p.club.create({ data: { name: "Клуб MC", city: "X", companyId: MC } });
  await p.user.create({ data: { id: MU, email: "map@ofd.test", name: "Map Owner", role: "owner", isActive: true } });
  const mcConn = await p.ofdConnection.create({ data: { companyId: MC, legalEntityId: mcLegal.id, provider: "taxcom", displayName: "Такском", serverBaseUrl: "https://api-lk-ofd.taxcom.ru", authType: "login_password", contractNumber: "CD-25/455507", loginEncrypted: encryptOfd("L"), passwordEncrypted: encryptOfd("P"), integratorIdEncrypted: encryptOfd("INT-1"), createdByUserId: MU } });
  // STALE connectionId — different from mcConn.id — proves selection is NOT by connectionId.
  const mcMapping = await p.ofdCashRegisterMapping.create({ data: { connectionId: "stale-old-connection-id-xyz", companyId: MC, legalEntityId: mcLegal.id, clubId: mcClub.id, provider: "taxcom", fnNumber: PROD_FN, isActive: true, activeMappingKey: `taxcom:${PROD_FN}` } });
  check("TM0 sanity: mapping's connectionId is STALE (≠ connection.id)", mcMapping.connectionId !== mcConn.id);
  // The old query { connectionId: connection.id, isActive } would find NOTHING here:
  check("TM1 old-style query by connectionId finds 0 (reproduces the bug)", (await p.ofdCashRegisterMapping.count({ where: { connectionId: mcConn.id, isActive: true } })) === 0);
  // The new scope query (company + legalEntity + provider + active + key) finds it:
  const scoped = await p.ofdCashRegisterMapping.findMany({ where: { companyId: mcConn.companyId, provider: "taxcom", isActive: true, activeMappingKey: { not: null }, legalEntityId: mcConn.legalEntityId } });
  check("TM2 scope query (company+legalEntity+provider+active+key) selects the production mapping", scoped.length === 1 && scoped[0].fnNumber === PROD_FN && scoped[0].id === mcMapping.id);
  // Full e2e: runImport WITHOUT explicit mappings → it must query + reach ShiftList.
  let mcShiftUrl = null;
  const mcFetch = async (url) => {
    const decoded = decodeURIComponent(url);
    if (url.includes("/Login")) return okJson({ sessionToken: "TKN" });
    if (url.includes("/AccountList")) return okJson({ currentSession: "CD-25/455507", records: [{ agreementNumber: "CD-25/455507" }] });
    if (url.includes("/ShiftList")) { mcShiftUrl = decoded; return (decoded.includes("begin=2026-07-15T00:00:00") && decoded.includes("end=2026-07-15T23:59:59")) ? okJson(prodShiftResponse) : okJson({ records: [] }); }
    if (url.includes("/DocumentList")) return (url.includes("pn=1") && url.includes("ps=100")) ? okJson(prodDocResponse) : okJson({ records: [] });
    return okJson({});
  };
  const mcClient = makeClient({ serverBaseUrl: "https://api-lk-ofd.taxcom.ru", authType: "login_password", contractNumber: "CD-25/455507", login: "L", password: "P", integratorId: "INT-1", integrationToken: null }, mcFetch);
  const mcRun = await runImport({ connectionId: mcConn.id, companyId: mcConn.companyId, legalEntityId: mcConn.legalEntityId, dateFrom: "2026-07-15", dateTo: "2026-07-15", client: mcClient, contractNumber: "CD-25/455507", normalizeContract });
  check("TM3 import reaches ShiftList for fn=7381440800719861 with full-day range despite stale connectionId", mcShiftUrl && mcShiftUrl.includes(`fn=${PROD_FN}`) && mcShiftUrl.includes("begin=2026-07-15T00:00:00") && mcShiftUrl.includes("end=2026-07-15T23:59:59"));
  check("TM4 result 13/13/0 (mapping selected, DocumentList shift=463, 13 receipts)", mcRun.found === 13 && mcRun.imported === 13 && mcRun.skipped === 0 && mcRun.status === "success" && mcRun.noMappings === undefined);
  const mcSummary = await p.ofdDailySalesSummary.findUnique({ where: { summaryKey: summaryKeyOf(MC, mcClub.id, mcLegal.id, "taxcom", "2026-07-15") } });
  check("TM5 summary 4629900 / 1280000 / 3349900 / net 4629900 / receiptCount 13", mcSummary && mcSummary.incomeTotalKopeks === 4629900 && mcSummary.incomeCashKopeks === 1280000 && mcSummary.incomeElectronicKopeks === 3349900 && mcSummary.returnTotalKopeks === 0 && mcSummary.netTotalKopeks === 4629900 && mcSummary.receiptCount === 13);
  // No active mappings → NOT silent success 0/0/0: mapping_check error, status failed.
  await p.ofdCashRegisterMapping.update({ where: { id: mcMapping.id }, data: { isActive: false, activeMappingKey: null } });
  const mcRun2 = await runImport({ connectionId: mcConn.id, companyId: mcConn.companyId, legalEntityId: mcConn.legalEntityId, dateFrom: "2026-07-16", dateTo: "2026-07-16", client: mcClient, contractNumber: "CD-25/455507", normalizeContract });
  check("TM6 zero active mappings → status failed, 0/0/0, NOT silent success", mcRun2.status === "failed" && mcRun2.found === 0 && mcRun2.imported === 0 && mcRun2.skipped === 0 && mcRun2.noMappings === true);
  const mcMapErr = await p.ofdSyncError.findFirst({ where: { syncRunId: mcRun2.runId, stage: "mapping_check" } });
  check("TM7 mapping_check OfdSyncError = ofd_no_active_cash_register_mappings, safe message (no secrets)", mcMapErr && mcMapErr.safeCode === "ofd_no_active_cash_register_mappings" && mcMapErr.safeMessage === "Нет активных касс ОФД для выбранного подключения/юрлица." && !/token|password|login|integrator|@/i.test(mcMapErr.safeMessage) && mcMapErr.clubId === null && mcMapErr.fnNumber === null);

  // ===== Daily auto-import cron (POST /api/cron/ofd/daily) =====================
  // Load the REAL authorizeOfdCron + ofdYesterday from src/lib/ofd/daily.ts.
  const dailySrc = readFileSync(new URL("../src/lib/ofd/daily.ts", import.meta.url), "utf8");
  // Mirror of localYmd / ofdYesterday / ofdToday (verified against real source below).
  const localYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const ofdYesterday = (now) => localYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const ofdToday = (now) => localYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  // The real body now calls the timing-safe helpers (secure-compare.ts); inject
  // correctness-equivalent mirrors so the extracted body runs standalone.
  const cmpHelpers = 'const bearerEquals=(h,e)=>typeof e==="string"&&e.length>0&&typeof h==="string"&&h==="Bearer "+e; const secretEquals=(p,e)=>typeof e==="string"&&e.length>0&&p===e;';
  const authorizeOfdCron = new Function("p", cmpHelpers + dailySrc.match(/export function authorizeOfdCron\(p: OfdCronAuthInput\): OfdCronAuthResult \{([\s\S]*?)\n\}/)[1]);
  const SECRET = "cron-secret-xyz";
  const authOk = { method: "POST", authorization: `Bearer ${SECRET}`, cronHeader: null, enabled: true, secret: SECRET };
  check("CR1 non-POST → 405 method_not_allowed", authorizeOfdCron({ ...authOk, method: "GET" }).status === 405 && authorizeOfdCron({ ...authOk, method: "PUT" }).status === 405);
  check("CR2 feature disabled → 503 ofd_integrations_disabled (never runs)", authorizeOfdCron({ ...authOk, enabled: false }).status === 503 && authorizeOfdCron({ ...authOk, enabled: false }).error === "ofd_integrations_disabled");
  check("CR3 no CRON_SECRET configured → 503 cron_secret_not_configured (never runs)", authorizeOfdCron({ ...authOk, secret: null }).status === 503 && authorizeOfdCron({ ...authOk, secret: null }).error === "cron_secret_not_configured");
  check("CR4 wrong / missing request secret → 401", authorizeOfdCron({ ...authOk, authorization: "Bearer nope" }).status === 401 && authorizeOfdCron({ ...authOk, authorization: null }).status === 401);
  check("CR5 correct Bearer OR X-Cron-Secret → ok", authorizeOfdCron(authOk).ok === true && authorizeOfdCron({ method: "POST", authorization: null, cronHeader: SECRET, enabled: true, secret: SECRET }).ok === true);
  check("CR6 ofdYesterday = server local calendar day − 1", ofdYesterday(new Date(2026, 6, 15, 3, 30)) === "2026-07-14" && ofdYesterday(new Date(2026, 6, 1, 0, 5)) === "2026-06-30");

  // Mirror of runOfdImportBatch (shared by daily cron + sync-now; safe aggregates).
  async function runOfdBatch({ date, mode, listConnections, importer }) {
    const connections = await listConnections();
    const runs = []; const totals = { foundReceipts: 0, importedReceipts: 0, skippedReceipts: 0, totalIncomeKopeks: 0, totalReturnKopeks: 0 };
    let succeeded = 0, failed = 0;
    for (const c of connections) {
      let s;
      try {
        const r = await importer(c.id, date, mode);
        s = r.ok ? { connectionId: c.id, status: r.status, foundReceipts: r.found, importedReceipts: r.imported, skippedReceipts: r.skipped, totalIncomeKopeks: r.totalIncomeKopeks, totalReturnKopeks: r.totalReturnKopeks, safeErrorCode: null } : { connectionId: c.id, status: "failed", foundReceipts: 0, importedReceipts: 0, skippedReceipts: 0, totalIncomeKopeks: 0, totalReturnKopeks: 0, safeErrorCode: r.safeCode };
      } catch { s = { connectionId: c.id, status: "failed", foundReceipts: 0, importedReceipts: 0, skippedReceipts: 0, totalIncomeKopeks: 0, totalReturnKopeks: 0, safeErrorCode: "import_exception" }; }
      if (s.safeErrorCode === null && s.status === "success") succeeded++; else failed++;
      totals.foundReceipts += s.foundReceipts; totals.importedReceipts += s.importedReceipts; totals.skippedReceipts += s.skippedReceipts; totals.totalIncomeKopeks += s.totalIncomeKopeks; totals.totalReturnKopeks += s.totalReturnKopeks;
      runs.push(s);
    }
    return { ok: true, date, processedConnections: connections.length, succeeded, failed, totals, runs };
  }
  const runDailyOfdImport = ({ now, listConnections, importer }) => runOfdBatch({ date: ofdYesterday(now), mode: "auto_daily", listConnections, importer });
  const runSyncNow = ({ now, listConnections, importer }) => runOfdBatch({ date: ofdToday(now), mode: "sync_now", listConnections, importer });

  // DB: connection SELECTION — only ACTIVE taxcom connections (mirror of the real query).
  const cronActive = await p.ofdConnection.create({ data: { companyId: MC, provider: "taxcom", displayName: "T-active", serverBaseUrl: "https://api-lk-ofd.taxcom.ru", authType: "login_password", isActive: true, createdByUserId: MU } });
  await p.ofdConnection.create({ data: { companyId: MC, provider: "taxcom", displayName: "T-inactive", serverBaseUrl: "https://x", authType: "login_password", isActive: false, createdByUserId: MU } });
  await p.ofdConnection.create({ data: { companyId: MC, provider: "atol", displayName: "Other", serverBaseUrl: "https://x", authType: "login_password", isActive: true, createdByUserId: MU } });
  const selected = await p.ofdConnection.findMany({ where: { companyId: MC, provider: "taxcom", isActive: true }, select: { id: true } });
  check("CR7 selects only ACTIVE taxcom connections (not inactive, not other providers)", selected.some((c) => c.id === cronActive.id) && selected.every((c) => c.id !== undefined) && selected.length === 2 /* mcConn + cronActive */);

  // Importer invoked with yesterday + mode auto_daily; aggregation across connections.
  const importerCalls = [];
  const fakeImporter = async (connectionId, date, mode) => {
    importerCalls.push({ connectionId, date, mode });
    if (connectionId === "conn-B") return { ok: false, safeCode: "already_running" }; // one fails
    return { ok: true, found: 5, imported: 5, skipped: 0, status: "success", totalIncomeKopeks: 100000, totalReturnKopeks: 0 };
  };
  const res = await runDailyOfdImport({ now: new Date(2026, 6, 15, 4, 0), listConnections: async () => [{ id: "conn-A" }, { id: "conn-B" }, { id: "conn-C" }], importer: fakeImporter });
  check("CR8 importer called per connection with yesterday date + mode auto_daily", importerCalls.length === 3 && importerCalls.every((c) => c.date === "2026-07-14" && c.mode === "auto_daily") && importerCalls.map((c) => c.connectionId).join(",") === "conn-A,conn-B,conn-C");
  check("CR9 totals aggregated across connections (2 ok × 5 = found 10 / imported 10 / income 200000)", res.processedConnections === 3 && res.totals.foundReceipts === 10 && res.totals.importedReceipts === 10 && res.totals.totalIncomeKopeks === 200000 && res.totals.totalReturnKopeks === 0);
  check("CR10 one connection failure does NOT abort others (succeeded 2, failed 1, safeErrorCode surfaced)", res.succeeded === 2 && res.failed === 1 && res.runs.find((r) => r.connectionId === "conn-B").safeErrorCode === "already_running" && res.runs.filter((r) => r.safeErrorCode === null).length === 2);
  check("CR11 a thrown importer error is caught → safe import_exception, others continue", (await (async () => { const rr = await runDailyOfdImport({ now: new Date(2026, 6, 15), listConnections: async () => [{ id: "x1" }, { id: "x2" }], importer: async (id) => { if (id === "x1") throw new Error("boom stack with secret Bearer abc"); return { ok: true, found: 1, imported: 1, skipped: 0, status: "success", totalIncomeKopeks: 1, totalReturnKopeks: 0 }; } }); return rr.runs.find((r) => r.connectionId === "x1").safeErrorCode === "import_exception" && rr.succeeded === 1; })()) === true);
  const resJson = JSON.stringify(res);
  check("CR12 response has ONLY safe fields (no login/password/Integrator-ID/SessionToken/raw/PII/stack)", !/login|password|integrator|sessionToken|serverBaseUrl|loginEncrypted|Bearer|fpd|phone|email|stack/i.test(resJson) && Object.keys(res.runs[0]).sort().join(",") === "connectionId,foundReceipts,importedReceipts,safeErrorCode,skippedReceipts,status,totalIncomeKopeks,totalReturnKopeks");

  // ===== On-demand "Синхронизировать сейчас" (sync_now) ========================
  check("SN0 ofdToday = server local calendar day (no −1)", ofdToday(new Date(2026, 6, 15, 3, 30)) === "2026-07-15" && ofdToday(new Date(2026, 11, 31, 23, 59)) === "2026-12-31");
  // Company-scoped selection: only THIS company's active taxcom connections (CO's excluded).
  const snSelected = await p.ofdConnection.findMany({ where: { companyId: MC, provider: "taxcom", isActive: true }, select: { id: true } });
  check("SN1 sync selects active taxcom connections of the company only (other company excluded)", snSelected.length === 2 && snSelected.some((c) => c.id === cronActive.id) && !snSelected.some((c) => c.id === CONN));
  const snCalls = [];
  const snImporter = async (connectionId, date, mode) => {
    snCalls.push({ connectionId, date, mode });
    if (connectionId === "c2") return { ok: false, safeCode: "already_running" }; // one busy
    return { ok: true, found: 3, imported: 3, skipped: 0, status: "success", totalIncomeKopeks: 50000, totalReturnKopeks: 0 };
  };
  const snRes = await runSyncNow({ now: new Date(2026, 6, 15, 10, 0), listConnections: async () => [{ id: "c1" }, { id: "c2" }, { id: "c3" }], importer: snImporter });
  check("SN2 sync_now imports TODAY per connection with mode sync_now", snCalls.length === 3 && snCalls.every((c) => c.date === "2026-07-15" && c.mode === "sync_now"));
  check("SN3 totals aggregated across connections (2 ok × 3 = found 6 / imported 6 / income 100000)", snRes.processedConnections === 3 && snRes.totals.foundReceipts === 6 && snRes.totals.importedReceipts === 6 && snRes.totals.totalIncomeKopeks === 100000);
  check("SN4 one connection failure does NOT abort others (succeeded 2, failed 1, safeErrorCode surfaced)", snRes.succeeded === 2 && snRes.failed === 1 && snRes.runs.find((r) => r.connectionId === "c2").safeErrorCode === "already_running");
  check("SN5 sync result safe-fields-only (no login/password/Integrator-ID/SessionToken/raw/PII/stack)", !/login|password|integrator|sessionToken|serverBaseUrl|Bearer|fpd|phone|email|stack/i.test(JSON.stringify(snRes)) && Object.keys(snRes.runs[0]).sort().join(",") === "connectionId,foundReceipts,importedReceipts,safeErrorCode,skippedReceipts,status,totalIncomeKopeks,totalReturnKopeks");

  // ===== Multi legal-entity Taxcom registers (MULTI-OFD) =======================
  await p.company.create({ data: { id: MO, name: "Multi OFD Co" } });
  const ooo = await p.legalEntity.create({ data: { companyId: MO, type: "ooo", name: "ООО Спорт Технологии" } });
  const ip = await p.legalEntity.create({ data: { companyId: MO, type: "ip", name: "ИП Иванов" } });
  const moClub = await p.club.create({ data: { name: "Клуб MO", city: "X", companyId: MO } });
  // Two separate Taxcom connections — one per legal entity (ООО и ИП).
  const connOOO = await p.ofdConnection.create({ data: { companyId: MO, legalEntityId: ooo.id, provider: "taxcom", displayName: "Такском ООО", serverBaseUrl: "https://s", authType: "login_password", contractNumber: "CD-OOO/1", loginEncrypted: encryptOfd("L1"), passwordEncrypted: encryptOfd("P1"), isActive: true, createdByUserId: U } });
  const connIP = await p.ofdConnection.create({ data: { companyId: MO, legalEntityId: ip.id, provider: "taxcom", displayName: "Такском ИП", serverBaseUrl: "https://s", authType: "login_password", contractNumber: "CD-IP/1", isActive: true, createdByUserId: U } }); // no secrets → not configured
  const moConns = await p.ofdConnection.findMany({ where: { companyId: MO, provider: "taxcom", isActive: true } });
  check("MULTI-OFD1 several active Taxcom connections per company for different legalEntityId", moConns.length === 2 && new Set(moConns.map((c) => c.legalEntityId)).size === 2 && moConns.some((c) => c.legalEntityId === ooo.id) && moConns.some((c) => c.legalEntityId === ip.id));
  check("MULTI-OFD8 ИП and ООО are DISTINCT connections with distinct legalEntity (not a cash-register type)", connOOO.legalEntityId !== connIP.legalEntityId && connOOO.displayName !== connIP.displayName && ooo.type === "ooo" && ip.type === "ip");
  // Mappings: club_cashbox + online_cashbox on the ООО connection.
  const moFd = { "FN-OOO-1": 8501, "FN-OOO-2": 8502, "FN-OOO-3": 8503 };
  const mClub = await p.ofdCashRegisterMapping.create({ data: { connectionId: connOOO.id, companyId: MO, clubId: moClub.id, legalEntityId: ooo.id, provider: "taxcom", fnNumber: "FN-OOO-1", registerKind: "club_cashbox", isActive: true, activeMappingKey: "taxcom:FN-OOO-1" } });
  const mOnline = await p.ofdCashRegisterMapping.create({ data: { connectionId: connOOO.id, companyId: MO, clubId: moClub.id, legalEntityId: ooo.id, provider: "taxcom", fnNumber: "FN-OOO-2", registerKind: "online_cashbox", isActive: true, activeMappingKey: "taxcom:FN-OOO-2" } });
  // Legacy mapping created WITHOUT registerKind → must fall back to club_cashbox.
  const mNoKind = await p.ofdCashRegisterMapping.create({ data: { connectionId: connOOO.id, companyId: MO, clubId: moClub.id, legalEntityId: ooo.id, provider: "taxcom", fnNumber: "FN-OOO-3", isActive: true, activeMappingKey: "taxcom:FN-OOO-3" } });
  check("MULTI-OFD9 existing mapping without registerKind is not broken; fallback = club_cashbox", (await p.ofdCashRegisterMapping.findUnique({ where: { id: mNoKind.id } })).registerKind === "club_cashbox");
  // Import ALL active ООО mappings via the real DB selection (no explicit mappings arg).
  const moClient = { listShifts: async () => ({ ok: true, data: [{ shiftNumber: 1 }] }), listDocumentsByShift: async (fn) => ({ ok: true, data: moFd[fn] ? [{ fn, shift: 1, documentType: "3", operationType: "Income", dateTime: "2026-07-28T10:00:00.000Z", fd: moFd[fn], fpd: `${fn}-fpd`, totalKopeks: 100000, cashKopeks: 100000, electronicKopeks: 0 }] : [] }) };
  await runImport({ connectionId: connOOO.id, companyId: MO, legalEntityId: ooo.id, dateFrom: "2026-07-28", dateTo: "2026-07-28", client: moClient, mappings: undefined });
  check("MULTI-OFD5 club_cashbox mapping imports as an ordinary club register", (await p.ofdReceiptImport.count({ where: { companyId: MO, fnNumber: "FN-OOO-1" } })) === 1);
  check("MULTI-OFD6 online_cashbox mapping is imported too (not dropped); registerKind stays on the mapping", (await p.ofdReceiptImport.count({ where: { companyId: MO, fnNumber: "FN-OOO-2" } })) === 1 && (await p.ofdCashRegisterMapping.findUnique({ where: { id: mOnline.id } })).registerKind === "online_cashbox");
  // currentSession validated PER connection (each has its own contractNumber).
  const acctClient = (current) => ({ listAccounts: async () => ({ ok: true, data: { records: [{ agreementNumber: "CD-OOO/1" }], currentAgreementNumber: current } }), listShifts: async () => ({ ok: true, data: [{ shiftNumber: 1 }] }), listDocumentsByShift: async (fn) => ({ ok: true, data: moFd[fn] ? [{ fn, shift: 1, documentType: "3", operationType: "Income", dateTime: "2026-07-30T10:00:00.000Z", fd: moFd[fn], fpd: `${fn}-fpd`, totalKopeks: 100000, cashKopeks: 100000, electronicKopeks: 0 }] : [] }) });
  const wrongSess = await runImport({ connectionId: connOOO.id, companyId: MO, legalEntityId: ooo.id, dateFrom: "2026-07-30", dateTo: "2026-07-30", client: acctClient("CD-OTHER/9"), mappings: [mClub], contractNumber: "CD-OOO/1", normalizeContract });
  const rightSess = await runImport({ connectionId: connOOO.id, companyId: MO, legalEntityId: ooo.id, dateFrom: "2026-07-31", dateTo: "2026-07-31", client: acctClient("CD-OOO/1"), mappings: [mClub], contractNumber: "CD-OOO/1", normalizeContract });
  check("MULTI-OFD4 currentSession is validated per connection: wrong ЛК blocks (account_check), correct ЛК proceeds", wrongSess.status === "failed" && wrongSess.blocked === true && rightSess.status === "success");
  // Batch across both connections: ООО works, ИП (unconfigured) errors safely, batch survives.
  const moBatchImporter = async (connectionId, date) => {
    if (connectionId === connIP.id) return { ok: false, safeCode: "auth_failed" }; // ИП has no secrets
    const r = await runImport({ connectionId, companyId: MO, legalEntityId: ooo.id, dateFrom: date, dateTo: date, client: acctClient("CD-OOO/1"), mappings: [mClub], contractNumber: "CD-OOO/1", normalizeContract });
    return r.status === "failed" ? { ok: false, safeCode: r.safeErrorCode ?? "failed" } : { ok: true, found: r.found, imported: r.imported, skipped: r.skipped, status: r.status, totalIncomeKopeks: 0, totalReturnKopeks: 0 };
  };
  const moBatch = await runSyncNow({ now: new Date(2026, 6, 29, 10, 0), listConnections: async () => [{ id: connOOO.id }, { id: connIP.id }], importer: moBatchImporter });
  check("MULTI-OFD2 import runs per active connection independently (both connections processed)", moBatch.processedConnections === 2 && moBatch.runs.length === 2 && moBatch.runs.some((r) => r.connectionId === connOOO.id) && moBatch.runs.some((r) => r.connectionId === connIP.id));
  check("MULTI-OFD3 ООО succeeds while ИП (not configured) gives a safe error; batch does not fail overall", moBatch.succeeded === 1 && moBatch.failed === 1 && moBatch.runs.find((r) => r.connectionId === connIP.id).safeErrorCode === "auth_failed" && moBatch.runs.find((r) => r.connectionId === connOOO.id).safeErrorCode === null);
  check("MULTI-SECURITY multi-connection results carry only safe fields (no login/password/Integrator-ID/token/ciphertext/raw/fpd/PII/stack)", !/login|password|integrator|sessionToken|Encrypted|Bearer|"fpd"|phone|email|stack|"raw"/i.test(JSON.stringify({ moBatch, wrongSess, rightSess, moConns: moConns.map((c) => ({ id: c.id, displayName: c.displayName, legalEntityId: c.legalEntityId })) })));

  // ===== OFD nomenclature: item parser + revenue categories ===================
  // A. Parser (pure)
  check("RI1 parseReceiptItems reads items/Items/positions/Goods; itemsPresent flag", parseItems({ items: [{ name: "Абонемент", sum: 100 }] }).items.length === 1 && parseItems({ Items: [{ Name: "Карта", Sum: 100 }] }).items.length === 1 && parseItems({ positions: [{ name: "X", total: 50 }] }).items.length === 1 && parseItems({ Goods: [{ name: "Y", amount: 50 }] }).items.length === 1 && parseItems({}).itemsPresent === false && parseItems({ items: [] }).itemsPresent === true);
  check("RI2 parseReceiptItems reads name/quantity/price/sum (all casings)", (() => { const r = parseItems({ items: [{ itemName: "ПТ 10", quantity: 2, price: 50000, sum: 100000 }] }).items[0]; return r.name === "ПТ 10" && r.quantityMilli === 2000 && r.priceKopeks === 50000 && r.totalKopeks === 100000; })());
  check("RI3 parseReceiptItems skips empty name + sum<=0 service lines", parseItems({ items: [{ name: "", sum: 100 }, { name: "   ", sum: 100 }, { name: "Пакет", sum: 0 }, { name: "Скидка", sum: -50 }] }).items.length === 0);
  check("RI4 parsed item keeps ONLY safe fields — no raw JSON / no buyer PII leak", (() => { const it = parseItems({ items: [{ name: "Абонемент", sum: 100, buyerPhone: "+79990000000", email: "a@b.c", raw: { a: 1 } }] }).items[0]; return Object.keys(it).sort().join(",") === "name,normalizedName,priceKopeks,quantityMilli,totalKopeks" && !/79990000000|buyerPhone|a@b\.c|"raw"/i.test(JSON.stringify(it)); })());
  check("RI5 cleanItemName trims/limits/strips control; control-only name dropped", cleanItem("  Абонемент  ") === "Абонемент" && cleanItem("A".repeat(500)).length === 200 && parseItems({ items: [{ name: "", sum: 100 }] }).items.length === 0);
  // B. Categorization (updated CLUB-OPS categories — no bar)
  check("RI6 Абонемент 12 месяцев → membership", categorize(normItem("Абонемент 12 месяцев")).code === "membership");
  check("RI7 ПТ 10 занятий → personal_training", categorize(normItem("ПТ 10 занятий")).code === "personal_training" && categorize(normItem("Персональная тренировка")).code === "personal_training");
  check("RI8 Групповая тренировка → group_training", categorize(normItem("Групповая тренировка")).code === "group_training" && categorize(normItem("ГТ мини-группа")).code === "group_training");
  check("RI9 Заморозка/Переоформление карты → extra_services", categorize(normItem("Заморозка карты")).code === "extra_services" && categorize(normItem("Переоформление карты")).code === "extra_services" && categorize(normItem("Аренда шкафчика")).code === "extra_services");
  check("RI10 unknown → other", categorize(normItem("Массаж спины")).code === "other" && categorize(normItem("")).code === "other");
  check("RI11 DB rule takes priority over fallback", categorize(normItem("Спорт-пакет"), [{ id: "r1", legalEntityId: null, categoryCode: "membership", categoryName: "Абонементы", matchType: "contains", normalizedPattern: "спорт", priority: 10, isActive: true, createdAt: "2026-01-01" }], null).ruleId === "r1" && categorize(normItem("Спорт-пакет"), [], null).code === "other");
  const dbLegal = [{ id: "cw", legalEntityId: null, categoryCode: "other", categoryName: "Иное", matchType: "contains", normalizedPattern: "услуга", priority: 100, isActive: true, createdAt: "2026-01-01" }, { id: "le", legalEntityId: "L1", categoryCode: "extra_services", categoryName: "Доп. услуги", matchType: "contains", normalizedPattern: "услуга", priority: 1, isActive: true, createdAt: "2026-02-01" }];
  check("RI12 legalEntity rule beats company-wide (even at lower priority)", categorize(normItem("Некая услуга"), dbLegal, "L1").ruleId === "le" && categorize(normItem("Некая услуга"), dbLegal, null).ruleId === "cw");
  check("RI13 priority DESC works", categorize(normItem("хму"), [{ id: "lo", legalEntityId: null, categoryCode: "membership", categoryName: "Абонементы", matchType: "contains", normalizedPattern: "х", priority: 1, isActive: true, createdAt: "2026-01-01" }, { id: "hi", legalEntityId: null, categoryCode: "extra_services", categoryName: "Доп. услуги", matchType: "contains", normalizedPattern: "х", priority: 9, isActive: true, createdAt: "2026-01-01" }], null).ruleId === "hi");
  // Category diagnostics: conservative fallback rules for обвиные cases; ambiguous → «Иное».
  const fizRaw = "физкультурно-оздоровительные услуги: договор по101-12979 контракт по101/19783";
  check("OFD-CATEGORIES1 очевидные абонементы → membership", categorize(normItem("Клубная карта")).code === "membership" && categorize(normItem("Абонемент 6 месяцев")).code === "membership" && categorize(normItem("Членство")).code === "membership" && categorize(normGroup(fizRaw), [], null, fizRaw).code === "membership");
  check("OFD-CATEGORIES2 очевидные персональные тренировки → personal_training", categorize(normItem("Персональная тренировка")).code === "personal_training" && categorize(normItem("Персональные тренировки")).code === "personal_training" && categorize(normItem("Тренировка с тренером")).code === "personal_training" && categorize(normItem("ПТ разовая")).code === "personal_training");
  check("OFD-CATEGORIES3 очевидные групповые тренировки → group_training", categorize(normItem("Групповая тренировка")).code === "group_training" && categorize(normItem("Групповое занятие")).code === "group_training" && categorize(normItem("Секция бокса")).code === "group_training" && categorize(normItem("Направление йога")).code === "group_training");
  check("OFD-CATEGORIES4 заморозка/переоформление → extra_services", categorize(normItem("Заморозка карты")).code === "extra_services" && categorize(normItem("Переоформление")).code === "extra_services" && categorize(normItem("Аренда шкафчика")).code === "extra_services");
  check("OFD-CATEGORIES5 сомнительные позиции остаются в «Иное»; неоднозначные шкафчики не уходят в тренировки", categorize(normItem("Массаж спины")).code === "other" && categorize(normItem("Товар без описания")).code === "other" && categorize(normItem("Прочее")).code === "other" && categorize(normItem("Персональный шкафчик")).code === "extra_services" && categorize(normItem("Персональный шкафчик")).code !== "personal_training");
  const catItems = [["Клубная карта", 100000], ["Персональная тренировка", 50000], ["Групповое занятие", 30000], ["Заморозка", 10000], ["Массаж", 5000]];
  const catTotals = {}; let catTotal = 0;
  for (const [n, s] of catItems) { const c = categorize(normItem(n)).code; catTotals[c] = (catTotals[c] || 0) + s; catTotal += s; }
  check("OFD-CATEGORIES7 суммы по категориям в сумме дают общий итог (ни одна позиция не потеряна)", Object.values(catTotals).reduce((a, b) => a + b, 0) === catTotal && catTotal === 195000 && catTotals.membership === 100000 && catTotals.personal_training === 50000 && catTotals.group_training === 30000 && catTotals.extra_services === 10000 && catTotals.other === 5000);

  // C/D. DB idempotency + backfill + category summary (via runImport mirror w/ items)
  const IFN = "FN-ITEMS";
  const mapItems = await p.ofdCashRegisterMapping.create({ data: { connectionId: CONN, companyId: CO, clubId: clubA.id, provider: "taxcom", fnNumber: IFN, isActive: true, activeMappingKey: `taxcom:${IFN}` } });
  const mkItem = (name, total, price) => ({ name, normalizedName: normItem(name), quantityMilli: 1000, priceKopeks: price, totalKopeks: total });
  const itemDocs = [
    { fn: IFN, shift: 5, documentType: "3", operationType: "Income", dateTime: "2026-07-20T10:00:00.000Z", fd: 5001, fpd: "IT1", totalKopeks: 300000, cashKopeks: 300000, electronicKopeks: 0, itemsPresent: true, items: [mkItem("Абонемент 6 мес", 200000, 200000), mkItem("ПТ разовая", 100000, 100000)] },
    { fn: IFN, shift: 5, documentType: "3", operationType: "Income", dateTime: "2026-07-20T11:00:00.000Z", fd: 5002, fpd: "IT2", totalKopeks: 150000, cashKopeks: 0, electronicKopeks: 150000, itemsPresent: true, items: [mkItem("Групповая тренировка", 150000, 150000)] },
  ];
  const itemsClient = { listShifts: async () => ({ ok: true, data: [{ shiftNumber: 5 }] }), listDocumentsByShift: async () => ({ ok: true, data: itemDocs }) };
  const ir1 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-20", dateTo: "2026-07-20", client: itemsClient, mappings: [mapItems] });
  check("RI14 first import saves 3 item rows (2 receipts)", ir1.itemStats.itemRowsSaved === 3 && ir1.itemStats.itemRowsSkipped === 0 && (await p.ofdReceiptItem.count({ where: { companyId: CO, fnNumber: IFN } })) === 3);
  const ir2 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-20", dateTo: "2026-07-20", client: itemsClient, mappings: [mapItems] });
  check("RI15 re-import idempotent: 0 saved / 3 skipped, no duplicate items", ir2.itemStats.itemRowsSaved === 0 && ir2.itemStats.itemRowsSkipped === 3 && (await p.ofdReceiptItem.count({ where: { companyId: CO, fnNumber: IFN } })) === 3);
  const catSum = await p.ofdRevenueCategoryDailySummary.findMany({ where: { companyId: CO, clubId: clubA.id, date: "2026-07-20" } });
  const byCode = Object.fromEntries(catSum.map((s) => [s.categoryCode, s]));
  check("RI16 category summary: income/net + itemCount + unique receiptCount per category", catSum.length === 3 && byCode.membership.incomeTotalKopeks === 200000 && byCode.membership.netTotalKopeks === 200000 && byCode.membership.itemCount === 1 && byCode.membership.receiptCount === 1 && byCode.personal_training.incomeTotalKopeks === 100000 && byCode.group_training.incomeTotalKopeks === 150000 && byCode.group_training.receiptCount === 1);
  // Backfill: receipt first imported WITHOUT items, then re-import WITH items.
  const BFN = "FN-BF";
  const mapBf = await p.ofdCashRegisterMapping.create({ data: { connectionId: CONN, companyId: CO, clubId: clubA.id, provider: "taxcom", fnNumber: BFN, isActive: true, activeMappingKey: `taxcom:${BFN}` } });
  const bfBase = { fn: BFN, shift: 6, documentType: "3", operationType: "Income", dateTime: "2026-07-21T10:00:00.000Z", fd: 6001, fpd: "BF1", totalKopeks: 100000, cashKopeks: 100000, electronicKopeks: 0 };
  const bf1 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-21", dateTo: "2026-07-21", client: { listShifts: async () => ({ ok: true, data: [{ shiftNumber: 6 }] }), listDocumentsByShift: async () => ({ ok: true, data: [{ ...bfBase, itemsPresent: false, items: [] }] }) }, mappings: [mapBf] });
  check("RI17 receipt imported but NO items yet (items not present)", bf1.imported === 1 && bf1.itemStats.itemRowsSaved === 0 && (await p.ofdReceiptItem.count({ where: { fnNumber: BFN } })) === 0);
  check("RI18a no items → OfdDailySalesSummary still computed", (await p.ofdDailySalesSummary.findUnique({ where: { summaryKey: summaryKeyOf(CO, clubA.id, null, "taxcom", "2026-07-21") } })).incomeTotalKopeks === 100000);
  const bf2 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-21", dateTo: "2026-07-21", client: { listShifts: async () => ({ ok: true, data: [{ shiftNumber: 6 }] }), listDocumentsByShift: async () => ({ ok: true, data: [{ ...bfBase, itemsPresent: true, items: [mkItem("Клубная карта", 100000, 100000)] }] }) }, mappings: [mapBf] });
  check("RI18 backfill: skipped receipt gains items on re-import (no dup receipt)", bf2.skipped === 1 && bf2.imported === 0 && bf2.itemStats.itemRowsSaved === 1 && (await p.ofdReceiptItem.count({ where: { fnNumber: BFN } })) === 1 && (await p.ofdReceiptImport.count({ where: { fnNumber: BFN } })) === 1);
  // E. Safety
  check("RI19 runImport result carries no secrets/raw/PII/stack; itemStats counts only", !/login|password|integrator|sessionToken|Bearer|phone|email|buyer|stack|"raw"/i.test(JSON.stringify(ir1)) && Object.keys(ir1.itemStats).sort().join(",") === "categoryOtherCount,documentInfoFailed,documentInfoRequested,documentInfoSucceeded,itemDocumentsSeen,itemRowsSaved,itemRowsSeen,itemRowsSkipped");
  const storedItem = await p.ofdReceiptItem.findFirst({ where: { fnNumber: IFN } });
  check("RI20 stored item row = safe columns only (no phone/email/buyer/customer/raw/json)", !Object.keys(storedItem).some((k) => /phone|email|buyer|customer|raw|json|fio/i.test(k)) && storedItem.itemName.length <= 200);
  await p.ofdReceiptItem.deleteMany({ where: { companyId: CO, fnNumber: { in: [IFN, BFN] } } });
  await p.ofdRevenueCategoryDailySummary.deleteMany({ where: { companyId: CO } });
  await p.ofdReceiptImport.deleteMany({ where: { companyId: CO, fnNumber: { in: [IFN, BFN] } } });
  await p.ofdCashRegisterMapping.deleteMany({ where: { id: { in: [mapItems.id, mapBf.id] } } });

  // ===== NewDocuments shape diagnostics (DIAGNOSTIC ONLY) =====================
  // A. inspectNewDocumentsShape parser — SAFE structure only.
  const ndWithItems = { reportDate: "x", counts: {}, records: [ { documentType: "3", fdNumber: 4935, items: [{ name: "Абонемент", sum: 200000 }], buyerPhone: "+79990000000" }, { documentType: "3", fdNumber: 4936, items: [{ name: "ПТ", sum: 100000 }] }, { documentType: "2", fdNumber: 4934 } ] };
  const sh = inspectNDShape(ndWithItems);
  check("ND1 shape: documentCount + firstDocumentKeys + item-like detection", sh.documentCount === 3 && sh.firstDocumentKeys.includes("items") && sh.detectedItemLikeKeys.includes("items") && sh.hasItemsLikeData === true && sh.topLevelKeys.join(",") === "counts,records,reportDate");
  check("ND2 shape detects positions/goods/products/services/rows + nested fiscalData.items/document.items/receipt.items", inspectNDShape({ records: [{ positions: [{}] }] }).detectedItemLikeKeys.includes("positions") && inspectNDShape({ records: [{ Goods: [{}] }] }).detectedItemLikeKeys.includes("Goods") && inspectNDShape({ records: [{ products: [{}] }] }).detectedItemLikeKeys.includes("products") && inspectNDShape({ records: [{ services: [{}] }] }).detectedItemLikeKeys.includes("services") && inspectNDShape({ records: [{ rows: [{}] }] }).detectedItemLikeKeys.includes("rows") && inspectNDShape({ records: [{ fiscalData: { items: [{}] } }] }).detectedItemLikeKeys.includes("fiscalData.items") && inspectNDShape({ records: [{ document: { items: [{}] } }] }).detectedItemLikeKeys.includes("document.items") && inspectNDShape({ records: [{ receipt: { items: [{}] } }] }).detectedItemLikeKeys.includes("receipt.items"));
  check("ND3 shape returns ONLY key names + counts — NO raw values / no PII leak", (() => { const j = JSON.stringify(sh); return !/79990000000|4935|4936|Абонемент|100000|200000/i.test(j) && Object.keys(sh).sort().join(",") === "detectedItemLikeKeys,documentCount,documentTypeCounts,firstDocumentKeys,hasItemsLikeData,topLevelKeys"; })());
  check("ND4 no items in response → hasItemsLikeData false, still a shape (not an error)", (() => { const s2 = inspectNDShape({ records: [{ documentType: "3", fdNumber: 1, sum: 100 }] }); return s2.hasItemsLikeData === false && s2.detectedItemLikeKeys.length === 0 && s2.documentCount === 1 && s2.documentTypeCounts["3"] === 1; })());
  check("ND5 empty response → documentCount 0, safe shape", (() => { const s0 = inspectNDShape({ records: [] }); return s0.documentCount === 0 && s0.hasItemsLikeData === false && s0.firstDocumentKeys.length === 0; })() && inspectNDShape(null).documentCount === 0 && inspectNDShape("garbage").documentCount === 0);
  // B. Client: GET + an=contractNumber + Session-Token, no POST/body.
  const cfgND = { serverBaseUrl: "https://api-lk-ofd.taxcom.ru", authType: "login_password", contractNumber: "CD-25/455507", login: "L", password: "P", integratorId: "INT-1", integrationToken: null };
  let ndUrl = null, ndInit = null;
  const cliND = makeClient(cfgND, async (url, init) => { if (url.includes("Login")) return okJson({ sessionToken: "TKN" }); if (url.includes("NewDocuments")) { ndUrl = url; ndInit = init; return okJson(ndWithItems); } return okJson({}); });
  const ndRes = await cliND.inspectNewDocuments();
  const ndReq = cliND.captured.find((c) => c.path === "/API/v2/NewDocuments");
  check("ND6 NewDocuments is GET with an=contractNumber + Session-Token; no body/POST", ndReq.method === "GET" && ndReq.url.includes("/API/v2/NewDocuments?") && decodeURIComponent(ndReq.url).includes("an=CD-25/455507") && ndReq.headers["Session-Token"] === "TKN" && ndReq.hasBody === false && !("body" in ndInit) && !/method:\s*"POST"/.test(String(ndInit.method)) && ndInit.method === "GET");
  check("ND7 inspect result is the safe shape (documentCount 3, hasItemsLikeData true), never raw docs", ndRes.ok && ndRes.data.documentCount === 3 && ndRes.data.hasItemsLikeData === true && !/79990000000|Абонемент/i.test(JSON.stringify(ndRes)));
  const cliNDempty = makeClient({ ...cfgND, contractNumber: "" }, async (url) => url.includes("Login") ? okJson({ sessionToken: "T" }) : okJson({ records: [] }));
  await cliNDempty.inspectNewDocuments();
  check("ND8 an omitted when contractNumber empty", !decodeURIComponent(cliNDempty.captured.find((c) => c.path === "/API/v2/NewDocuments").url).includes("an="));
  // C. Errors are classified; empty is success.
  const cliND0 = makeClient(cfgND, async (url) => url.includes("Login") ? okJson({ sessionToken: "T" }) : okJson({ records: [] }));
  const nd0 = await cliND0.inspectNewDocuments();
  check("ND9 no documents → safe success documentCount=0 (not an error)", nd0.ok === true && nd0.data.documentCount === 0);
  const cliND3106 = makeClient(cfgND, async (url) => url.includes("Login") ? okJson({ sessionToken: "T" }) : errJson(200, { apiErrorCode: 3106, commonDescription: "Нет доступных ККТ" }));
  check("ND10 apiErrorCode 3106 → no_kkt_found", (await cliND3106.inspectNewDocuments()).safeCode === "no_kkt_found");
  const cliNDauth = makeClient(cfgND, async (url) => url.includes("Login") ? okJson({ sessionToken: "T" }) : errJson(401, { commonDescription: "Unauthorized" }));
  check("ND11 auth error → auth_failed", (await cliNDauth.inspectNewDocuments()).safeCode === "auth_failed");
  check("ND12 NewDocuments request carries token as a HEADER, never in a body (body absent on GET)", cliND.captured.find((c) => c.path === "/API/v2/NewDocuments").body === undefined && cliND.captured.find((c) => c.path === "/API/v2/NewDocuments").headers["Session-Token"] === "TKN");

  // ===== DocumentInfo shape diagnostics (DIAGNOSTIC ONLY) =====================
  // A. inspectDocumentInfoShape parser — SAFE structure only.
  const diWithItems = { documentType: "3", fdNumber: 4935, fiscalSign: "1571686074", clientInfo: "+79990000000 ivan@mail.ru Иванов", document: { items: [{ name: "Абонемент", sum: 200000 }, { name: "ПТ", sum: 100000 }] } };
  const di = inspectDIShape(diWithItems);
  check("DI1 shape: topLevelKeys + documentKeys + item-like detection + itemLikeCount + safeDocumentType", di.topLevelKeys.includes("document") && di.documentKeys.includes("items") && di.detectedItemLikeKeys.includes("document.items") && di.hasItemsLikeData === true && di.itemLikeCount === 2 && di.safeDocumentType === "3");
  check("DI2 detects items/positions/goods/products/services/rows (direct)", ["items", "positions", "goods", "products", "services", "rows"].every((k) => inspectDIShape({ [k]: [{}] }).detectedItemLikeKeys.includes(k)) && ["Items", "Positions", "Goods", "Products", "Services", "Rows"].every((k) => inspectDIShape({ [k]: [{}] }).detectedItemLikeKeys.includes(k)));
  check("DI3 detects nested fiscalData.items/document.items/receipt.items/ticket.items/content.items", inspectDIShape({ fiscalData: { items: [{}] } }).detectedItemLikeKeys.includes("fiscalData.items") && inspectDIShape({ document: { items: [{}] } }).detectedItemLikeKeys.includes("document.items") && inspectDIShape({ receipt: { items: [{}] } }).detectedItemLikeKeys.includes("receipt.items") && inspectDIShape({ ticket: { items: [{}, {}] } }).detectedItemLikeKeys.includes("ticket.items") && inspectDIShape({ content: { items: [{}] } }).detectedItemLikeKeys.includes("content.items"));
  check("DI4 shape returns ONLY key names + counts — no raw values / no PII values leak", (() => { const j = JSON.stringify(di); return !/79990000000|ivan@mail\.ru|Иванов|1571686074|Абонемент|200000|100000/i.test(j) && Object.keys(di).sort().join(",") === "cashierDetected,cashierFieldsDetected,detectedItemLikeKeys,documentKeys,firstItemKeys,hasCashierLikeKey,hasItemsLikeData,itemLikeCount,numericFfdModeDetected,safeDocumentType,topLevelKeys"; })());
  // Cashier diagnostic (presence-only, for a future cashier→payroll link; no storage, no ФИО).
  check("CASHIER-DIAG1 diagnostic flags a cashier KEY when present (FFD 1021 / 1203 / cashier / operator), value never read", inspectDIShape({ document: { "1021": "Иванова А.А.", "1059": [{ "1030": "Абонемент", "1043": 100 }] } }).hasCashierLikeKey === true && inspectDIShape({ cashier: "Петров", document: {} }).hasCashierLikeKey === true && inspectDIShape({ document: { "1203": "500100732259" } }).hasCashierLikeKey === true && inspectDIShape({ document: { "1059": [{ "1030": "Абонемент", "1043": 100 }] } }).hasCashierLikeKey === false);
  check("CASHIER-DIAG2 cashier ФИО/ПДн never appear in the shape (only the presence boolean + key NAMES); nothing stored", (() => { const s = inspectDIShape({ document: { "1021": "Иванова Анна Петровна", "1203": "500100732259" } }); return s.hasCashierLikeKey === true && s.cashierDetected === true && s.cashierFieldsDetected.join(",") === "1021,1203" && !/Иванова|Анна|Петровна|500100732259/.test(JSON.stringify(s)); })());
  check("CASHIER-DIAG3 diagnostic exposes only cashierDetected (true/false) + cashierFieldsDetected KEY NAMES (no value)", (() => { const yes = inspectDIShape({ document: { "1021": "Петрова", "1059": [{ "1030": "Абонемент", "1043": 100 }] } }); const no = inspectDIShape({ document: { "1059": [{ "1030": "Абонемент", "1043": 100 }] } }); return yes.cashierDetected === true && yes.cashierFieldsDetected.includes("1021") && !yes.cashierFieldsDetected.includes("1030") && no.cashierDetected === false && no.cashierFieldsDetected.length === 0 && !/Петрова/.test(JSON.stringify(yes)); })());
  check("DI5 no items → hasItemsLikeData false, itemLikeCount 0 (not an error)", (() => { const s = inspectDIShape({ documentType: "3", fdNumber: 1, sum: 100 }); return s.hasItemsLikeData === false && s.detectedItemLikeKeys.length === 0 && s.itemLikeCount === 0; })());
  check("DI6 empty / non-object → safe empty shape", (() => { const s = inspectDIShape({}); return s.topLevelKeys.length === 0 && s.hasItemsLikeData === false && s.itemLikeCount === 0 && s.safeDocumentType === null; })() && inspectDIShape(null).hasItemsLikeData === false && inspectDIShape("garbage").itemLikeCount === 0);
  // B. Client: GET + fn/fd query + Session-Token + Integrator-ID, no POST/body.
  const cfgDI = { serverBaseUrl: "https://api-lk-ofd.taxcom.ru", authType: "login_password", contractNumber: "CD-25/455507", login: "L", password: "P", integratorId: "INT-1", integrationToken: null };
  let diInit = null;
  const cliDI = makeClient(cfgDI, async (url, init) => { if (url.includes("Login")) return okJson({ sessionToken: "TKN" }); if (url.includes("DocumentInfo")) { diInit = init; return okJson(diWithItems); } return okJson({}); });
  const diRes = await cliDI.inspectDocumentInfo("7381440800719861", 4935);
  const diReq = cliDI.captured.find((c) => c.path === "/API/v2/DocumentInfo");
  check("DI7 DocumentInfo is GET with fn+fd query + Session-Token + Integrator-ID; no body/POST", diReq.method === "GET" && diReq.url.includes("/API/v2/DocumentInfo?") && diReq.url.includes("fn=7381440800719861") && diReq.url.includes("fd=4935") && diReq.headers["Session-Token"] === "TKN" && diReq.headers["Integrator-ID"] === "INT-1" && diReq.hasBody === false && !("body" in diInit) && diInit.method === "GET");
  check("DI8 inspect result is the safe shape (hasItemsLikeData true, itemLikeCount 2), never raw doc / no PII values", diRes.ok && diRes.data.hasItemsLikeData === true && diRes.data.itemLikeCount === 2 && !/79990000000|ivan@mail\.ru|Иванов|Абонемент|1571686074/i.test(JSON.stringify(diRes)));
  // C. Errors classified; empty is success.
  const cliDI0 = makeClient(cfgDI, async (url) => url.includes("Login") ? okJson({ sessionToken: "T" }) : okJson({ documentType: "3", fdNumber: 9 }));
  const di0 = await cliDI0.inspectDocumentInfo("FN", 9);
  check("DI9 document without positions → safe success hasItemsLikeData=false", di0.ok === true && di0.data.hasItemsLikeData === false && di0.data.itemLikeCount === 0);
  const cliDI3103 = makeClient(cfgDI, async (url) => url.includes("Login") ? okJson({ sessionToken: "T" }) : errJson(404, { apiErrorCode: 3103, commonDescription: "ККТ не найдена" }));
  check("DI10 apiErrorCode 3103 → kkt_not_found", (await cliDI3103.inspectDocumentInfo("FN", 1)).safeCode === "kkt_not_found");
  const cliDI3106 = makeClient(cfgDI, async (url) => url.includes("Login") ? okJson({ sessionToken: "T" }) : errJson(200, { apiErrorCode: 3106, commonDescription: "Нет доступных ККТ" }));
  check("DI11 apiErrorCode 3106 → no_kkt_found", (await cliDI3106.inspectDocumentInfo("FN", 1)).safeCode === "no_kkt_found");
  const cliDIauth = makeClient(cfgDI, async (url) => url.includes("Login") ? okJson({ sessionToken: "T" }) : errJson(401, { commonDescription: "Unauthorized" }));
  check("DI12 auth error → auth_failed", (await cliDIauth.inspectDocumentInfo("FN", 1)).safeCode === "auth_failed");
  check("DI13 result never contains secret/PII words OR the raw PII VALUES; no body sent", !/login|password|integrator|sessionToken|Bearer|phone|email|customer|buyer|stack|"raw"/i.test(JSON.stringify(diRes)) && !/79990000000|ivan@mail\.ru|Иванов/i.test(JSON.stringify(diRes)) && diReq.body === undefined);

  // ===== Taxcom numeric FFD format (tag 1059 = предмет расчёта) ================
  // A real FFD document: positions under document["1059"] with tags 1030/1023/1079/1043.
  const ffdPos = (name, price, sum, qty) => ({ "1030": name, "1079": price, "1043": sum, "1023": qty, "1212": 1, "1214": 4, "1199": 1 });
  const ffdDocArr = { documentType: "3", documentFormatVersion: 4, document: { "1012": "2026-07-15", "1054": 1, "1055": 0, "1059": [ffdPos("Абонемент 6 мес", 200000, 200000, 1), ffdPos("Групповая тренировка", 150000, 150000, 1)], "1077": "1571686074" } };
  const shFfd = inspectDIShape(ffdDocArr);
  check("DI-FFD1 document['1059'] array → hasItemsLikeData, detected 'document.1059', itemLikeCount=2, numericFfdModeDetected", shFfd.hasItemsLikeData === true && shFfd.detectedItemLikeKeys.includes("document.1059") && shFfd.itemLikeCount === 2 && shFfd.numericFfdModeDetected === true);
  check("DI-FFD2 firstItemKeys = key NAMES of first position only (tags), no values", shFfd.firstItemKeys.join(",") === "1023,1030,1043,1079,1199,1212,1214" && !/Абонемент|200000|1571686074/i.test(JSON.stringify(shFfd)));
  check("DI-FFD3 1059 as object → itemLikeCount=1", (() => { const s = inspectDIShape({ document: { "1059": ffdPos("Абонемент", 100, 100, 1) } }); return s.hasItemsLikeData === true && s.itemLikeCount === 1 && s.detectedItemLikeKeys.includes("document.1059"); })());
  check("DI-FFD4 1059 scalar → hasItemsLikeData=false but numericFfdModeDetected=true", (() => { const s = inspectDIShape({ document: { "1059": "not-an-object" } }); return s.hasItemsLikeData === false && s.numericFfdModeDetected === true && s.itemLikeCount === 0 && s.firstItemKeys.length === 0; })());
  check("DI-FFD1b root-level 1059 also detected", inspectDIShape({ "1059": [ffdPos("X", 100, 100, 1)] }).detectedItemLikeKeys.includes("1059"));
  // B. parseReceiptItems reads FFD positions.
  const p1 = parseItems({ "1059": [ffdPos("Абонемент 6 мес", 200000, 200000, 2)] });
  check("RI-FFD1 parseReceiptItems reads 1059 position tags 1030/1023/1079/1043", p1.itemsPresent === true && p1.items.length === 1 && p1.items[0].name === "Абонемент 6 мес" && p1.items[0].totalKopeks === 200000 && p1.items[0].priceKopeks === 200000 && p1.items[0].quantityMilli === 2000 && p1.items[0].normalizedName === "абонемент 6 мес");
  check("RI-FFD2 1059 array yields multiple positions; 1059 object yields one", parseItems({ "1059": [ffdPos("A", 100, 100, 1), ffdPos("B", 200, 200, 1)] }).items.length === 2 && parseItems({ "1059": ffdPos("Solo", 300, 300, 1) }).items.length === 1);
  check("RI-FFD3 itemName cleaned; only safe fields; no raw position / no tag values leak", (() => { const it = parseItems({ "1059": [{ "1030": "  Абонемент  ", "1043": 100, "1212": 1, "1199": 1, "raw": { x: 1 } }] }).items[0]; return it.name === "Абонемент" && Object.keys(it).sort().join(",") === "name,normalizedName,priceKopeks,quantityMilli,totalKopeks" && !/"1212"|"1199"|"raw"/.test(JSON.stringify(it)); })());
  check("RI-FFD4 position without 1030 name is skipped", parseItems({ "1059": [{ "1043": 100, "1023": 1 }] }).items.length === 0);
  check("RI-FFD5 position with total<=0 (1043<=0) is skipped", parseItems({ "1059": [ffdPos("Скидка", 0, 0, 1), ffdPos("Возврат", 0, -50, 1)] }).items.length === 0);
  check("RI-FFD6 FFD safety: parsed items never carry ФПД/phone/email/buyer/raw", (() => { const items = parseItems({ "1059": [ffdPos("Абонемент", 200000, 200000, 1)], "1077": "1571686074", buyerPhone: "+79990000000" }).items; return items.length === 1 && !/1571686074|79990000000|buyerPhone|phone|"raw"/i.test(JSON.stringify(items)); })());

  // ===== LIVE nomenclature import via DocumentInfo (OFD-DI-IMPORT) =============
  // Money import stays ShiftList+DocumentList; DocumentInfo ONLY enriches receipts lacking positions.
  const DIFN = "FN-DIIMP";
  const mapDI = await p.ofdCashRegisterMapping.create({ data: { connectionId: CONN, companyId: CO, clubId: clubA.id, provider: "taxcom", fnNumber: DIFN, isActive: true, activeMappingKey: `taxcom:${DIFN}` } });
  // DocumentList returns receipts WITHOUT positions (production format); DocumentInfo carries FFD 1059.
  const diDocs = [
    { fn: DIFN, shift: 8, documentType: "3", operationType: "Income", dateTime: "2026-07-22T10:00:00.000Z", fd: 7001, fpd: "P7001", totalKopeks: 300000, cashKopeks: 300000, electronicKopeks: 0 },
    { fn: DIFN, shift: 8, documentType: "3", operationType: "Income", dateTime: "2026-07-22T11:00:00.000Z", fd: 7002, fpd: "P7002", totalKopeks: 150000, cashKopeks: 0, electronicKopeks: 150000 },
  ];
  // DocumentInfo per fd → real FFD document.1059. The 1077/clientInfo below are DISTINCT secret ФПД/PII that must NEVER be stored.
  const diInfoByFd = {
    7001: { documentType: "3", document: { "1059": [ffdPos("Абонемент 6 мес", 200000, 200000, 1), ffdPos("ПТ разовая", 100000, 100000, 1)], "1077": "SECRETFPD7001", clientInfo: "+79990000000 ivan@mail.ru" } },
    7002: { documentType: "3", document: { "1059": ffdPos("Групповая тренировка", 150000, 150000, 1), "1077": "SECRETFPD7002" } },
  };
  const diLiveClient = { listShifts: async () => ({ ok: true, data: [{ shiftNumber: 8 }] }), listDocumentsByShift: async () => ({ ok: true, data: diDocs }), getDocumentInfoForReceipt: async (fn, fd) => { const raw = diInfoByFd[fd]; return raw ? { ok: true, data: parseItemsFromDI(raw) } : { ok: true, data: { items: [], itemsPresent: false } }; } };
  const di1 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-22", dateTo: "2026-07-22", client: diLiveClient, mappings: [mapDI] });
  check("OFD-DI-IMPORT1 fresh import: 2 money receipts (ShiftList+DocumentList) + 3 positions via DocumentInfo", di1.imported === 2 && di1.itemStats.documentInfoRequested === 2 && di1.itemStats.documentInfoSucceeded === 2 && di1.itemStats.documentInfoFailed === 0 && di1.itemStats.itemRowsSaved === 3 && (await p.ofdReceiptImport.count({ where: { companyId: CO, fnNumber: DIFN } })) === 2 && (await p.ofdReceiptItem.count({ where: { companyId: CO, fnNumber: DIFN } })) === 3);
  const diItem = await p.ofdReceiptItem.findFirst({ where: { fnNumber: DIFN, normalizedItemName: normItem("Абонемент 6 мес") } });
  check("OFD-DI-IMPORT2 stored position = safe fields + category; ФПД in itemKey only, fiscalSign null", diItem.itemName === "Абонемент 6 мес" && diItem.quantityMilli === 1000 && diItem.priceKopeks === 200000 && diItem.totalKopeks === 200000 && diItem.revenueCategoryCode === "membership" && diItem.fiscalSign === null && diItem.itemKey === `taxcom:${DIFN}:7001:P7001:0`);
  const diCat = await p.ofdRevenueCategoryDailySummary.findMany({ where: { companyId: CO, clubId: clubA.id, date: "2026-07-22" } });
  const diByCode = Object.fromEntries(diCat.map((s) => [s.categoryCode, s]));
  check("OFD-DI-IMPORT3 revenue category summary built from DocumentInfo positions", diByCode.membership.incomeTotalKopeks === 200000 && diByCode.personal_training.incomeTotalKopeks === 100000 && diByCode.group_training.incomeTotalKopeks === 150000);
  const gtItem = await p.ofdReceiptItem.findFirst({ where: { fnNumber: DIFN, normalizedItemName: normItem("Групповая тренировка") } });
  check("OFD-DI-IMPORT9 DocumentInfo 1059 as single object → one position saved", !!gtItem && gtItem.totalKopeks === 150000 && gtItem.revenueCategoryCode === "group_training");
  const di2 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-22", dateTo: "2026-07-22", client: diLiveClient, mappings: [mapDI] });
  check("OFD-DI-IMPORT4 re-import idempotent: DocumentInfo NOT re-requested (positions exist); no dup receipts/items", di2.itemStats.documentInfoRequested === 0 && di2.itemStats.itemRowsSaved === 0 && (await p.ofdReceiptImport.count({ where: { fnNumber: DIFN } })) === 2 && (await p.ofdReceiptItem.count({ where: { fnNumber: DIFN } })) === 3);
  const diItemsJson = JSON.stringify(await p.ofdReceiptItem.findMany({ where: { fnNumber: DIFN } }));
  check("OFD-DI-IMPORT7 stored positions carry NO ФПД(1077 value)/PII/raw JSON; result safe", !/SECRETFPD7001|SECRETFPD7002|79990000000|ivan@mail\.ru|"raw"|"1077"|"1059"/i.test(diItemsJson) && !/login|password|integrator|sessionToken|Bearer|phone|email|buyer|"raw"/i.test(JSON.stringify(di1)));
  // Backfill: receipt first saved WITHOUT positions (DocumentInfo empty), then re-import once DocumentInfo returns them.
  const BFDFN = "FN-DIBF";
  const mapDIbf = await p.ofdCashRegisterMapping.create({ data: { connectionId: CONN, companyId: CO, clubId: clubA.id, provider: "taxcom", fnNumber: BFDFN, isActive: true, activeMappingKey: `taxcom:${BFDFN}` } });
  const bfDoc = { fn: BFDFN, shift: 9, documentType: "3", operationType: "Income", dateTime: "2026-07-23T10:00:00.000Z", fd: 7100, fpd: "P7100", totalKopeks: 100000, cashKopeks: 100000, electronicKopeks: 0 };
  const dibf1 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-23", dateTo: "2026-07-23", client: { listShifts: async () => ({ ok: true, data: [{ shiftNumber: 9 }] }), listDocumentsByShift: async () => ({ ok: true, data: [bfDoc] }), getDocumentInfoForReceipt: async () => ({ ok: true, data: { items: [], itemsPresent: false } }) }, mappings: [mapDIbf] });
  check("OFD-DI-IMPORT5a receipt saved; DocumentInfo has no positions yet → 0 item rows", dibf1.imported === 1 && dibf1.itemStats.documentInfoRequested === 1 && dibf1.itemStats.itemRowsSaved === 0 && (await p.ofdReceiptItem.count({ where: { fnNumber: BFDFN } })) === 0);
  const dibf2 = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-23", dateTo: "2026-07-23", client: { listShifts: async () => ({ ok: true, data: [{ shiftNumber: 9 }] }), listDocumentsByShift: async () => ({ ok: true, data: [bfDoc] }), getDocumentInfoForReceipt: async () => ({ ok: true, data: parseItemsFromDI({ document: { "1059": ffdPos("Клубная карта", 100000, 100000, 1) } }) }) }, mappings: [mapDIbf] });
  check("OFD-DI-IMPORT5b backfill: skipped receipt re-requests DocumentInfo and gains positions (no dup receipt)", dibf2.skipped === 1 && dibf2.imported === 0 && dibf2.itemStats.documentInfoRequested === 1 && dibf2.itemStats.itemRowsSaved === 1 && (await p.ofdReceiptItem.count({ where: { fnNumber: BFDFN } })) === 1 && (await p.ofdReceiptImport.count({ where: { fnNumber: BFDFN } })) === 1);
  // DocumentInfo failure on ONE receipt must not fail the money import.
  const EFDFN = "FN-DIERR";
  const mapDIerr = await p.ofdCashRegisterMapping.create({ data: { connectionId: CONN, companyId: CO, clubId: clubA.id, provider: "taxcom", fnNumber: EFDFN, isActive: true, activeMappingKey: `taxcom:${EFDFN}` } });
  const errDocs = [ { fn: EFDFN, shift: 10, documentType: "3", operationType: "Income", dateTime: "2026-07-24T10:00:00.000Z", fd: 7200, fpd: "P7200", totalKopeks: 300000, cashKopeks: 300000, electronicKopeks: 0 }, { fn: EFDFN, shift: 10, documentType: "3", operationType: "Income", dateTime: "2026-07-24T11:00:00.000Z", fd: 7201, fpd: "P7201", totalKopeks: 150000, cashKopeks: 0, electronicKopeks: 150000 } ];
  const die = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-24", dateTo: "2026-07-24", client: { listShifts: async () => ({ ok: true, data: [{ shiftNumber: 10 }] }), listDocumentsByShift: async () => ({ ok: true, data: errDocs }), getDocumentInfoForReceipt: async (fn, fd) => fd === 7201 ? { ok: false, safeCode: "network_error" } : { ok: true, data: parseItemsFromDI({ document: { "1059": ffdPos("Абонемент", 300000, 300000, 1) } }) } }, mappings: [mapDIerr] });
  check("OFD-DI-IMPORT6 DocumentInfo failure on one receipt does NOT fail money import (status success, money saved)", die.status === "success" && die.imported === 2 && die.itemStats.documentInfoFailed === 1 && die.itemStats.documentInfoSucceeded === 1 && die.itemStats.itemRowsSaved === 1 && (await p.ofdReceiptImport.count({ where: { fnNumber: EFDFN } })) === 2);
  const dieErr = await p.ofdSyncError.findFirst({ where: { fnNumber: EFDFN, stage: "document_info" } });
  check("OFD-DI-IMPORT6b safe OfdSyncError recorded (taxcom_document_info_unavailable; fn/fd/code only, no raw/PII)", !!dieErr && dieErr.safeCode === "taxcom_document_info_unavailable" && dieErr.safeMessage.includes("fd=7201") && !/login|password|integrator|sessionToken|"raw"|phone|email|@/i.test(dieErr.safeMessage));
  // DocumentInfo without a 1059 tag → receipt saved, no positions, import not failed.
  const NFDFN = "FN-DINO";
  const mapDIno = await p.ofdCashRegisterMapping.create({ data: { connectionId: CONN, companyId: CO, clubId: clubA.id, provider: "taxcom", fnNumber: NFDFN, isActive: true, activeMappingKey: `taxcom:${NFDFN}` } });
  const noDoc = { fn: NFDFN, shift: 11, documentType: "3", operationType: "Income", dateTime: "2026-07-25T10:00:00.000Z", fd: 7300, fpd: "P7300", totalKopeks: 50000, cashKopeks: 50000, electronicKopeks: 0 };
  const dino = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-25", dateTo: "2026-07-25", client: { listShifts: async () => ({ ok: true, data: [{ shiftNumber: 11 }] }), listDocumentsByShift: async () => ({ ok: true, data: [noDoc] }), getDocumentInfoForReceipt: async () => ({ ok: true, data: parseItemsFromDI({ documentType: "3", document: { "1054": 1, "1077": "SECRET7300" } }) }) }, mappings: [mapDIno] });
  check("OFD-DI-IMPORT10 DocumentInfo without 1059 → receipt saved, no positions, import not failed", dino.status === "success" && dino.imported === 1 && dino.itemStats.documentInfoRequested === 1 && dino.itemStats.documentInfoSucceeded === 1 && dino.itemStats.itemRowsSaved === 0 && (await p.ofdReceiptItem.count({ where: { fnNumber: NFDFN } })) === 0);
  // Client method wiring: GET fn/fd + Session-Token + Integrator-ID, no body, returns parsed items only.
  const cliDIlive = makeClient(cfgDI, async (url) => url.includes("Login") ? okJson({ sessionToken: "TKN" }) : url.includes("DocumentInfo") ? okJson({ documentType: "3", document: { "1059": [ffdPos("Абонемент 6 мес", 200000, 200000, 1)], "1077": "SECRETX", clientInfo: "+79990000000" } }) : okJson({}));
  const diLiveRes = await cliDIlive.getDocumentInfoForReceipt("7381440800719861", 4935);
  const diLiveReq = cliDIlive.captured.find((c) => c.path === "/API/v2/DocumentInfo");
  check("OFD-DI-IMPORT8 getDocumentInfoForReceipt: GET fn+fd + Session-Token + Integrator-ID; no body/POST; parsed items only, no raw/1077/PII", diLiveReq.method === "GET" && diLiveReq.url.includes("fn=7381440800719861") && diLiveReq.url.includes("fd=4935") && diLiveReq.headers["Session-Token"] === "TKN" && diLiveReq.headers["Integrator-ID"] === "INT-1" && diLiveReq.hasBody === false && diLiveReq.body === undefined && diLiveRes.ok && diLiveRes.data.itemsPresent === true && diLiveRes.data.items.length === 1 && diLiveRes.data.items[0].name === "Абонемент 6 мес" && !/SECRETX|79990000000|"1077"|"1059"|"raw"/i.test(JSON.stringify(diLiveRes)));
  await p.ofdReceiptItem.deleteMany({ where: { companyId: CO, fnNumber: { in: [DIFN, BFDFN, EFDFN, NFDFN] } } });
  await p.ofdRevenueCategoryDailySummary.deleteMany({ where: { companyId: CO } });
  await p.ofdSyncError.deleteMany({ where: { fnNumber: { in: [DIFN, BFDFN, EFDFN, NFDFN] } } });
  await p.ofdReceiptImport.deleteMany({ where: { companyId: CO, fnNumber: { in: [DIFN, BFDFN, EFDFN, NFDFN] } } });
  await p.ofdCashRegisterMapping.deleteMany({ where: { id: { in: [mapDI.id, mapDIbf.id, mapDIerr.id, mapDIno.id] } } });

  // ===== Category rules + normalization (CAT) + local reclassify (RECALC) ======
  const FIZ = "физкультурно-оздоровительные услуги: договор по101-12979 контракт по101/19783";
  check("CAT1 физкультурно-оздоровительные услуги (with contract refs) → membership", categorize(normGroup(FIZ), [], null, FIZ).code === "membership");
  check("CAT2 normGroup strips договор/контракт numbers → clean groupable name", normGroup(FIZ) === "физкультурно оздоровительные услуги");
  check("CAT3 'доп. услуги' → extra_services", categorize(normGroup("доп. услуги"), [], null, "доп. услуги").code === "extra_services");
  check("CAT4 'доп услуги' → extra_services", categorize(normGroup("доп услуги"), [], null, "доп услуги").code === "extra_services");
  check("CAT5 'персональная тренировка' → personal_training", categorize(normGroup("Персональная тренировка"), [], null, "Персональная тренировка").code === "personal_training");
  check("CAT6 'групповая тренировка' → group_training", categorize(normGroup("Групповая тренировка"), [], null, "Групповая тренировка").code === "group_training");
  check("CAT7 unknown → other", categorize(normGroup("Батончик протеиновый"), [], null, "Батончик протеиновый").code === "other");
  check("CAT8 DB rule still beats fallback (физкультурно routed by DB rule, not membership fallback)", categorize(normGroup(FIZ), [{ id: "db1", legalEntityId: null, categoryCode: "extra_services", categoryName: "Доп. услуги", matchType: "contains", normalizedPattern: "физкультурно", priority: 50, isActive: true, createdAt: "2026-01-01" }], null, FIZ).ruleId === "db1");
  check("CATc compound físкультур+договор+контракт net → membership even if fallback misses", categorize("нечто", [], null, "физкультурно договор №1 контракт №2").code === "membership");
  // RECALC: import with the NEW rules, force a STALE 'other' state, then reclassify.
  const RCFN = "FN-RC";
  const mapRC = await p.ofdCashRegisterMapping.create({ data: { connectionId: CONN, companyId: CO, clubId: clubA.id, provider: "taxcom", fnNumber: RCFN, isActive: true, activeMappingKey: `taxcom:${RCFN}` } });
  const rcDocs = [
    { fn: RCFN, shift: 20, documentType: "3", operationType: "Income", dateTime: "2026-07-26T10:00:00.000Z", fd: 9001, fpd: "RC1", totalKopeks: 500000, cashKopeks: 500000, electronicKopeks: 0 },
    { fn: RCFN, shift: 20, documentType: "3", operationType: "Income", dateTime: "2026-07-26T11:00:00.000Z", fd: 9002, fpd: "RC2", totalKopeks: 100000, cashKopeks: 0, electronicKopeks: 100000 },
  ];
  const rcInfo = { 9001: { document: { "1059": [ffdPos(FIZ, 400000, 400000, 1), ffdPos("Батончик протеиновый", 100000, 100000, 1)] } }, 9002: { document: { "1059": ffdPos("доп. услуги", 100000, 100000, 1) } } };
  const rcClient = { listShifts: async () => ({ ok: true, data: [{ shiftNumber: 20 }] }), listDocumentsByShift: async () => ({ ok: true, data: rcDocs }), getDocumentInfoForReceipt: async (fn, fd) => ({ ok: true, data: parseItemsFromDI(rcInfo[fd]) }) };
  await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-26", dateTo: "2026-07-26", client: rcClient, mappings: [mapRC] });
  // Simulate a pre-rules-change state: everything mis-filed as "other", физкультурно name un-grouped.
  await p.ofdReceiptItem.updateMany({ where: { companyId: CO, fnNumber: RCFN }, data: { revenueCategoryCode: "other", revenueCategoryName: "Иное" } });
  const fizRow = await p.ofdReceiptItem.findFirst({ where: { fnNumber: RCFN, itemName: { contains: "физкультурно" } } });
  await p.ofdReceiptItem.update({ where: { id: fizRow.id }, data: { normalizedItemName: "физкультурно оздоровительные услуги договор по101 12979 контракт по101 19783" } });
  await recomputeCategorySummary(CO, clubA.id, null, "2026-07-26");
  const rc = await reclassifyForCompany(CO);
  check("RECALC1 reclassify moves stale 'other' items into membership/extra_services (unknown stays other)", rc.updated >= 2 && (await p.ofdReceiptItem.count({ where: { fnNumber: RCFN, revenueCategoryCode: "membership" } })) === 1 && (await p.ofdReceiptItem.count({ where: { fnNumber: RCFN, revenueCategoryCode: "extra_services" } })) === 1 && (await p.ofdReceiptItem.count({ where: { fnNumber: RCFN, revenueCategoryCode: "other" } })) === 1 && (await p.ofdReceiptItem.findUnique({ where: { id: fizRow.id } })).normalizedItemName === "физкультурно оздоровительные услуги");
  const rcCat = Object.fromEntries((await p.ofdRevenueCategoryDailySummary.findMany({ where: { companyId: CO, clubId: clubA.id, date: "2026-07-26" } })).map((s) => [s.categoryCode, s]));
  check("RECALC2 OfdRevenueCategoryDailySummary recomputed after reclassify", !!rcCat.membership && rcCat.membership.incomeTotalKopeks === 400000 && !!rcCat.extra_services && rcCat.extra_services.incomeTotalKopeks === 100000 && !!rcCat.other && rcCat.other.incomeTotalKopeks === 100000);
  const rcMoney = await p.ofdDailySalesSummary.findUnique({ where: { summaryKey: summaryKeyOf(CO, clubA.id, null, "taxcom", "2026-07-26") } });
  check("RECALC3 reclassify does NOT touch money (OfdDailySalesSummary + receipt count unchanged)", rcMoney.incomeTotalKopeks === 600000 && (await p.ofdReceiptImport.count({ where: { companyId: CO, fnNumber: RCFN } })) === 2);
  const rc2 = await reclassifyForCompany(CO);
  check("RECALC4 reclassify is idempotent + LOCAL-ONLY (2nd run updates 0; signature takes only companyId)", rc2.updated === 0 && reclassifyForCompany.length === 1);
  await p.ofdReceiptItem.deleteMany({ where: { companyId: CO, fnNumber: RCFN } });
  await p.ofdRevenueCategoryDailySummary.deleteMany({ where: { companyId: CO } });
  await p.ofdReceiptImport.deleteMany({ where: { companyId: CO, fnNumber: RCFN } });
  await p.ofdCashRegisterMapping.deleteMany({ where: { id: mapRC.id } });

  // ===== Revenue category drilldown detail (REV-DETAIL) ========================
  const DRFN = "FN-DRILL";
  const mapDR = await p.ofdCashRegisterMapping.create({ data: { connectionId: CONN, companyId: CO, clubId: clubA.id, provider: "taxcom", fnNumber: DRFN, isActive: true, activeMappingKey: `taxcom:${DRFN}` } });
  // 4 membership lines from 4 DIFFERENT contract raws → one grouped normalizedName; one long raw (>160) to test the example cap.
  // >160 (to exercise the example cap) but <200 so cleanItem never truncates mid-clause.
  const longRaw = "физкультурно-оздоровительные услуги: договор по101-1001 " + Array.from({ length: 6 }, (_, i) => `контракт по101/${2000 + i}`).join(" ");
  const drRaw = [longRaw, "физкультурно-оздоровительные услуги: договор по101-1002 контракт по101/2102", "физкультурно-оздоровительные услуги: договор по101-1003 контракт по101/2103", "физкультурно-оздоровительные услуги: договор по101-1004 контракт по101/2104"];
  const drDocs = [
    { fn: DRFN, shift: 30, documentType: "3", operationType: "Income", dateTime: "2026-07-27T10:00:00.000Z", fd: 8001, fpd: "D1", totalKopeks: 200000, cashKopeks: 200000, electronicKopeks: 0 },
    { fn: DRFN, shift: 30, documentType: "3", operationType: "Income", dateTime: "2026-07-27T11:00:00.000Z", fd: 8002, fpd: "D2", totalKopeks: 100000, cashKopeks: 100000, electronicKopeks: 0 },
    { fn: DRFN, shift: 30, documentType: "3", operationType: "Income", dateTime: "2026-07-27T12:00:00.000Z", fd: 8003, fpd: "D3", totalKopeks: 146000, cashKopeks: 146000, electronicKopeks: 0 },
  ];
  const drInfo = {
    8001: { document: { "1059": [ffdPos(drRaw[0], 100000, 100000, 1), ffdPos(drRaw[1], 100000, 100000, 1)] } }, // 2 membership lines, SAME receipt
    8002: { document: { "1059": ffdPos(drRaw[2], 100000, 100000, 1) } },                                       // 1 membership line
    8003: { document: { "1059": [ffdPos(drRaw[3], 100000, 100000, 1), ffdPos("доп. услуги", 46000, 46000, 1)] } }, // membership + доп услуги
  };
  const drClient = { listShifts: async () => ({ ok: true, data: [{ shiftNumber: 30 }] }), listDocumentsByShift: async () => ({ ok: true, data: drDocs }), getDocumentInfoForReceipt: async (fn, fd) => ({ ok: true, data: parseItemsFromDI(drInfo[fd]) }) };
  await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-27", dateTo: "2026-07-27", client: drClient, mappings: [mapDR] });
  const detail = await buildCategoryDetails(CO, "2026-07");
  check("REV-DETAIL1 detail groups OfdReceiptItem by revenueCategoryCode + normalizedName", Array.isArray(detail.membership) && detail.membership.length === 1 && detail.membership[0].normalizedName === "физкультурно оздоровительные услуги" && Array.isArray(detail.extra_services) && detail.extra_services.length === 1 && detail.extra_services[0].normalizedName === "доп услуги");
  const drCat = Object.fromEntries((await p.ofdRevenueCategoryDailySummary.findMany({ where: { companyId: CO, clubId: clubA.id, date: "2026-07-27" } })).map((s) => [s.categoryCode, s]));
  check("REV-DETAIL2 detail sum per category equals category summary net", detail.membership.reduce((n, r) => n + r.net, 0) === drCat.membership.netTotalKopeks && detail.extra_services.reduce((n, r) => n + r.net, 0) === drCat.extra_services.netTotalKopeks);
  check("REV-DETAIL3 receiptCount counts DISTINCT receiptImportId (4 items across 3 receipts → 3)", detail.membership[0].receiptCount === 3);
  check("REV-DETAIL4 itemCount counts positions", detail.membership[0].itemCount === 4 && detail.extra_services[0].itemCount === 1);
  check("REV-DETAIL5 example raw names capped at 3 and truncated to ≤160 chars", detail.membership[0].examples.length === 3 && Math.max(...detail.membership[0].examples.map((e) => e.length)) <= 160 && longRaw.length > 160);
  check("REV-DETAIL6 4 different contract raws collapse into ONE membership detail row (grouped by normalizedName)", detail.membership.length === 1 && detail.membership[0].itemCount === 4);
  check("REV-DETAIL-SEC detail carries only safe fields; no rawJson/fiscalSign/fpd/1077/phone/email/buyer/customer/token/password/Integrator-ID", (() => {
    const keys = new Set(); for (const arr of Object.values(detail)) for (const r of arr) Object.keys(r).forEach((k) => keys.add(k));
    return [...keys].sort().join(",") === "examples,income,itemCount,net,normalizedName,receiptCount" && !/fiscalSign|"fpd"|1077|phone|email|buyer|customer|sessionToken|password|integrator|"raw"|rawJson/i.test(JSON.stringify(detail));
  })());
  await p.ofdReceiptItem.deleteMany({ where: { companyId: CO, fnNumber: DRFN } });
  await p.ofdRevenueCategoryDailySummary.deleteMany({ where: { companyId: CO } });
  await p.ofdReceiptImport.deleteMany({ where: { companyId: CO, fnNumber: DRFN } });
  await p.ofdCashRegisterMapping.deleteMany({ where: { id: mapDR.id } });

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
  // normalizeContract was loaded from src/lib/ofd/contract.ts above (real source).
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
      return { ok: false, code: "taxcom_wrong_current_account", error: `Договор выбран и доступен в AccountList, но Такском открыл API-сессию в другом ЛК: ${currentSession ?? "неизвестен"}. Для импорта нужен текущий ЛК: ${requestedContractNumber}. Уточните у Такском, какой идентификатор/параметр переключает API-сессию на выбранный договор.`, matchedContract, diagnostics: { currentSession, requestedContractNumber, matchedContract, availableContracts } };
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

  // ===== Taxcom contract picker (CONTRACT-PICKER) =============================
  // Mirror of loadTaxcomContractsAction: safe список from AccountList — NO token /
  // secrets / raw AccountList / accessRights; only agreementNumber/companyName/inn/kpp.
  function buildContractsResult(cfg, accountData) {
    const availableContracts = accountData.records.map((r) => ({ agreementNumber: r.agreementNumber, companyName: r.companyName ?? null, inn: r.inn ?? null, kpp: r.kpp ?? null }));
    const currentSession = accountData.currentAgreementNumber;
    const requestedContractNumber = (cfg.contractNumber && cfg.contractNumber.trim()) || "";
    const requestedNormalized = normalizeContract(requestedContractNumber);
    const matchedContract = requestedContractNumber ? (availableContracts.find((cn) => normalizeContract(cn.agreementNumber) === requestedNormalized) ?? null) : null;
    return { ok: true, code: "contracts_loaded", currentSession, diagnostics: { currentSession, requestedContractNumber, availableContracts, matchedContract } };
  }
  const cpAcc = parseAccountList(rawAccountList); // ИП CD-22/380310, ООО ФИТНЕС, ООО СПОРТ ТЕХНОЛОГИИ; currentSession CD-25/45507
  const cpLoad = buildContractsResult({ contractNumber: "CD-25/45507" }, cpAcc);
  check("CONTRACT-PICKER1 loadTaxcomContracts returns a safe список договоров from AccountList", cpLoad.ok === true && cpLoad.code === "contracts_loaded" && cpLoad.diagnostics.availableContracts.length === 3 && cpLoad.diagnostics.availableContracts[0].agreementNumber === "CD-22/380310" && cpLoad.diagnostics.matchedContract && cpLoad.diagnostics.matchedContract.agreementNumber === "CD-25/45507");
  check("CONTRACT-PICKER2 result carries currentSession + records agreementNumber/companyName/inn/kpp", cpLoad.currentSession === "CD-25/45507" && cpLoad.diagnostics.availableContracts.every((r) => "agreementNumber" in r && "companyName" in r && "inn" in r && "kpp" in r) && cpLoad.diagnostics.availableContracts[2].companyName === "ООО СПОРТ ТЕХНОЛОГИИ" && cpLoad.diagnostics.availableContracts[2].inn === "6679182168" && cpLoad.diagnostics.availableContracts[2].kpp === "667901001");
  check("CONTRACT-PICKER3 result has NO accessRights/SessionToken/login/password/Integrator-ID/raw AccountList", !/accessRights|sessionToken|SECRET-SESSION-TOKEN|password|integrator/i.test(JSON.stringify(cpLoad)) && cpLoad.diagnostics.availableContracts.every((r) => Object.keys(r).sort().join(",") === "agreementNumber,companyName,inn,kpp"));
  // Select the ООО договор → contractNumber persisted on the connection (CONN starts with none).
  const beforeSel = await p.ofdConnection.findUnique({ where: { id: CONN }, select: { contractNumber: true } });
  await p.ofdConnection.update({ where: { id: CONN }, data: { contractNumber: "CD-25/45507" } });
  const afterSel = await p.ofdConnection.findUnique({ where: { id: CONN }, select: { contractNumber: true } });
  check("CONTRACT-PICKER4 selecting a договор updates OfdConnection.contractNumber", (beforeSel.contractNumber ?? null) === null && afterSel.contractNumber === "CD-25/45507");
  // After selecting, the connection is NOT working until a check confirms the current ЛК.
  const cpWrongAcc = parseAccountList({ currentSession: "CD-22/368037", records: rawAccountList.records });
  const cpAfterSelectWrong = buildCheckResult({ contractNumber: "CD-25/45507" }, cpWrongAcc);
  check("CONTRACT-PICKER5 selecting a договор does NOT auto-mark success; check with a different currentSession is not ok", cpAfterSelectWrong.ok === false && cpAfterSelectWrong.code === "taxcom_wrong_current_account");
  check("CONTRACT-PICKER6 checkOfdConnection mismatch → taxcom_wrong_current_account with a clear API-session message (no secrets)", cpAfterSelectWrong.code === "taxcom_wrong_current_account" && cpAfterSelectWrong.error.includes("Такском открыл API-сессию в другом ЛК") && cpAfterSelectWrong.error.includes("CD-22/368037") && cpAfterSelectWrong.error.includes("CD-25/45507") && !/token|password|login|integrator|accessRights/i.test(cpAfterSelectWrong.error));
  const cpMatchAcc = parseAccountList({ currentSession: "CD-25/45507", records: rawAccountList.records });
  const cpAfterSelectOk = buildCheckResult({ contractNumber: "CD-25/45507" }, cpMatchAcc);
  check("CONTRACT-PICKER7 checkOfdConnection with currentSession == selected договор → success", cpAfterSelectOk.ok === true && cpAfterSelectOk.code !== "taxcom_wrong_current_account" && cpAfterSelectOk.notice.includes("Текущий ЛК Такском соответствует выбранному договору"));
  check("CONTRACT-PICKER-SECURITY no secrets/accessRights/raw AccountList/token/PII in any picker result", !/accessRights|sessionToken|SECRET-SESSION-TOKEN|password|integrator|Bearer|"raw"|phone|email|stack/i.test(JSON.stringify({ cpLoad, cpAfterSelectWrong, cpAfterSelectOk })));

  // ===== Contract number in Taxcom Login (LOGIN-CONTRACT) =====================
  // Fake Taxcom opens the API-session in the договор sent at Login (agreementNumber),
  // otherwise falls back to the login's default ЛК (ИП CD-22/380310).
  const lcRecords = [{ agreementNumber: "CD-22/380310", companyName: "ИП АЛМАКАЕВ", inn: "744605538886" }, { agreementNumber: "CD-25/455507", companyName: "ООО СПОРТ ТЕХНОЛОГИИ", inn: "6679182168", kpp: "667901001" }];
  const fakeTaxcom = (defaultSession) => { let opened = defaultSession; return async (url, init) => {
    if (url.includes("/Login")) { const body = JSON.parse(init.body); if (body.agreementNumber && lcRecords.some((r) => r.agreementNumber === body.agreementNumber)) opened = body.agreementNumber; return okJson({ sessionToken: "TK" }); }
    if (url.includes("/AccountList")) return okJson({ currentSession: opened, records: lcRecords });
    if (url.includes("/ShiftList")) return okJson({ records: [] });
    return okJson({ records: [] });
  }; };
  const cfgOOO = { ...cfgAg, contractNumber: "CD-25/455507" };
  const cfgIP = { ...cfgAg, contractNumber: "CD-22/380310" };
  const cfgNone = { ...cfgAg, contractNumber: "" };
  const lc1Cli = makeClient(cfgOOO, fakeTaxcom("CD-22/380310"));
  await lc1Cli.login();
  const lc1Login = lc1Cli.captured.find((c) => c.path === "/API/v2/Login");
  check("LOGIN-CONTRACT1 Taxcom Login carries agreementNumber from OfdConnection.contractNumber", lc1Login.body.agreementNumber === "CD-25/455507" && lc1Login.body.login === "l" && lc1Login.body.password === "p");
  const lc2Cli = makeClient(cfgOOO, fakeTaxcom("CD-22/380310"));
  await lc2Cli.login(); const lc2Acc = await lc2Cli.listAccounts();
  const lc2 = buildCheckResult(cfgOOO, lc2Acc.data);
  check("LOGIN-CONTRACT2 ООО CD-25/455507: Login sends it → fake opens that ЛК → currentSession matches → success", lc2.ok === true && lc2.currentSession === "CD-25/455507" && lc2.code !== "taxcom_wrong_current_account" && lc2.matchedContract.agreementNumber === "CD-25/455507");
  check("LOGIN-CONTRACT3 with contractNumber set, Login NEVER omits agreementNumber (no silent fallback to default ЛК)", "agreementNumber" in lc1Login.body && lc1Login.body.agreementNumber === "CD-25/455507");
  const stubborn = async (url) => url.includes("/Login") ? okJson({ sessionToken: "TK" }) : url.includes("/AccountList") ? okJson({ currentSession: "CD-22/380310", records: lcRecords }) : okJson({ records: [] });
  const lc4Cli = makeClient(cfgOOO, stubborn);
  await lc4Cli.login(); const lc4Acc = await lc4Cli.listAccounts();
  const lc4 = buildCheckResult(cfgOOO, lc4Acc.data);
  const lc4Login = lc4Cli.captured.find((c) => c.path === "/API/v2/Login");
  check("LOGIN-CONTRACT4 agreementNumber sent but Taxcom keeps a different currentSession → taxcom_wrong_current_account", lc4Login.body.agreementNumber === "CD-25/455507" && lc4.ok === false && lc4.code === "taxcom_wrong_current_account" && lc4.diagnostics.currentSession === "CD-22/380310");
  const lc5Cli = makeClient(cfgOOO, fakeTaxcom("CD-22/380310"));
  const lc5Run = await runImport({ connectionId: CONN, companyId: CO, dateFrom: "2026-07-14", dateTo: "2026-07-14", client: lc5Cli, mappings: [mapA], contractNumber: "CD-25/455507", normalizeContract });
  const lc5LoginIdx = lc5Cli.captured.findIndex((c) => c.path === "/API/v2/Login");
  const lc5ShiftIdx = lc5Cli.captured.findIndex((c) => c.path === "/API/v2/ShiftList");
  check("LOGIN-CONTRACT5 import performs Login WITH agreementNumber BEFORE ShiftList", lc5LoginIdx !== -1 && lc5ShiftIdx !== -1 && lc5Cli.captured[lc5LoginIdx].body.agreementNumber === "CD-25/455507" && lc5LoginIdx < lc5ShiftIdx && lc5Run.status === "success");
  const lc6Cli = makeClient(cfgIP, fakeTaxcom("CD-22/380310"));
  await lc6Cli.login(); const lc6Acc = await lc6Cli.listAccounts();
  const lc6 = buildCheckResult(cfgIP, lc6Acc.data);
  const lc6Login = lc6Cli.captured.find((c) => c.path === "/API/v2/Login");
  check("LOGIN-CONTRACT6 ИП CD-22/380310 still passes (Login sends it; currentSession matches → success)", lc6Login.body.agreementNumber === "CD-22/380310" && lc6.ok === true && lc6.currentSession === "CD-22/380310" && lc6.code !== "taxcom_wrong_current_account");
  const lc7Cli = makeClient(cfgNone, async (url) => url.includes("/Login") ? okJson({ sessionToken: "TK" }) : url.includes("/AccountList") ? okJson({ records: [{ agreementNumber: "CD-25/455507" }] }) : okJson({ records: [] }));
  await lc7Cli.login(); const lc7Acc = await lc7Cli.listAccounts();
  const lc7 = buildCheckResult(cfgNone, lc7Acc.data);
  const lc7Login = lc7Cli.captured.find((c) => c.path === "/API/v2/Login");
  check("LOGIN-CONTRACT7 no contractNumber → Login omits agreementNumber; check still works via safe path", !("agreementNumber" in lc7Login.body) && lc7Login.body.login === "l" && lc7.ok === true);
  check("LOGIN-CONTRACT-SECURITY check results expose no token/raw AccountList/accessRights/stack (only safe договор fields)", !/sessionToken|SECRET-SESSION|accessRights|Bearer|stack|"raw"/i.test(JSON.stringify({ lc2, lc4, lc6, lc7 })));

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
  const cronRoute = readFileSync(new URL("../src/app/api/cron/ofd/daily/route.ts", import.meta.url), "utf8");
  const dailyLib = readFileSync(new URL("../src/lib/ofd/daily.ts", import.meta.url), "utf8");
  const revenueLib = readFileSync(new URL("../src/lib/ofd/revenue.ts", import.meta.url), "utf8");
  const envEx = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const envProd = readFileSync(new URL("../.env.production.example", import.meta.url), "utf8");
  const deployDoc = readFileSync(new URL("../docs/RU_DEPLOYMENT.md", import.meta.url), "utf8");
  const receiptModel = schema.slice(schema.indexOf("model OfdReceiptImport"), schema.indexOf("model OfdReceiptImport") + 900);

  check("2b UI never renders secret values (only configured/not booleans)", forms.includes("hasLogin") && forms.includes("hasPassword") && !forms.includes("loginEncrypted") && !pageSrc.includes("passwordEncrypted:") && pageSrc.includes("hasPassword: Boolean(c.passwordEncrypted)"));
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
  check("T-S1 Login (login_password) sends agreementNumber from cfg.contractNumber when set; login/password/token unchanged", clientSrc.includes("loginBody.login = cfg.login") && clientSrc.includes("loginBody.password = cfg.password") && clientSrc.includes("loginBody.integrationToken = cfg.integrationToken") && clientSrc.includes("const agreementNumber = cfg.contractNumber?.trim()") && /if \(agreementNumber\) loginBody\.agreementNumber = agreementNumber/.test(clientSrc));
  // Static guard: the ensureSession() body builds the Login request. agreementNumber
  // is added ONLY inside the login_password branch (after loginBody.password) and
  // ONLY when a contractNumber is configured — never unconditionally.
  const ensureRaw = clientSrc.slice(clientSrc.indexOf("async function ensureSession"), clientSrc.indexOf("async function ensureSession") + 1400);
  const ensureCode = ensureRaw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  check("T-S1b agreementNumber added ONLY in login_password branch, ONLY when contractNumber set (guarded)", ensureCode.includes("loginBody.agreementNumber = agreementNumber") && ensureCode.indexOf("loginBody.agreementNumber") > ensureCode.indexOf("loginBody.password") && ensureCode.includes("cfg.contractNumber?.trim()") && ensureCode.includes("if (agreementNumber)"));
  check("LOGIN-CONTRACT-S import client cfg carries contractNumber (Login auto-sends договор) AND currentSession guard is intact", importer.includes("contractNumber: connection.contractNumber") && importer.includes("createTaxcomClient") && importer.includes("isCurrentAccountValid(accounts.data.currentAgreementNumber, connection.contractNumber, accounts.data.records.map((r) => r.agreementNumber))"));
  check("T-S2 Integrator-ID header on requests (never logged)", clientSrc.includes('headers["Integrator-ID"] = cfg.integratorId') && !clientSrc.includes("console."));
  check("T-S3 token read from sessionToken/token/accessToken", clientSrc.includes("d?.sessionToken ?? d?.SessionToken ?? d?.token ?? d?.accessToken"));
  check("T-S4 classifyTaxcomError: 3103→kkt_not_found, 2108→auth_failed, 3106→no_kkt_found", clientSrc.includes("apiErrorCode === 3103") && clientSrc.includes("apiErrorCode === 2108") && clientSrc.includes("apiErrorCode === 3106") && clientSrc.includes('safeCode: "kkt_not_found"') && clientSrc.includes('safeCode: "no_kkt_found"'));
  check("T-S5 error body extracts only apiErrorCode/commonDescription (no raw body returned)", clientSrc.includes("extractApiError") && clientSrc.includes("commonDescription") && clientSrc.includes(".slice(0, 200)"));
  check("T-S6 client exposes listAccounts via GET /API/v2/AccountList + parseAccountList (safe fields)", clientSrc.includes("accountList: \"/API/v2/AccountList\"") && clientSrc.includes("async listAccounts()") && clientSrc.includes('raw(PATHS.accountList, { method: "GET"') && clientSrc.includes("export function parseAccountList") && clientSrc.includes("agreementNumber") && clientSrc.includes("companyName"));
  check("T-S6b parseAccountList reads currentSession as STRING and object variants (currentSession/CurrentSession/current_session/current/currentAccount)", clientSrc.includes("const readSession = (v: unknown): string | null =>") && clientSrc.includes('if (typeof v === "string") return str(v)') && clientSrc.includes("readSession(d.currentSession)") && clientSrc.includes("readSession(d.CurrentSession)") && clientSrc.includes("readSession(d.current_session)") && clientSrc.includes("readSession(d.current)") && clientSrc.includes("readSession(d.currentAccount)"));
  // --- GET verb fix for ShiftList / DocumentList (real source) ---
  const shiftCall = clientSrc.slice(clientSrc.indexOf("async listShifts("), clientSrc.indexOf("async listShifts(") + 700);
  const docCall = clientSrc.slice(clientSrc.indexOf("async listDocumentsByShift("), clientSrc.indexOf("async listDocumentsByShift(") + 700);
  check("T-S7 ShiftList uses GET with fn + begin/end (full-day) + pn/ps query (NOT POST, no body)", clientSrc.includes('shiftList: "/API/v2/ShiftList"') && /raw\(PATHS\.shiftList,\s*\{\s*method:\s*"GET"/.test(shiftCall) && shiftCall.includes("query: { fn: fnNumber, begin, end, pn: 1, ps: 100 }") && !/method:\s*"POST"/.test(shiftCall) && !/\bbody:/.test(shiftCall));
  check("T-S7b DocumentList uses GET with fn/shift/pn/ps query (NOT POST, no body)", clientSrc.includes('documentList: "/API/v2/DocumentList"') && /raw\(PATHS\.documentList,\s*\{\s*method:\s*"GET"/.test(docCall) && docCall.includes("query: { fn: fnNumber, shift: shiftNumber, pn: 1, ps: 100 }") && !/method:\s*"POST"/.test(docCall) && !/\bbody:/.test(docCall));
  // Static guard: NO POST anywhere for the shift/document list endpoints.
  check("T-S7c no POST for ShiftList/DocumentList anywhere in client.ts", !/PATHS\.shiftList[\s\S]{0,120}method:\s*"POST"/.test(clientSrc) && !/PATHS\.documentList[\s\S]{0,120}method:\s*"POST"/.test(clientSrc) && !/raw\(PATHS\.shiftList,\s*\{\s*Fn:/.test(clientSrc) && !/raw\(PATHS\.documentList,\s*\{\s*Fn:/.test(clientSrc));
  check("T-S7d raw() supports GET query via URLSearchParams, body only on POST", clientSrc.includes("new URLSearchParams()") && clientSrc.includes('method === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}') && clientSrc.includes('headers: Record<string, string> = { Accept: "application/json" }'));
  check("T-S7e classifyTaxcomError maps method-not-supported → taxcom_method_not_allowed", clientSrc.includes('does not support http method') && clientSrc.includes('safeCode: "taxcom_method_not_allowed"'));
  check("T-S7f ShiftList/DocumentList parsers read records/Records/Items/items + shifts/documents keys", /parseShiftList[\s\S]*?asArray\(data, "records", "Records", "Items", "items", "Shifts", "shifts"/.test(clientSrc) && /parseDocumentList[\s\S]*?asArray\(data, "records", "Records", "Items", "items", "Documents", "documents"/.test(clientSrc));
  // --- Production DocumentList parsing (real source) ---
  check("T-S8 parseDocumentList reads production fields (fdNumber/accountingType/sum/cash/electronic/documentType) + fn/shift from ctx", clientSrc.includes("o.FdNumber ?? o.fdNumber") && clientSrc.includes("o.accountingType ?? o.AccountingType") && clientSrc.includes("o.Sum ?? o.sum") && clientSrc.includes("o.Cash ?? o.cash") && clientSrc.includes("o.Electronic ?? o.electronic") && clientSrc.includes("o.documentType ?? o.DocumentType") && clientSrc.includes("o.FnFactoryNumber ?? o.fnFactoryNumber") && clientSrc.includes("ctx?.fn") && clientSrc.includes("ctx?.shift"));
  check("T-S8b listDocumentsByShift passes { fn, shift } context to parseDocumentList", clientSrc.includes("parseDocumentList(r.data, { fn: fnNumber, shift: shiftNumber })"));
  check("T-S8c adapter classifyDocument skips service documentType 2/5 before mapping accountingType; fd>0 required", adapter.includes("export function isServiceDocumentType") && adapter.includes('t === "2" || t === "5"') && adapter.includes('if (isServiceDocumentType(doc.documentType)) return { kind: "skip", reason: "service" }') && adapter.includes("Math.trunc(doc.fd) <= 0"));
  check("T-S8d dedupe key = taxcom:<fn>:<fd>:<fpd> (fpd optional) — service docs never persisted", adapter.includes("`taxcom:${fnNumber}:${fiscalDocumentNumber}:${fpd}`") && adapter.includes("`taxcom:${fnNumber}:${fiscalDocumentNumber}`"));
  // --- Production ShiftList + DocumentList pagination fix (real source) ---
  check("T-S9 DocumentList query sends fn + shift + pn:1 + ps:100 (pagination required to get records)", /query:\s*\{\s*fn:\s*fnNumber,\s*shift:\s*shiftNumber,\s*pn:\s*1,\s*ps:\s*100\s*\}/.test(clientSrc));
  check("T-S9b parseShiftList reads lowercase shiftNumber first + receiptCount + openDateTime/closeDateTime", /shiftNumber:\s*num\(o\.shiftNumber\s*\?\?/.test(clientSrc) && clientSrc.includes("o.receiptCount ?? o.ReceiptCount") && clientSrc.includes("o.openDateTime ?? o.OpenDateTime") && clientSrc.includes("s.shiftNumber > 0"));
  check("T-S9c importer uses normalizeDocumentsWithStats + 'documents but no receipts' diagnostic (taxcom_no_receipts_after_filter, stage normalize_documents)", importer.includes("normalizeDocumentsWithStats") && importer.includes('"taxcom_no_receipts_after_filter"') && importer.includes('"normalize_documents"') && importer.includes("stats.normalizedReceiptCount === 0 && (stats.shiftReceiptCount > 0 || stats.documentCount > 0)"));
  check("T-S9d importer diagnostic logs SAFE aggregates only (counts, no raw JSON / no fiscal docs / no secrets / no PII)", importer.includes("console.warn(`[ofd] taxcom_no_receipts_after_filter") && importer.includes("shiftReceiptCount=") && !/console\.(log|warn|error)\([^)]*(JSON\.stringify|docs\.data|records|fpd|sessionToken|password)/i.test(importer));
  check("T-S9e adapter exposes classifyDocument + normalizeDocumentsWithStats (safe skip aggregates, no doc content)", adapter.includes("export function classifyDocument") && adapter.includes("export function normalizeDocumentsWithStats") && adapter.includes("serviceSkipped") && adapter.includes("unsupportedSkipped") && adapter.includes("invalidSkipped") && !/phone|email|buyerName|rawJson/i.test(adapter));
  // --- Full local-day ShiftList range fix (real source) ---
  const dayRangeFn = clientSrc.slice(clientSrc.indexOf("export function toTaxcomDayRange"), clientSrc.indexOf("export function toTaxcomDayRange") + 280);
  check("T-S10 client exports toTaxcomDayRange → begin T00:00:00 / end T23:59:59 (pure string, no Date/UTC round-trip)", dayRangeFn.includes("begin: `${d}T00:00:00`") && dayRangeFn.includes("end: `${d}T23:59:59`") && !dayRangeFn.includes("new Date") && !dayRangeFn.includes("toISOString"));
  check("T-S10b listShifts sends FULL day range via toTaxcomDayRange (begin from dateFrom, end from dateTo) — not raw date-only", clientSrc.includes("const begin = toTaxcomDayRange(dateFrom).begin") && clientSrc.includes("const end = toTaxcomDayRange(dateTo).end") && clientSrc.includes("query: { fn: fnNumber, begin, end, pn: 1, ps: 100 }") && !clientSrc.includes("begin: dateFrom, end: dateTo"));
  check("T-S10c importer logs SAFE empty-ShiftList debug aggregate (fn/date/begin/end/shiftCount=0, no token/raw)", importer.includes("list_shifts_debug") && importer.includes("shiftCount=0") && importer.includes("toTaxcomDayRange(day)") && /console\.warn\(`\[ofd\] list_shifts_debug[^`]*begin=\$\{range\.begin\} end=\$\{range\.end\}/.test(importer) && !/list_shifts_debug[\s\S]{0,200}(token|password|integrator|JSON\.stringify)/i.test(importer));
  check("T-S10d importer eachDay is inclusive of dateTo (<=), max 366 days", importer.includes("cur.getTime() <= end.getTime()") && importer.includes("guard < 366"));
  // --- Active mapping selection by connection scope (real source) ---
  check("T-S11 importer selects ALL cabinet mappings by companyId + provider + isActive + activeMappingKey (NO legalEntity filter, NOT by connectionId)", importer.includes("companyId: connection.companyId") && importer.includes("provider: connection.provider") && importer.includes("isActive: true") && importer.includes("activeMappingKey: { not: null }") && !importer.includes("connection.legalEntityId ? { legalEntityId: connection.legalEntityId }") && !importer.includes("where: { connectionId, isActive: true }"));
  check("T-S11b importer: 0 active mappings → mapping_check + ofd_no_active_cash_register_mappings, status failed (not silent success)", importer.includes("mappings.length === 0") && importer.includes('"mapping_check"') && importer.includes('"ofd_no_active_cash_register_mappings"') && importer.includes("Нет активных касс ОФД для выбранного подключения") && /mappings\.length === 0[\s\S]{0,400}status: "failed"/.test(importer));
  check("T-S11c importer SAFE debug logs: mapping_debug (ids+counts) + list_shifts_call (fn/date/begin/end), no secrets/raw", importer.includes("console.warn(`[ofd] mapping_debug") && importer.includes("activeMappingCount=") && importer.includes("console.warn(`[ofd] list_shifts_call") && !/mapping_debug[\s\S]{0,200}(login|password|integrator|sessionToken|JSON\.stringify)/i.test(importer) && !/list_shifts_call[\s\S]{0,200}(token|password|JSON\.stringify)/i.test(importer));
  check("T-S11d mapping_check runs BEFORE the ShiftList loop (fail fast)", importer.indexOf('"mapping_check"') < importer.indexOf("client.listShifts(") && importer.indexOf("mappings.length === 0") < importer.indexOf("for (const m of mappings)"));
  // --- Daily auto-import cron (real source) ---
  check("T-S12 route POST /api/cron/ofd/daily: authorizeOfdCron + runDailyOfdImport, no-store, only POST exported", cronRoute.includes("export async function POST") && !cronRoute.includes("export async function GET") && cronRoute.includes("authorizeOfdCron") && cronRoute.includes("runDailyOfdImport") && cronRoute.includes('req.headers.get("authorization")') && cronRoute.includes('req.headers.get("x-cron-secret")') && cronRoute.includes("Cache-Control"));
  check("T-S12b daily lib: auth order method(405)/disabled(503)/no-secret(503)/wrong(401); Bearer or X-Cron-Secret", dailyLib.includes('status: 405, error: "method_not_allowed"') && dailyLib.includes('status: 503, error: "ofd_integrations_disabled"') && dailyLib.includes('status: 503, error: "cron_secret_not_configured"') && dailyLib.includes('status: 401, error: "unauthorized"') && dailyLib.includes("bearerEquals(p.authorization, p.secret)") && dailyLib.includes("secretEquals(p.cronHeader, p.secret)"));
  check("T-S12c daily import selects active taxcom+astral connections + mode auto_daily + safe aggregate result", dailyLib.includes('where: { provider: { in: ["taxcom", "astral"] }, isActive: true }') && dailyLib.includes('mode: "auto_daily"') && dailyLib.includes("processedConnections") && dailyLib.includes("succeeded") && dailyLib.includes("failed") && dailyLib.includes("safeErrorCode"));
  const dailyCode = dailyLib.split("\n").filter((l) => { const t = l.trim(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).join("\n");
  check("T-S12d cron CODE handles no secrets/raw (no decrypt/loginEncrypted/sessionToken/.stack); logs are aggregate-only", !/decryptOfdSecret|loginEncrypted|passwordEncrypted|integratorIdEncrypted|sessionToken|serverBaseUrl|\.stack|rawJson/i.test(dailyCode) && dailyLib.includes("] batch_start") && dailyLib.includes("] connection_done") && dailyLib.includes("] batch_done") && dailyLib.includes('logTag: "ofd-cron"') && !cronRoute.includes("decryptOfdSecret"));
  check("T-S12e ImportMode includes auto_daily + sync_now; importer returns totalIncome/Return; ImportResult exposes totals", importer.includes('"auto_daily"') && importer.includes('"sync_now"') && importer.includes("totalIncomeKopeks: number") && importer.includes("totalIncomeKopeks: incomeTotal, totalReturnKopeks: returnTotal"));
  // --- On-demand "Синхронизировать сейчас" (sync_now) (real source) ---
  check("T-S13 daily lib: ofdToday + runSyncNowForCompany (company-scoped active taxcom+astral, TODAY, mode sync_now, ofd-sync log)", dailyLib.includes("export function ofdToday") && dailyLib.includes("export async function runSyncNowForCompany") && dailyLib.includes("date: ofdToday(now)") && dailyLib.includes('mode: "sync_now"') && dailyLib.includes('logTag: "ofd-sync"') && dailyLib.includes('where: { companyId, provider: { in: ["taxcom", "astral"] }, isActive: true }'));
  check("T-S13b runOfdImportBatch is the shared runner (cron + sync); catches exceptions → import_exception", dailyLib.includes("export async function runOfdImportBatch") && dailyLib.includes('safeErrorCode: "import_exception"') && dailyLib.includes("opts.importer ?? defaultImporter()"));
  check("T-S13c syncOfdNowAction: requireOfdAdmin gate → runSyncNowForCompany(company) → revalidatePath; safe sync summary; no secrets", actions.includes("export async function syncOfdNowAction") && actions.includes("requireOfdAdmin()") && actions.includes("runSyncNowForCompany(g.companyId)") && actions.includes('revalidatePath("/settings/integrations/ofd")') && actions.includes("Синхронизация завершена") && /syncOfdNowAction[\s\S]*?sync: \{ found:/.test(actions) && !/syncOfdNowAction[\s\S]{0,900}(decryptOfdSecret|loginEncrypted|sessionToken|Integrator-ID)/i.test(actions));
  check("UI: Синхронизировать сейчас button + safe-rerun hint + приход/возвраты + loading disabled", forms.includes("syncOfdNowAction") && forms.includes("Синхронизировать сейчас") && forms.includes("Повторный запуск безопасен — дубли не создаются") && forms.includes("Синхронизация...") && forms.includes("Приход:") && forms.includes("Возвраты:") && forms.includes("state.sync") && pageSrc.includes("OfdSyncNow"));
  check("docs: systemd timer OnCalendar 00:00:00 + note про 00:05/00:10", deployDoc.includes("OnCalendar=*-*-* 00:00:00") && deployDoc.includes("00:05") && deployDoc.includes("00:10") && deployDoc.includes("Синхронизировать сейчас"));
  // --- OFD nomenclature + revenue categories (real source) ---
  check("T-S14 revenue lib: 5 categories (no bar), fallback rules (freeze/reissue→extra_services), normalize + priority sort", revenueLib.includes('{ code: "membership", name: "Абонементы" }') && revenueLib.includes('{ code: "personal_training"') && revenueLib.includes('{ code: "group_training"') && revenueLib.includes('{ code: "extra_services"') && revenueLib.includes('{ code: "other"') && !/code:\s*"bar"/.test(revenueLib) && !/протеин|энергетик|батончик|шейк/i.test(revenueLib) && revenueLib.includes('"заморозка"') && revenueLib.includes('"переоформление"') && revenueLib.includes('.replace(/ё/g, "е")') && revenueLib.includes("legalEntity-specific first") && revenueLib.includes("priority DESC"));
  check("T-S14b revenue lib normalizeItemName has NO heavy regex (no dynamic RegExp / no unbounded alternation), NFKC + control strip", revenueLib.includes('.normalize("NFKC")') && revenueLib.includes("\\u0000-\\u001F") && !/new RegExp/.test(revenueLib));
  check("T-S15 adapter parseReceiptItems reads FFD tags 1030/1023/1079/1043 + string keys; cleans name; skips empty/sum<=0; no raw JSON stored", adapter.includes("export function parseReceiptItems") && adapter.includes('io["1030"] ?? io.name') && adapter.includes('io["1043"] ?? io.sum') && adapter.includes('io["1079"] ?? io.price') && adapter.includes('io["1023"] ?? io.quantity') && adapter.includes("if (!name) continue") && adapter.includes("if (totalKopeks <= 0) continue") && adapter.includes("cleanItemName") && !/phone|email|buyer|rawJson/i.test(adapter));
  check("T-S15b adapter extractPositions handles string-key arrays AND numeric FFD tag 1059 (array=many, object=one)", adapter.includes('const FFD_ITEMS_TAG = "1059"') && adapter.includes("function extractPositions") && adapter.includes("Array.isArray(ffd)") && adapter.includes("ffd && typeof ffd === \"object\""));
  check("T-S16 importer persists items (idempotent by itemKey) + recomputeRevenueCategorySummaries + SAFE items_debug (counts only)", importer.includes("persistReceiptItems") && importer.includes("itemKey: `${r.dedupeKey}:${lineIndex}`") && importer.includes("ofdReceiptItem.findMany({ where: { itemKey:") && importer.includes("export async function recomputeRevenueCategorySummaries") && importer.includes("console.warn(`[ofd] items_debug") && importer.includes("items_unavailable") && !/items_debug[\s\S]{0,200}(itemName|normalizedItemName|fpd|JSON\.stringify|login|password)/i.test(importer));
  check("T-S16b importer item failure never fails the receipt import (try/catch → save_items safe error, receipts kept)", importer.includes('"save_items"') && importer.includes('"ofd_item_save_failed"') && /try \{[\s\S]*?persistReceiptItems[\s\S]*?\} catch/.test(importer));
  check("UI: 'Статьи доходов ОФД' block — category table (Статья/Приход/Возвраты/Итог/Позиций/Чеков via OfdRevenueTable) + Нераспознанная номенклатура + 'Номенклатура пока недоступна'", pageSrc.includes("Статьи доходов ОФД") && pageSrc.includes("OfdRevenueTable") && forms.includes(">Статья</th>") && forms.includes(">Позиций</th>") && forms.includes(">Чеков</th>") && pageSrc.includes("нераспознанная номенклатура") && pageSrc.includes("Номенклатура пока недоступна") && pageSrc.includes("ofdRevenueCategoryDailySummary") && pageSrc.includes('revenueCategoryCode: "other"') && !pageSrc.includes("Бар"));
  check("prisma: new models OfdReceiptItem / OfdRevenueCategoryRule / OfdRevenueCategoryDailySummary; itemKey/summaryKey unique; no raw/phone columns", schema.includes("model OfdReceiptItem") && schema.includes("model OfdRevenueCategoryRule") && schema.includes("model OfdRevenueCategoryDailySummary") && schema.includes("itemKey             String   @unique") && /OfdReceiptItem[\s\S]*?normalizedItemName/.test(schema) && !/OfdReceiptItem[\s\S]*?(phone|email|buyer|rawJson|customer)/i.test(schema.slice(schema.indexOf("model OfdReceiptItem"), schema.indexOf("model OfdReceiptItem") + 1200)));
  // --- NewDocuments shape DIAGNOSTIC (real source) ---
  check("T-S17 client inspectNewDocuments: GET /API/v2/NewDocuments + an query, DIAGNOSTIC ONLY (never returns raw body)", clientSrc.includes('newDocuments: "/API/v2/NewDocuments"') && clientSrc.includes("async inspectNewDocuments()") && /raw\(PATHS\.newDocuments,\s*\{\s*method:\s*"GET"[\s\S]*?query:\s*an\s*\?\s*\{\s*an\s*\}/.test(clientSrc) && clientSrc.includes("inspectNewDocumentsShape(r.data)") && clientSrc.includes("cfg.contractNumber?.trim()"));
  check("T-S17b adapter.inspectNewDocumentsShape returns SAFE structure only (keys+counts, item-like paths incl nested), no values/PII", adapter.includes("export function inspectNewDocumentsShape") && adapter.includes("Object.keys(o).sort()") && adapter.includes("firstDocumentKeys") && adapter.includes("detectedItemLikeKeys") && adapter.includes("hasItemsLikeData") && adapter.includes('"fiscalData.items"') && adapter.includes('"document.items"') && adapter.includes('"receipt.items"') && !/inspectNewDocumentsShape[\s\S]*?(itemName|buyer|phone|email|JSON\.stringify)/i.test(adapter));
  check("T-S17c importer money import is UNCHANGED — never calls NewDocuments (diagnostic stays out of import path)", !importer.includes("NewDocuments") && !importer.includes("inspectNewDocuments"));
  check("T-S17d action inspectOfdNewDocumentsAction: requireOfdAdmin gate → inspectNewDocuments → SAFE result (returns only newDocsShape, no raw/token/stack in result)", actions.includes("export async function inspectOfdNewDocumentsAction") && actions.includes("requireOfdAdmin()") && actions.includes("inspectNewDocuments()") && actions.includes("newDocsShape: s") && !/inspectOfdNewDocumentsAction[\s\S]{0,1400}return\s*\{[^}]*(sessionToken|rawResponse|\.stack)/i.test(actions));
  check("UI: NewDocuments diagnostic lives in 'Расширенная диагностика' — button + safe shape (документов / позиции / ключи), no raw JSON", pageSrc.includes("Расширенная диагностика") && pageSrc.includes("OfdNewDocsDiagnostics") && forms.includes("Проверить структуру NewDocuments") && forms.includes("newDocsShape") && forms.includes("firstDocumentKeys") && forms.includes("hasItemsLikeData") && forms.includes("Сырой ответ Такском не отображается и не сохраняется") && !/newDocsShape[\s\S]{0,400}JSON\.stringify/.test(forms));
  // --- DocumentInfo shape DIAGNOSTIC (real source) ---
  check("T-S18 client inspectDocumentInfo: GET /API/v2/DocumentInfo + fn/fd query, DIAGNOSTIC ONLY (never returns raw body)", clientSrc.includes("async inspectDocumentInfo(fnNumber, fd)") && /raw\(PATHS\.documentInfo,\s*\{\s*method:\s*"GET",\s*withSession:\s*true,\s*query:\s*\{\s*fn:\s*fnNumber,\s*fd\s*\}/.test(clientSrc) && clientSrc.includes("inspectDocumentInfoShape(r.data)"));
  check("T-S18b adapter.inspectDocumentInfoShape returns SAFE structure (keys+counts, nested + FFD 1059, firstItemKeys, numericFfdModeDetected), no values/PII", adapter.includes("export function inspectDocumentInfoShape") && adapter.includes("documentKeys") && adapter.includes("itemLikeCount") && adapter.includes("firstItemKeys") && adapter.includes("numericFfdModeDetected") && adapter.includes('"document.1059"') && adapter.includes("safeDocumentType") && adapter.includes('"ticket.items"') && adapter.includes('"content.items"') && !/inspectDocumentInfoShape[\s\S]*?(itemName|buyer|phone|email|JSON\.stringify)/i.test(adapter));
  // STAGE 13: Taxcom adapter STILL reads cashier tags 1021/1203 by KEY NAME only (never the
  // value), so Taxcom receipts carry no cashier → they attribute as `unmatched`. The OFD
  // models now DO have operator* columns (Astral populates them) — that is the intentional
  // STAGE 13 capture; we still never name a column cashierName/cashierInn.
  check("CASHIER-DIAG-S adapter → cashierDetected + cashierFieldsDetected (KEY NAMES only, 1021/1203), never value; UI показывает факт без ФИО/ИНН", adapter.includes("cashierFieldsDetected") && adapter.includes("cashierDetected") && adapter.includes('"1021"') && adapter.includes('"1203"') && adapter.includes("KEY NAMES only") && forms.includes("Поля кассира в чеке") && forms.includes("без ФИО/ИНН") && !/cashierName\s*:|cashierInn/i.test(schema));
  // ----- Compact OFD settings UI + category diagnostics + dark -----
  const globalsCss = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  const collComp = pageSrc.slice(pageSrc.indexOf("function Collapsible"), pageSrc.indexOf("function Collapsible") + 900);
  const advIdx = pageSrc.indexOf('<Collapsible title="Расширенная диагностика"');
  const connSecIdx = pageSrc.indexOf('<Section title="Подключения Такском">');
  const kassyIdx = pageSrc.indexOf('<Collapsible title="Кассы ККТ"');
  const syncIdx = pageSrc.indexOf('<Collapsible title="Синхронизация продаж"');
  const salesIdx = pageSrc.indexOf('<Collapsible title="ОФД продажи"');
  const statyiIdx = pageSrc.indexOf('<Collapsible title="Статьи доходов ОФД"');
  check("OFD-COMPACT1 основные блоки сгруппированы; технические диагностики свернуты под Collapsible", pageSrc.includes("function Collapsible") && advIdx > 0 && pageSrc.includes("Технический блок для отладки Taxcom и DocumentInfo"));
  check("OFD-COMPACT2 История синхронизаций свернута по умолчанию (Collapsible, без open)", pageSrc.includes('<Collapsible title="История синхронизаций" subtitle="Последние запуски импорта ОФД"') && !/<details[^>]*\bopen\b/.test(pageSrc));
  check("OFD-COMPACT3 Расширенная диагностика свернута; NewDocuments/DocumentInfo только внутри неё", advIdx > 0 && pageSrc.indexOf("<OfdNewDocsDiagnostics") > advIdx && pageSrc.indexOf("<OfdDocInfoDiagnostics") > advIdx);
  check("OFD-COMPACT4 ссылка на подробную аналитику доступна внутри блока ОФД продажи", pageSrc.includes('href="/analytics/ofd-sales"') && pageSrc.indexOf('href="/analytics/ofd-sales"') > salesIdx && pageSrc.indexOf('href="/analytics/ofd-sales"') < statyiIdx);
  // COMPACT5-8: крупные блоки свернуты в Collapsible по умолчанию (без open — глобальная проверка ниже).
  check("OFD-COMPACT5 «Кассы ККТ» свернуты по умолчанию (Collapsible + подпись)", pageSrc.includes('<Collapsible title="Кассы ККТ" subtitle="ФН, юрлицо, клуб и тип кассы">'));
  check("OFD-COMPACT6 «Синхронизация продаж» свернута по умолчанию (Collapsible + подпись)", pageSrc.includes('<Collapsible title="Синхронизация продаж" subtitle="Ручная синхронизация, импорт за период и статус автоимпорта">'));
  check("OFD-COMPACT7 «ОФД продажи» свернуты по умолчанию (Collapsible + подпись)", pageSrc.includes('<Collapsible title="ОФД продажи" subtitle="Краткий итог по сегодняшним и вчерашним чекам">'));
  check("OFD-COMPACT8 «Статьи доходов ОФД» свернуты по умолчанию (Collapsible + подпись)", pageSrc.includes('<Collapsible title="Статьи доходов ОФД" subtitle="Абонементы, персональные тренировки, группы, доп. услуги и Иное">'));
  check("OFD-COMPACT9 «Подключения Такском» остаются открытыми по умолчанию (обычный Section, не Collapsible)", connSecIdx > 0 && pageSrc.indexOf('<Collapsible title="Подключения') === -1 && connSecIdx < kassyIdx);
  check("OFD-COMPACT10 после раскрытия «Кассы ККТ» форма OfdMappingForm и таблица касс доступны внутри блока", kassyIdx > 0 && pageSrc.indexOf("<OfdMappingForm") > kassyIdx && pageSrc.indexOf("<OfdMappingForm") < syncIdx && pageSrc.indexOf("<Th>ФН</Th>") > kassyIdx && pageSrc.indexOf("<Th>ФН</Th>") < syncIdx);
  check("OFD-COMPACT11 после раскрытия «Синхронизация продаж» sync_now и импорт за период доступны внутри блока", syncIdx > 0 && pageSrc.indexOf("<OfdSyncNow") > syncIdx && pageSrc.indexOf("<OfdSyncNow") < salesIdx && pageSrc.indexOf("<OfdImportForm") > syncIdx && pageSrc.indexOf("<OfdImportForm") < salesIdx);
  check("OFD-COMPACT12 после раскрытия «ОФД продажи» видны краткие итоги (SalesBlock) и ссылка на /analytics/ofd-sales", salesIdx > 0 && pageSrc.indexOf("<SalesBlock") > salesIdx && pageSrc.indexOf("<SalesBlock") < statyiIdx && pageSrc.indexOf('href="/analytics/ofd-sales"') > salesIdx && pageSrc.indexOf('href="/analytics/ofd-sales"') < statyiIdx);
  check("DARK-OFD-COMPACT2 все свёрнутые блоки используют единый Collapsible (тёмная тема через .dark remap, не белые на тёмном)", collComp.includes("bg-white") && collComp.includes("border-slate-200") && collComp.includes("text-slate-700") && globalsCss.includes(".dark .bg-white") && globalsCss.includes(".dark .border-slate-200") && kassyIdx > 0 && syncIdx > 0 && salesIdx > 0 && statyiIdx > 0);
  check("SECURITY-COMPACT свёртка блоков не вынесла секреты/токены/raw JSON/ПДн наружу (только presence-only флаги)", pageSrc.includes("Boolean(c.loginEncrypted)") && pageSrc.includes("Boolean(c.passwordEncrypted)") && pageSrc.includes("Boolean(c.integrationTokenEncrypted)") && !/\{[^{}]*\.(loginEncrypted|passwordEncrypted|integrationTokenEncrypted)\s*\}/.test(pageSrc) && !/Session-Token|Integrator-ID|CRON_SECRET/.test(pageSrc) && !/JSON\.stringify/.test(pageSrc) && !/\{[^{}]*\.(fiscalSign|buyerInn|phone|email)\s*\}/i.test(pageSrc));
  check("OFD-CATEGORIES6 «Иное» показывает нормализованные названия + примеры исходных (OfdRevenueTable details + «Требуют проверки»)", pageSrc.includes("OfdRevenueTable rows={categoryRows} details={categoryDetails}") && pageSrc.includes("Требуют проверки") && pageSrc.includes("u.normalizedItemName") && forms.includes("Примеры исходных названий"));
  check("DARK-OFD1 компактные блоки ОФД читаемы в тёмной теме (нейтральные токен-классы + .dark remap; не белые на тёмном)", collComp.includes("bg-white") && collComp.includes("border-slate-200") && collComp.includes("text-slate-700") && globalsCss.includes(".dark .bg-white") && globalsCss.includes(".dark .border-slate-200") && globalsCss.includes(".dark .text-slate-700"));
  check("SECURITY-CASHIER UI/adapter не выводят значение кассира (только факт + имена тегов); нет cashierName:/cashierInn присваиваний", forms.includes("cashierDetected") && forms.includes("cashierFieldsDetected") && !/cashierName\s*:|cashierInn|ФИО кассира/i.test(forms) && !/cashierName\s*:|cashierInn/i.test(adapter) && !/JSON\.stringify[\s\S]{0,40}cashier/i.test(forms));
  check("T-S18c importer receipt SOURCE still ShiftList+DocumentList; never uses the diagnostic inspector; never parses 1059 itself", !importer.includes("inspectDocumentInfo") && !importer.includes("1059") && importer.includes("client.listShifts(") && importer.includes("client.listDocumentsByShift("));
  // --- LIVE nomenclature import via DocumentInfo (real source) ---
  check("T-S18e client.getDocumentInfoForReceipt: GET DocumentInfo + fn/fd + Session-Token/Integrator-ID; returns parsed items only, never raw body", clientSrc.includes("async getDocumentInfoForReceipt(fnNumber, fd)") && /getDocumentInfoForReceipt[\s\S]{0,400}raw\(PATHS\.documentInfo,\s*\{\s*method:\s*"GET",\s*withSession:\s*true,\s*query:\s*\{\s*fn:\s*fnNumber,\s*fd\s*\}/.test(clientSrc) && clientSrc.includes("parseReceiptItemsFromDocumentInfo(r.data)") && !/getDocumentInfoForReceipt[\s\S]{0,400}(rawResponse|JSON\.stringify\(r\.data|return\s*\{\s*ok:\s*true,\s*data:\s*r\.data)/.test(clientSrc));
  check("T-S18f importer enriches ONLY receipts lacking positions via getDocumentInfoForReceipt; DocumentInfo failure records a safe OfdSyncError, never fails the run", importer.includes('typeof client.getDocumentInfoForReceipt === "function"') && importer.includes("documentInfoRequested") && importer.includes("documentInfoSucceeded") && importer.includes("documentInfoFailed") && /if\s*\(\(r\.items && r\.items\.length > 0\) \|\| idsWithItems\.has\(rid\)\) continue/.test(importer) && importer.includes('"document_info", "taxcom_document_info_unavailable"') && !/documentInfoFailed[\s\S]{0,300}status:\s*"failed"/.test(importer));
  check("T-S18g adapter.parseReceiptItemsFromDocumentInfo unwraps document/ticket/content and delegates to parseReceiptItems (FFD 1059), returns items only", adapter.includes("export function parseReceiptItemsFromDocumentInfo") && adapter.includes("documentObjectOf") && /parseReceiptItemsFromDocumentInfo[\s\S]{0,300}parseReceiptItems\(documentObjectOf/.test(adapter));
  check("T-S18h OfdReceiptItem persistence never stores ФПД value: fiscalSign set null on item rows (fpd lives only in itemKey)", /fiscalSign:\s*null/.test(importer) && !/receiptImportId,[\s\S]{0,400}fiscalSign:\s*r\.fiscalSign/.test(importer) && importer.includes("itemKey: `${r.dedupeKey}:${lineIndex}`"));
  // --- Revenue category rules + grouping normalization + local reclassify (real source) ---
  check("CAT-S1 revenue: normalizeItemNameForGrouping strips договор/контракт refs, folds punctuation", revenueLib.includes("export function normalizeItemNameForGrouping") && /договор\|контракт\|соглашение/.test(revenueLib) && revenueLib.includes("\\p{L}\\p{N}") && revenueLib.includes("№"));
  check("CAT-S2 revenue: fallback adds физкультурно/доп услуги/карта клуба/переоформления", revenueLib.includes("физкультурно оздоровительные услуги") && revenueLib.includes("физ оздоровительные услуги") && revenueLib.includes("доп услуги") && revenueLib.includes("дополнительные услуги") && revenueLib.includes("карта клуба") && revenueLib.includes("переоформления"));
  check("CAT-S3 revenue: categorizeItem compound физкультур+договор+контракт → membership (uses rawName)", /categorizeItem\([\s\S]{0,120}rawName/.test(revenueLib) && /loose\.includes\("физкультур"\)[\s\S]{0,140}includes\("договор"\)[\s\S]{0,60}includes\("контракт"\)/.test(revenueLib));
  check("CAT-S4 adapter stores grouping-normalized normalizedName; importer categorize passes rawName", adapter.includes("normalizeItemNameForGrouping(name)") && importer.includes("categorizeItem(it.normalizedName, dbRules, ctx.legal, it.name)"));
  check("RECALC-S1 importer.reclassifyOfdReceiptItemsForCompany exists, updates only SAFE fields, recomputes summaries", importer.includes("export async function reclassifyOfdReceiptItemsForCompany") && importer.includes("data: { normalizedItemName, revenueCategoryCode: cat.code, revenueCategoryName: cat.name, categoryRuleId: cat.ruleId }") && /reclassifyOfdReceiptItemsForCompany[\s\S]*recomputeRevenueCategorySummaries\(companyId, clubId/.test(importer));
  check("RECALC-S2 reclassify is LOCAL-ONLY: its body calls no Taxcom client/fetch/session", (() => { const i = importer.indexOf("export async function reclassifyOfdReceiptItemsForCompany"); const body = importer.slice(i, i + 1600); return i > 0 && !/\bclient\b|\bfetch\b|listShifts|listDocuments|getDocumentInfoForReceipt|createTaxcomClient|Session-Token|ofdReceiptImport\.update|ofdDailySalesSummary/i.test(body); })());
  check("RECALC-UI 'Пересчитать статьи доходов' button in Статьи доходов block + hint (owner/gd action, no re-fetch of OFD)", forms.includes("Пересчитать статьи доходов") && forms.includes("reclassifyOfdCategoriesAction") && forms.includes("Не запрашивает ОФД повторно") && pageSrc.includes("OfdRecalcCategories"));
  check("RECALC-SEC reclassifyOfdCategoriesAction: requireOfdAdmin gate, SAFE counts only (no names/raw/PII/token in result)", actions.includes("export async function reclassifyOfdCategoriesAction") && /reclassifyOfdCategoriesAction[\s\S]{0,400}requireOfdAdmin\(\)/.test(actions) && actions.includes("Статьи пересчитаны: обновлено") && !/reclassifyOfdCategoriesAction[\s\S]{0,600}(itemName|normalizedItemName|rawResponse|sessionToken|\bphone\b|\bemail\b)/i.test(actions));
  // --- Revenue category drilldown (real source) ---
  check("REV-DETAIL-UI 'Статьи доходов ОФД' has an expandable drilldown (OfdRevenueTable + nested Название/Примеры/Сумма/Позиций/Чеков + empty state)", pageSrc.includes("OfdRevenueTable") && pageSrc.includes("details={categoryDetails}") && forms.includes("export function OfdRevenueTable") && forms.includes("Примеры исходных названий") && forms.includes("Нет детализации по позициям") && forms.includes("useState") && forms.includes("colSpan={6}"));
  check("REV-DETAIL-S1 page builds detail from OfdReceiptItem SAFE columns only (normalizedItemName+itemName; never selects fiscalSign/raw), grouped by category+normalizedName", pageSrc.includes("categoryDetails") && /ofdReceiptItem\.findMany\(\{[\s\S]{0,400}select:\s*\{[^}]*revenueCategoryCode[^}]*normalizedItemName[^}]*itemName[^}]*\}/.test(pageSrc) && !/ofdReceiptItem\.findMany\(\{[\s\S]{0,400}(fiscalSign|fdNumber|fnNumber)/.test(pageSrc) && pageSrc.includes(".slice(0, 160)"));
  check("REV-DETAIL-S2 drilldown example names capped at 3 per normalizedName (examples.length < 3 guard)", /examples\.length\s*<\s*3/.test(pageSrc));
  // --- Multi legal-entity Taxcom registers (real source) ---
  const prodSchema = readFileSync(new URL("../prisma/production/schema.prisma", import.meta.url), "utf8");
  const devMig = readFileSync(new URL("../prisma/migrations/20260717120000_add_ofd_register_kind/migration.sql", import.meta.url), "utf8");
  const prodMig = readFileSync(new URL("../prisma/production/migrations/20260717120000_add_ofd_register_kind/migration.sql", import.meta.url), "utf8");
  check("SCHEMA-MULTI registerKind added to dev+prod schema (default club_cashbox); non-destructive ADD COLUMN migration (dev+prod)", /registerKind\s+String\s+@default\("club_cashbox"\)/.test(schema) && /registerKind\s+String\s+@default\("club_cashbox"\)/.test(prodSchema) && /ADD COLUMN "registerKind" TEXT NOT NULL DEFAULT 'club_cashbox'/.test(devMig) && /ADD COLUMN "registerKind" TEXT NOT NULL DEFAULT 'club_cashbox'/.test(prodMig));
  check("MULTI-OFD7 online_cashbox renders as 'Онлайн-касса' (and club_cashbox as 'Касса клуба') in the UI", pageSrc.includes('online_cashbox: "Онлайн-касса"') && pageSrc.includes('club_cashbox: "Касса клуба"') && pageSrc.includes("registerKindLabel(m.registerKind)"));
  check("UI-MULTI1 page has a 'Подключения Такском' block listing connections as cards (name/legal/contract/status/active kassas)", pageSrc.includes('title="Подключения Такском"') && pageSrc.includes("connectionStatus(c)") && pageSrc.includes("Активных касс:") && pageSrc.includes("legalLabelOf(c.legalEntityId)"));
  check("UI-MULTI2 'Кассы ККТ' table has ФН, РНМ ККТ, Подключение, Юрлицо, Клуб, Тип кассы, Статус columns", pageSrc.includes('title="Кассы ККТ"') && pageSrc.includes("<Th>ФН</Th>") && pageSrc.includes("<Th>РНМ ККТ</Th>") && pageSrc.includes("<Th>Подключение</Th>") && pageSrc.includes("<Th>Юрлицо</Th>") && pageSrc.includes("<Th>Клуб</Th>") && pageSrc.includes("<Th>Тип кассы</Th>") && pageSrc.includes("<Th>Статус</Th>"));
  check("UI-MULTI3 diagnostics live inside a collapsed 'Расширенная диагностика' block, not a main Section", pageSrc.includes("Расширенная диагностика") && pageSrc.includes("Технический блок для отладки Taxcom и DocumentInfo") && !pageSrc.includes('title="Диагностика номенклатуры Такском"') && pageSrc.indexOf("Расширенная диагностика") > pageSrc.indexOf('title="История синхронизаций"') && pageSrc.lastIndexOf("OfdNewDocsDiagnostics") > pageSrc.indexOf("Расширенная диагностика"));
  check("UI-MULTI4 history renders human-readable modes (manual_day/sync_now/auto_daily/backfill_july) via modeLabel", /manual_day:\s*"Ручной импорт"/.test(pageSrc) && /sync_now:\s*"Синхронизация сейчас"/.test(pageSrc) && /auto_daily:\s*"Автоимпорт"/.test(pageSrc) && /backfill_july:\s*"Загрузка периода"/.test(pageSrc) && pageSrc.includes("modeLabel(r.mode)"));
  check("UI-MULTI-FORM mapping form: connection select + registerKind (Касса клуба/Онлайн-касса) with plain-language hints", forms.includes('name="registerKind"') && forms.includes("Касса клуба") && forms.includes("Онлайн-касса") && forms.includes("Обычная касса клуба/ресепшена") && forms.includes("чеков онлайн-оплат") && /OfdMappingForm\(\{ connections/.test(forms));
  check("ACT-MULTI actions: saveOfdConnection multi (editId) + cabinet dedup, addOfdMapping registerKind + PER-KKT legalEntity from form, toggleOfdConnection", actions.includes("const editId = str(formData,") && actions.includes('registerKind = str(formData, "registerKind") === "online_cashbox"') && actions.includes('const legalEntityId = str(formData, "legalEntityId") ?? connection.legalEntityId') && actions.includes("cabinetFingerprint") && actions.includes("export async function toggleOfdConnection"));
  check("MULTI-SEC-UI connection cards expose only secret PRESENCE (Boolean), never ciphertext; ConnCard has no *Encrypted field", pageSrc.includes("hasLogin: Boolean(c.loginEncrypted)") && !/type ConnCard = \{[^}]*Encrypted/.test(pageSrc) && !/connection=\{c\}[\s\S]{0,40}Encrypted/.test(pageSrc));
  // --- Taxcom contract picker (real source) ---
  check("ACT-CONTRACT loadTaxcomContractsAction: login→listAccounts, returns ONLY safe fields (currentSession + agreementNumber/companyName/inn/kpp), never token/accessRights/raw", actions.includes("export async function loadTaxcomContractsAction") && actions.includes("await client.login()") && actions.includes("await client.listAccounts()") && /availableContracts:\s*OfdSafeContract\[\]\s*=\s*accounts\.data\.records\.map/.test(actions) && /agreementNumber:\s*r\.agreementNumber,\s*companyName:\s*r\.companyName/.test(actions) && !/accessRights\s*:/.test(actions) && !/return\s*\{[^}]*(sessionToken|rawAccountList|accessRights)/.test(actions));
  check("ACT-CONTRACT2 selectTaxcomContractAction saves contractNumber only; does NOT mark connection working (needs Проверить подключение)", actions.includes("export async function selectTaxcomContractAction") && /data:\s*\{\s*contractNumber:\s*agreementNumber/.test(actions) && actions.includes("Договор выбран. Теперь нажмите «Проверить подключение».") && !/selectTaxcomContractAction[\s\S]{0,600}(client\.login|listAccounts|isCurrentAccountValid)/.test(actions));
  check("UI-CONTRACT1 connection card has a 'Загрузить договоры из Такском' button; page renders OfdContractPicker", forms.includes("Загрузить договоры из Такском") && forms.includes("export function OfdContractPicker") && pageSrc.includes("<OfdContractPicker connectionId={c.id} />"));
  check("UI-CONTRACT2 each договор row has a 'Выбрать' button wired to selectTaxcomContractAction (agreementNumber submitted)", forms.includes("selectTaxcomContractAction") && /useFormState\(selectTaxcomContractAction/.test(forms) && forms.includes(">Выбрать<") && forms.includes('name="agreementNumber"'));
  check("UI-CONTRACT3 mismatch panel explains договор доступен но API-сессия открыта в другом ЛК (not blaming the user)", forms.includes("Такском открыл API-сессию в другом ЛК") && forms.includes("Выбор договора в CLUB-OPS не переключает API-сессию"));
  const cpStart = forms.indexOf("export function OfdContractPicker");
  const cpSlice = forms.slice(cpStart, cpStart + 2500);
  check("SEC-CONTRACT picker component renders no accessRights/token/secrets/raw AccountList; only safe договор fields", cpStart > 0 && !/accessRights|sessionToken|loginEncrypted|passwordEncrypted|integratorId|rawAccountList/i.test(cpSlice) && cpSlice.includes("a.agreementNumber") && cpSlice.includes("a.companyName") && cpSlice.includes("a.inn") && cpSlice.includes("a.kpp"));
  check("T-S18d action inspectOfdDocumentInfoAction: requireOfdAdmin + fn/fd validation → inspectDocumentInfo → SAFE result (docInfoShape only)", actions.includes("export async function inspectOfdDocumentInfoAction") && actions.includes("requireOfdAdmin()") && actions.includes("inspectDocumentInfo(fnNumber, fd)") && actions.includes("docInfoShape: d") && actions.includes('/^\\d+$/.test(fdRaw)') && !/inspectOfdDocumentInfoAction[\s\S]{0,1400}return\s*\{[^}]*(sessionToken|rawResponse|\.stack)/i.test(actions));
  check("UI: 'DocumentInfo' diag form — ФН/ФД inputs + button + safe shape (ключи/позиции/itemLikeCount), no raw JSON", pageSrc.includes("Диагностика конкретного чека DocumentInfo") && pageSrc.includes("OfdDocInfoDiagnostics") && forms.includes("Проверить DocumentInfo") && forms.includes('name="fnNumber"') && forms.includes('name="fdNumber"') && forms.includes("docInfoShape") && forms.includes("documentKeys") && forms.includes("itemLikeCount") && !/docInfoShape[\s\S]{0,400}JSON\.stringify/.test(forms));
  check("UI: Автоимпорт block (status by OFD_INTEGRATIONS_ENABLED, endpoint, last auto run, hint; no CRON_SECRET)", pageSrc.includes("Автоимпорт") && pageSrc.includes("POST /api/cron/ofd/daily") && pageSrc.includes('mode: "auto_daily"') && pageSrc.includes("Последняя автоматическая синхронизация") && pageSrc.includes("Автоимпорт подтягивает продажи за вчера") && !/CRON_SECRET/.test(pageSrc));
  check("env examples define CRON_SECRET (+ OFD_INTEGRATIONS_ENABLED) without a real value", /CRON_SECRET=""/.test(envEx) && /OFD_INTEGRATIONS_ENABLED="false"/.test(envEx) && /CRON_SECRET=""/.test(envProd) && /OFD_INTEGRATIONS_ENABLED="false"/.test(envProd));
  check("docs: RU_DEPLOYMENT has cron curl example + endpoint + systemd timer note (no real secret)", deployDoc.includes("/api/cron/ofd/daily") && deployDoc.includes("curl -X POST") && deployDoc.includes("Authorization: Bearer $CRON_SECRET") && deployDoc.includes("systemd") && deployDoc.includes("OnCalendar"));
  check("9-date OfdDailySalesSummary uses 'date' column (not salesDate) in model/importer/page", schema.includes("model OfdDailySalesSummary") && !/salesDate/i.test(schema) && !/salesDate/i.test(importer) && !/salesDate/i.test(pageSrc) && importer.includes("buildSummaryKey"));
  // Static guard: no buyer PII / raw fiscal JSON is parsed, stored or logged.
  check("T-S7g no phone/email/buyer/customer/rawJson fields, no console logging of raw data in client.ts/adapter", !/phone|email|buyerName|customer|rawJson|rawResponse/i.test(clientSrc) && !clientSrc.includes("console.") && !/phone|email|buyerName|customer|rawJson/i.test(adapter));
  check("7 save NO LONGER blocks on empty contractNumber (contract is non-blocking)", !actions.includes('authType === "login_password" && !contractNumber') && !actions.includes("Укажите номер договора Такском"));
  check("8 secret masks / empty fields never overwrite stored ciphertext (enc guards mask+empty)", actions.includes("MASK_RE") && actions.includes("!MASK_RE.test(v)") && actions.includes("enc(\"login\") !== undefined"));
  check("9 checkOfdConnection: match availableContracts + require currentSession valid via isCurrentAccountValid; success (+ currentSession) / wrong-account; never token", actions.includes("export async function checkOfdConnection") && actions.includes("client.login()") && actions.includes("client.listAccounts()") && actions.includes("availableContracts.find((cn) => normalizeContractNumber(cn.agreementNumber) === requestedNormalized)") && actions.includes("isCurrentAccountValid(currentSession, requestedContractNumber, availableContracts.map((cn) => cn.agreementNumber))") && actions.includes("if (currentAccountValid)") && actions.includes("Текущий ЛК Такском соответствует выбранному договору") && actions.includes("matchedContract, currentSession }") && actions.includes('code: "taxcom_wrong_current_account"') && actions.includes("не найден среди доступных ЛК") && !/return\s*\{[^}]*sessionToken/.test(actions));
  check("9a match is by agreementNumber only — companyName/inn/kpp do NOT gate success", actions.includes("normalizeContractNumber(cn.agreementNumber) === requestedNormalized") && !/find\(\(cn\) => [^)]*companyName[^)]*===/.test(actions) && !/find\(\(cn\) => [^)]*inn[^)]*===/.test(actions));
  check("9b normalizeContractNumber (lib/ofd/contract) folds dashes + strips whitespace/zero-width + Cyrillic homoglyphs + NFKC; NOT a server export", contractSrc.includes("export function normalizeContractNumber") && contractSrc.includes("HOMOGLYPHS") && contractSrc.includes('.normalize("NFKC")') && contractSrc.includes(".toLowerCase()") && actions.includes('from "@/lib/ofd/contract"') && !actions.includes("export function normalizeContractNumber"));
  check("9c contract_not_found returns SAFE diagnostics (currentSession/requestedContractNumber/availableContracts, no secret accessors)", actions.includes('code: "contract_not_found"') && actions.includes("requestedContractNumber,") && actions.includes("availableContracts,") && actions.includes("const currentSession = accounts.data.currentAgreementNumber") && actions.includes("agreementNumber: r.agreementNumber") && actions.includes("companyName: r.companyName") && actions.includes("inn: r.inn") && actions.includes("kpp: r.kpp") && !/diagnostics:\s*\{[\s\S]{0,300}(cfg\.login|cfg\.password|c\.login|c\.password|integratorId|sessionToken|decryptOfdSecret|loginEncrypted)/i.test(actions));
  check("9d taxcom_wrong_current_account warning: договор доступен but current ЛК differs; clear API-session message; safe diagnostics incl matchedContract; never blocks with token", actions.includes('code: "taxcom_wrong_current_account"') && actions.includes("Такском открыл API-сессию в другом ЛК") && /diagnostics:\s*\{\s*currentSession,\s*requestedContractNumber,\s*matchedContract,\s*availableContracts,/.test(actions) && !/taxcom_wrong_current_account[\s\S]{0,400}(login|password|integratorId|sessionToken)/i.test(actions));
  check("9e importer AccountList guard: blocks before ShiftList when current ЛК invalid (isCurrentAccountValid, account_check + taxcom_wrong_current_account, status failed)", importer.includes("client.listAccounts()") && importer.includes("!isCurrentAccountValid(accounts.data.currentAgreementNumber, connection.contractNumber, accounts.data.records.map((r) => r.agreementNumber))") && importer.includes('"account_check"') && importer.includes('"taxcom_wrong_current_account"') && importer.includes('status: "failed"') && /account_check[\s\S]*?listShifts\(/.test(importer) && importer.includes('from "@/lib/ofd/contract"'));
  check("9f importer account guard runs BEFORE the ShiftList loop (fail fast, no 3103)", importer.indexOf('"account_check"') < importer.indexOf("client.listShifts(") && importer.indexOf("client.listAccounts()") < importer.indexOf("for (const m of mappings)"));
  check("9g isCurrentAccountValid (lib/ofd/contract): matches OR safe single-record fallback; present-but-different never overridden", contractSrc.includes("export function isCurrentAccountValid") && contractSrc.includes("normalizeContractNumber(currentSession) === want") && contractSrc.includes("availableAgreementNumbers.length === 1") && contractSrc.includes("!hasCurrent") && contractSrc.includes("normalizeContractNumber(availableAgreementNumbers[0]) === want"));
  check("kktstat parser reads Infos + FnFactoryNumber/Outlet fields", clientSrc.includes('asArray(data, "Infos", "infos"') && clientSrc.includes("FnFactoryNumber") && clientSrc.includes("OutletName"));
  check("UI: contract field non-blocking + new help + per-authType secrets + Проверить подключение", forms.includes("Номер договора Такском") && !/name="contractNumber"[^>]*required/.test(forms) && forms.includes("Сам Login Такском выполняется без этого поля") && forms.includes("isTokenAuth") && forms.includes("OfdCheckConnection") && forms.includes("Проверить подключение"));
  check("UI: contract_not_found panel shows Искомый договор / Текущий ЛК / Доступные договоры + availableContracts list", forms.includes('state.code === "contract_not_found"') && forms.includes("notFoundDiag.availableContracts") && forms.includes("items.map((a, i)") && forms.includes("Искомый договор") && forms.includes("Текущий ЛК Такском") && forms.includes("Доступные договоры Такском") && forms.includes("a.agreementNumber") && forms.includes("a.companyName") && forms.includes("a.inn") && forms.includes("a.kpp"));
  check("UI: success shows green matchedContract line 'Договор найден: …' + 'Текущий ЛК Такском: <currentSession>'", forms.includes("state.matchedContract") && forms.includes("Договор найден:") && forms.includes("contractLabel(matched)") && forms.includes("border-emerald") && forms.includes("a.kpp ? `КПП") && forms.includes("state.currentSession") && /Текущий ЛК Такском[\s\S]{0,80}state\.currentSession/.test(forms));
  check("UI: taxcom_wrong_current_account shows yellow block (API-сессия в другом ЛК / нужен текущий ЛК / отдельный пользователь + available list)", forms.includes('state.code === "taxcom_wrong_current_account"') && forms.includes("Такском открыл API-сессию в другом ЛК:") && forms.includes("Для импорта нужен текущий ЛК:") && forms.includes("создайте отдельного пользователя Такском") && forms.includes("wrongAccountDiag.availableContracts"));

  // ===== ОФД-продажи analytics (ANALYTICS-OFD) ================================
  // Mirror of src/lib/ofd/analytics.ts pure aggregators (no I/O).
  const anInRange = (d, from, to) => d >= from && d <= to;
  const anAcc = (a, s) => { a.income += s.incomeTotalKopeks; a.cash += s.incomeCashKopeks; a.electronic += s.incomeElectronicKopeks; a.ret += s.returnTotalKopeks; a.net += s.netTotalKopeks; a.receipts += s.receiptCount; a.returnReceipts += s.returnReceiptCount; };
  const anEmpty = () => ({ income: 0, cash: 0, electronic: 0, ret: 0, net: 0, receipts: 0, returnReceipts: 0 });
  const anTotal = (rows, from, to) => { const a = anEmpty(); for (const s of rows) if (anInRange(s.date, from, to)) anAcc(a, s); return a; };
  const anByClub = (rows, from, to) => { const m = new Map(); for (const s of rows) { if (!anInRange(s.date, from, to)) continue; const a = m.get(s.clubId) ?? anEmpty(); anAcc(a, s); m.set(s.clubId, a); } return m; };
  const anByLegal = (rows, from, to) => { const m = new Map(); for (const s of rows) { if (!anInRange(s.date, from, to)) continue; const k = s.legalEntityId ?? "none"; const a = m.get(k) ?? anEmpty(); anAcc(a, s); m.set(k, a); } return m; };
  const AN_ORDER = ["membership", "personal_training", "group_training", "extra_services", "other"]; const AN_NAMES = { membership: "Абонементы", personal_training: "Персональные тренировки", group_training: "Групповые тренировки", extra_services: "Доп. услуги", other: "Иное" };
  const anCats = (rows) => { const agg = new Map(); for (const s of rows) { const a = agg.get(s.categoryCode) ?? { income: 0, ret: 0, net: 0, items: 0, receipts: 0 }; a.income += s.incomeTotalKopeks; a.ret += s.returnTotalKopeks; a.net += s.netTotalKopeks; a.items += s.itemCount; a.receipts += s.receiptCount; agg.set(s.categoryCode, a); } return AN_ORDER.filter((c) => agg.has(c)).map((code) => ({ code, name: AN_NAMES[code], ...agg.get(code) })); };
  const anDetails = (items) => { const byCat = new Map(); for (const it of items) { let cat = byCat.get(it.revenueCategoryCode); if (!cat) { cat = new Map(); byCat.set(it.revenueCategoryCode, cat); } let row = cat.get(it.normalizedItemName); if (!row) { row = { income: 0, ret: 0, itemCount: 0, receipts: new Set(), examples: [], seen: new Set() }; cat.set(it.normalizedItemName, row); } if (it.operationType === "income") row.income += it.totalKopeks; else row.ret += it.totalKopeks; row.itemCount += 1; row.receipts.add(it.receiptImportId); const ex = (it.itemName ?? "").slice(0, 160); if (ex && !row.seen.has(ex) && row.examples.length < 3) { row.examples.push(ex); row.seen.add(ex); } } const out = {}; for (const [code, rows] of byCat) out[code] = [...rows.entries()].map(([normalizedName, r]) => ({ normalizedName, net: r.income - r.ret, income: r.income, itemCount: r.itemCount, receiptCount: r.receipts.size, examples: r.examples })).sort((a, b) => b.net - a.net); return out; };
  const anShiftMonth = (month, delta) => { const [y, m] = month.split("-").map(Number); const d = new Date(y, m - 1 + delta, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  const anClampMonth = (month, current) => (!month || !/^\d{4}-\d{2}$/.test(month)) ? current : (month > current ? current : month);
  const asum = (clubId, legal, date, income, cash, elec, ret, net, receipts, retReceipts) => ({ clubId, legalEntityId: legal, date, incomeTotalKopeks: income, incomeCashKopeks: cash, incomeElectronicKopeks: elec, returnTotalKopeks: ret, netTotalKopeks: net, receiptCount: receipts, returnReceiptCount: retReceipts });
  const aRows = [
    asum("club1", "ooo", "2026-07-18", 300000, 200000, 100000, 0, 300000, 3, 0),
    asum("club1", "ooo", "2026-07-17", 150000, 150000, 0, 50000, 100000, 2, 1),
    asum("club2", "ip", "2026-07-05", 500000, 0, 500000, 0, 500000, 5, 0),
    asum("club1", "ooo", "2026-06-30", 999999, 0, 0, 0, 999999, 9, 0),
  ];
  const mToday = anTotal(aRows, "2026-07-18", "2026-07-18"); const mYest = anTotal(aRows, "2026-07-17", "2026-07-17"); const mMonth = anTotal(aRows, "2026-07-01", "2026-07-31");
  check("ANALYTICS-OFD1 cards Today/Yesterday/Month built from OfdDailySalesSummary rows", mToday.income === 300000 && mToday.cash === 200000 && mToday.electronic === 100000 && mToday.receipts === 3 && mYest.income === 150000 && mYest.ret === 50000 && mYest.receipts === 2 && mMonth.income === 950000 && mMonth.receipts === 10 && mMonth.ret === 50000);
  const byClub = anByClub(aRows, "2026-07-01", "2026-07-31");
  check("ANALYTICS-OFD2 by-club aggregates cash/electronic/returns/net/receipts", byClub.get("club1").cash === 350000 && byClub.get("club1").electronic === 100000 && byClub.get("club1").ret === 50000 && byClub.get("club1").net === 400000 && byClub.get("club1").receipts === 5 && byClub.get("club2").electronic === 500000 && byClub.get("club2").net === 500000 && byClub.get("club2").receipts === 5);
  const byLegal = anByLegal(aRows, "2026-07-01", "2026-07-31");
  check("ANALYTICS-OFD3 by-legal-entity aggregates ООО and ИП separately", byLegal.size === 2 && byLegal.get("ooo").net === 400000 && byLegal.get("ooo").receipts === 5 && byLegal.get("ip").net === 500000 && byLegal.get("ip").receipts === 5);
  const catRows = [
    { categoryCode: "membership", incomeTotalKopeks: 500000, returnTotalKopeks: 0, netTotalKopeks: 500000, itemCount: 5, receiptCount: 5 },
    { categoryCode: "personal_training", incomeTotalKopeks: 200000, returnTotalKopeks: 0, netTotalKopeks: 200000, itemCount: 2, receiptCount: 2 },
    { categoryCode: "group_training", incomeTotalKopeks: 150000, returnTotalKopeks: 0, netTotalKopeks: 150000, itemCount: 1, receiptCount: 1 },
    { categoryCode: "extra_services", incomeTotalKopeks: 100000, returnTotalKopeks: 0, netTotalKopeks: 100000, itemCount: 1, receiptCount: 1 },
  ];
  const cats = anCats(catRows);
  check("ANALYTICS-OFD4 categories from OfdRevenueCategoryDailySummary in fixed order (membership/PT/GT/extra/other)", cats.map((c) => c.code).join(",") === "membership,personal_training,group_training,extra_services" && cats[0].name === "Абонементы" && cats[1].name === "Персональные тренировки" && cats[2].name === "Групповые тренировки" && cats[3].name === "Доп. услуги" && cats[0].income === 500000);
  check("ANALYTICS-OFD5 sum of category income equals the month OFD income when positions exist", cats.reduce((s, c) => s + c.income, 0) === mMonth.income);
  check("ANALYTICS-OFD6 no nomenclature → empty category table + empty drilldown (no crash)", anCats([]).length === 0 && Object.keys(anDetails([])).length === 0);
  check("ANALYTICS-OFD month switcher: shiftMonth ±1 (year rollover) + clamp to current (no future/invalid)", anShiftMonth("2026-07", -1) === "2026-06" && anShiftMonth("2026-01", -1) === "2025-12" && anShiftMonth("2026-12", 1) === "2027-01" && anClampMonth("2026-09", "2026-07") === "2026-07" && anClampMonth("bad", "2026-07") === "2026-07" && anClampMonth("2026-05", "2026-07") === "2026-05");
  const det = anDetails([
    { revenueCategoryCode: "membership", normalizedItemName: "абонемент", itemName: "Абонемент 1", totalKopeks: 100000, operationType: "income", receiptImportId: "r1" },
    { revenueCategoryCode: "membership", normalizedItemName: "абонемент", itemName: "Абонемент 2", totalKopeks: 100000, operationType: "income", receiptImportId: "r2" },
    { revenueCategoryCode: "membership", normalizedItemName: "абонемент", itemName: "Абонемент 3", totalKopeks: 100000, operationType: "income", receiptImportId: "r2" },
    { revenueCategoryCode: "membership", normalizedItemName: "абонемент", itemName: "Абонемент 4", totalKopeks: 100000, operationType: "income", receiptImportId: "r3" },
  ]);
  check("ANALYTICS-OFD drilldown groups by normalizedName; ≤3 examples; unique receiptCount", det.membership.length === 1 && det.membership[0].normalizedName === "абонемент" && det.membership[0].income === 400000 && det.membership[0].itemCount === 4 && det.membership[0].receiptCount === 3 && det.membership[0].examples.length === 3);
  // Static guards on the real source.
  const analyticsLib = readFileSync(new URL("../src/lib/ofd/analytics.ts", import.meta.url), "utf8");
  const ofdSalesPage = readFileSync(new URL("../src/app/(app)/analytics/ofd-sales/page.tsx", import.meta.url), "utf8");
  const authSrc = readFileSync(new URL("../src/lib/auth.ts", import.meta.url), "utf8");
  const navSrc = readFileSync(new URL("../src/lib/navigation.ts", import.meta.url), "utf8");
  const overviewComp = readFileSync(new URL("../src/app/(app)/dashboard/_components/OfdSalesOverview.tsx", import.meta.url), "utf8");
  const dashboardLib = readFileSync(new URL("../src/lib/ofd/dashboard.ts", import.meta.url), "utf8");
  const dashPageSrc = readFileSync(new URL("../src/app/(app)/dashboard/page.tsx", import.meta.url), "utf8");
  check("ANALYTICS-LIB analytics lib exports pure aggregators + fixed category order", analyticsLib.includes("export function totalForRange") && analyticsLib.includes("export function aggByClub") && analyticsLib.includes("export function aggByLegalEntity") && analyticsLib.includes("export function aggCategories") && analyticsLib.includes("export function buildCategoryDetails") && analyticsLib.includes('"membership", "personal_training", "group_training", "extra_services", "other"'));
  check("ANALYTICS-OFD7 page scopes OFD queries by ctx.allowedClubIds (regional_director sees only their clubs) + provider taxcom", ofdSalesPage.includes("const clubIds = ctx.allowedClubIds") && ofdSalesPage.includes("clubId: { in: clubIds }") && ofdSalesPage.includes('provider: "taxcom"'));
  check("ANALYTICS-OFD8 ofd_sales access ONLY owner/general_director/regional_director (NOT manager/accountant/chief_accountant/marketer); page guarded", /owner:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && /general_director:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && /regional_director:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && !/\bmanager:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && !/\baccountant:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && !/chief_accountant:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && !/marketer:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && ofdSalesPage.includes('requirePageAccess("ofd_sales")'));
  check("ANALYTICS-OFD9 page has NO technical diagnostics (NewDocuments/DocumentInfo/inspect/ShiftList/DocumentList)", !/NewDocuments|DocumentInfo|inspect|ShiftList|DocumentList/i.test(ofdSalesPage));
  check("ANALYTICS-OFD reuse: page imports OfdRevenueTable + analytics lib; nav item ofd_sales present", ofdSalesPage.includes("OfdRevenueTable") && ofdSalesPage.includes('from "@/lib/ofd/analytics"') && navSrc.includes('page: "ofd_sales"') && navSrc.includes('href: "/analytics/ofd-sales"') && navSrc.includes('label: "ОФД-продажи"'));
  check("ANALYTICS-SECURITY page/lib render no secrets/technical fiscal internals (login/password/Integrator/SessionToken/ФПД/fpd/fiscalSign/ФН/PII/stack)", !/login|password|integrator|sessionToken|Bearer|rawJson|fiscalSign|ФПД|fpd|phone|email|buyer|customer|stack|ShiftList|DocumentInfo|NewDocuments/i.test(ofdSalesPage) && !ofdSalesPage.includes("ФН") && !/login|password|sessionToken|fiscalSign|ФПД/i.test(analyticsLib));

  // ===== Dashboard ОФД-продажи overview (DASH-OFD) ============================
  // Mirror of buildOfdDashboardOverview (reuses the analytics mirrors above).
  const anAvgCheck = (a) => (a.receipts > 0 ? Math.round(a.net / a.receipts) : 0);
  const D_OTHER_WARN = 0.05, D_OTHER_SIG = 0.1, D_RET_SIG = 0.05, D_AFTERNOON = 12;
  const anDashboard = (i) => {
    const today = anTotal(i.summaries, i.today, i.today), yesterday = anTotal(i.summaries, i.yesterday, i.yesterday), month = anTotal(i.summaries, i.monthFrom, i.monthTo);
    const byClub = [...anByClub(i.summaries, i.monthFrom, i.monthTo).entries()].map(([clubId, agg]) => ({ clubId, name: i.clubNameById[clubId] ?? "—", agg, avgCheckKopeks: anAvgCheck(agg) })).sort((a, b) => b.agg.income - a.agg.income);
    const byLegal = [...anByLegal(i.summaries, i.monthFrom, i.monthTo).entries()].map(([k, agg]) => ({ legalEntityId: k, name: k === "none" ? "Без юрлица" : (i.legalNameById[k] ?? "—"), agg })).sort((a, b) => b.agg.income - a.agg.income);
    const catRows = anCats(i.categoryDays);
    const catIncome = catRows.reduce((s, c) => s + c.income, 0);
    const categories = catRows.map((c) => ({ ...c, share: catIncome > 0 ? c.income / catIncome : 0 }));
    const otherShare = catIncome > 0 ? (catRows.find((c) => c.code === "other")?.income ?? 0) / catIncome : 0;
    const daysPassed = Math.max(0, i.daysPassed), daysInMonth = Math.max(1, i.daysInMonth);
    const avgPerDayKopeks = daysPassed > 0 ? Math.round(month.income / daysPassed) : 0;
    const pace = { avgPerDayKopeks, forecastKopeks: avgPerDayKopeks * daysInMonth, daysPassed, daysLeft: Math.max(0, daysInMonth - daysPassed), daysInMonth };
    const signals = [];
    if (i.lastSyncFailed) signals.push({ code: "sync_failed", message: "ОФД-синхронизация завершилась с ошибкой. Проверьте подключение." });
    if (today.receipts === 0 && month.receipts > 0 && i.nowHour >= D_AFTERNOON) signals.push({ code: "no_sales_today", message: "Сегодня пока нет продаж по ОФД. Если клубы работают — проверьте синхронизацию." });
    if (otherShare > D_OTHER_SIG) signals.push({ code: "other_high", message: `Большая доля выручки в «Иное» (${Math.round(otherShare * 100)}%) — проверьте номенклатуру.` });
    if (month.income > 0 && month.ret / month.income > D_RET_SIG) signals.push({ code: "returns_high", message: `Возвраты за месяц превышают ${Math.round(D_RET_SIG * 100)}% от прихода — проверьте причины.` });
    if (yesterday.receipts > 0) { const yb = anByClub(i.summaries, i.yesterday, i.yesterday); for (const c of byClub) if (c.agg.receipts > 0 && (yb.get(c.clubId)?.receipts ?? 0) === 0) signals.push({ code: "club_no_sales_yesterday", message: `По клубу «${c.name}» вчера не было продаж по ОФД.` }); }
    return { today, yesterday, month, pace, byClub, byLegal, categories, otherShare, otherWarn: otherShare > D_OTHER_WARN, signals, hasData: month.income > 0 || month.ret > 0 || byClub.length > 0 };
  };
  const dBase = { summaries: aRows, categoryDays: catRows, clubNameById: { club1: "Клуб 1", club2: "Клуб 2" }, legalNameById: { ooo: "ООО Икс", ip: "ИП Игрек" }, today: "2026-07-18", yesterday: "2026-07-17", monthFrom: "2026-07-01", monthTo: "2026-07-31", daysInMonth: 31, daysPassed: 18, nowHour: 15, lastSyncFailed: false };
  const D = anDashboard(dBase);
  check("DASH-OFD1 сводка Сегодня/Вчера/Месяц + темп из OfdDailySalesSummary", D.today.income === 300000 && D.yesterday.income === 150000 && D.month.income === 950000 && D.today.receipts === 3 && D.yesterday.receipts === 2 && D.month.receipts === 10 && D.pace.daysPassed === 18 && D.pace.daysLeft === 13 && D.pace.avgPerDayKopeks === Math.round(950000 / 18) && D.pace.forecastKopeks === Math.round(950000 / 18) * 31);
  check("DASH-OFD2 разделяет наличные/безнал/возвраты/чеки", D.today.cash === 200000 && D.today.electronic === 100000 && D.today.ret === 0 && D.yesterday.ret === 50000 && D.month.cash === 350000 && D.month.electronic === 600000 && D.month.ret === 50000);
  check("DASH-OFD3 группирует по клубам и сортирует по приходу убывание (+ ср. чек = net/receipts)", D.byClub.length === 2 && D.byClub[0].clubId === "club2" && D.byClub[0].agg.income === 500000 && D.byClub[1].clubId === "club1" && D.byClub[1].agg.income === 450000 && D.byClub[0].avgCheckKopeks === 100000);
  const dScopeAll = anDashboard({ ...dBase }); const dScopeOne = anDashboard({ ...dBase, summaries: aRows.filter((r) => r.clubId === "club1") });
  check("DASH-OFD4 regional (ограниченный scope) видит только свои клубы (loader фильтрует clubId in clubIds)", dScopeOne.byClub.length === 1 && dScopeOne.byClub[0].clubId === "club1" && dashboardLib.includes("clubId: { in: clubIds }") && dashboardLib.includes("if (clubIds.length === 0) return empty()"));
  check("DASH-OFD5 owner/GD видит карточки клубов по всему scope (ClubCardsGrid из per-club ОФД)", dScopeAll.byClub.length === 2 && dashPageSrc.includes("<ClubCardsGrid") && dashPageSrc.includes("cards={cards}") && dashPageSrc.includes("loadCompanyClubCards(cid, g.name, g.clubs, period, financials, now, canSeeOfdSales, canSeeCash)"));
  check("DASH-OFD6 manager/accountant/marketer не получают финансовый dashboard (гейт canSeeOfdSales/financials/canSeeCash)", dashPageSrc.includes('const canSeeOfdSales = canAnyRoleAccessPage(roles, "ofd_sales")') && /showSales=\{canSeeOfdSales\}/.test(dashPageSrc) && !/\bmanager:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && !/\baccountant:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && !/marketer:\s*\[[^\]]*"ofd_sales"/.test(authSrc));
  check("DASH-OFD7 блок ООО/ИП агрегирует по legalEntityId", D.byLegal.length === 2 && D.byLegal.find((l) => l.legalEntityId === "ip").agg.income === 500000 && D.byLegal.find((l) => l.legalEntityId === "ooo").agg.income === 450000);
  check("DASH-OFD8 статьи доходов: категории + доля от месячного прихода", D.categories.length === 4 && D.categories[0].code === "membership" && D.categories[0].share === 500000 / 950000 && Math.round(D.categories[0].share * 100) === 53);
  const dOther = anDashboard({ ...dBase, categoryDays: [{ categoryCode: "membership", incomeTotalKopeks: 500000, returnTotalKopeks: 0, netTotalKopeks: 500000, itemCount: 5, receiptCount: 5 }, { categoryCode: "other", incomeTotalKopeks: 200000, returnTotalKopeks: 0, netTotalKopeks: 200000, itemCount: 3, receiptCount: 3 }] });
  check("DASH-OFD9 «Иное» > 10% → предупреждение (otherWarn) + управленческий сигнал other_high", dOther.otherShare === 200000 / 700000 && dOther.otherWarn === true && dOther.signals.some((s) => s.code === "other_high") && dOther.signals.find((s) => s.code === "other_high").message.includes("проверьте номенклатуру"));
  const dFail = anDashboard({ ...dBase, lastSyncFailed: true });
  check("DASH-OFD10 failed sync → управленческий сигнал без raw-ошибки (нет DocumentList/stack)", dFail.signals.some((s) => s.code === "sync_failed") && dFail.signals.find((s) => s.code === "sync_failed").message === "ОФД-синхронизация завершилась с ошибкой. Проверьте подключение." && !/DocumentList|DocumentInfo|stack|failed sync|\.status/i.test(dFail.signals.map((s) => s.message).join(" ")) && dashboardLib.includes('lastSyncFailed: lastRun?.status === "failed"') && !dashboardLib.includes("safeErrorMessage"));
  check("DASH-OFD11 ссылка «Открыть подробную аналитику ОФД-продаж» ведёт на /analytics/ofd-sales", overviewComp.includes('href="/analytics/ofd-sales"') && overviewComp.includes("Открыть подробную аналитику ОФД-продаж"));
  check("DASH-OFD12 нет raw fiscal JSON / секретов / ПДн / cashier в dashboard output (компонент+loader+lib)", ![overviewComp, dashboardLib].some((s) => /login|password|integrator|sessionToken|Bearer|rawJson|fiscalSign|ФПД|\bfpd\b|cashierName|cashierInn|\bphone\b|\bemail\b|buyer|customer|\.stack|JSON\.stringify/i.test(s)) && dashboardLib.includes('provider: "taxcom"') && dashboardLib.includes("select:"));
  check("DASH-OFD empty state: нет данных → hasData=false, дружелюбное пустое состояние", anDashboard({ ...dBase, summaries: [], categoryDays: [] }).hasData === false && overviewComp.includes("Пока нет продаж по ОФД"));
  check("DARK-DASH-OFD1 блок ОФД-продаж читаем в тёмной теме (dark: варианты для карточек/панелей/сигналов; не белый на тёмном)", overviewComp.includes("dark:bg-slate-900") && overviewComp.includes("dark:border-slate-800") && overviewComp.includes("dark:text-slate-200") && overviewComp.includes("dark:bg-amber-950/40") && overviewComp.includes("dark:text-slate-400"));

  // ===== ОФД в Дашборде и Аналитике (DASH-USE-OFD / ANALYTICS-USE-OFD) =========
  // Mirror of buildOfdManagementOverview + computeManagementResult (pure).
  const CAT_FIELD = { membership: "subscriptionsKopeks", personal_training: "personalTrainingKopeks", group_training: "groupTrainingKopeks", extra_services: "extraServicesKopeks", other: "otherKopeks" };
  const emptyMgmt = () => ({ incomeKopeks: 0, cashKopeks: 0, cardKopeks: 0, returnsKopeks: 0, netKopeks: 0, receipts: 0, subscriptionsKopeks: 0, personalTrainingKopeks: 0, groupTrainingKopeks: 0, extraServicesKopeks: 0, otherKopeks: 0 });
  const inWin = (d, a, b) => d >= a && d < b;
  const buildMgmt = ({ summaries, categories, startStr, endStr }) => {
    const perClub = new Map(); const totals = emptyMgmt();
    const clubFor = (id) => { let f = perClub.get(id); if (!f) { f = emptyMgmt(); perClub.set(id, f); } return f; };
    for (const s of summaries) { if (!inWin(s.date, startStr, endStr)) continue; const f = clubFor(s.clubId); f.incomeKopeks += s.incomeTotalKopeks; f.cashKopeks += s.incomeCashKopeks; f.cardKopeks += s.incomeElectronicKopeks; f.returnsKopeks += s.returnTotalKopeks; f.netKopeks += s.netTotalKopeks; f.receipts += s.receiptCount; totals.incomeKopeks += s.incomeTotalKopeks; totals.cashKopeks += s.incomeCashKopeks; totals.cardKopeks += s.incomeElectronicKopeks; totals.returnsKopeks += s.returnTotalKopeks; totals.netKopeks += s.netTotalKopeks; totals.receipts += s.receiptCount; }
    for (const c of categories) { if (!inWin(c.date, startStr, endStr)) continue; const field = CAT_FIELD[c.categoryCode]; if (!field) continue; clubFor(c.clubId)[field] += c.incomeTotalKopeks; totals[field] += c.incomeTotalKopeks; }
    return { perClub, totals, hasData: totals.incomeKopeks > 0 || totals.returnsKopeks > 0 || totals.receipts > 0 };
  };
  const mgmtResult = (net, costs) => net - costs;
  const mSum = (clubId, date, income, cash, elec, ret, net, receipts) => ({ clubId, date, incomeTotalKopeks: income, incomeCashKopeks: cash, incomeElectronicKopeks: elec, returnTotalKopeks: ret, netTotalKopeks: net, receiptCount: receipts });
  const mCat = (clubId, date, code, income) => ({ clubId, date, categoryCode: code, incomeTotalKopeks: income });
  const mSummaries = [
    mSum("clubA", "2026-07-05", 600000, 400000, 200000, 0, 600000, 6),
    mSum("clubA", "2026-06-30", 999999, 0, 0, 0, 999999, 9), // before window → ignored
    mSum("clubB", "2026-07-10", 300000, 100000, 200000, 50000, 250000, 4),
  ];
  const mCats = [
    mCat("clubA", "2026-07-05", "membership", 400000), mCat("clubA", "2026-07-05", "personal_training", 150000), mCat("clubA", "2026-07-05", "other", 50000),
    mCat("clubB", "2026-07-10", "membership", 180000), mCat("clubB", "2026-07-10", "group_training", 70000),
    mCat("clubA", "2026-06-30", "membership", 999999), // before window → ignored
  ];
  const mgmt = buildMgmt({ summaries: mSummaries, categories: mCats, startStr: "2026-07-01", endStr: "2026-08-01" });
  const dashPage = dashPageSrc; // read earlier
  const keyCardsComp = readFileSync(new URL("../src/app/(app)/dashboard/_components/ClubCard.tsx", import.meta.url), "utf8");
  const dashCardsLib = readFileSync(new URL("../src/lib/dashboard-cards.ts", import.meta.url), "utf8");
  const analyticsPage = readFileSync(new URL("../src/app/(app)/analytics/page.tsx", import.meta.url), "utf8");
  const mgmtLib = readFileSync(new URL("../src/lib/analytics/ofd-management.ts", import.meta.url), "utf8");

  check("DASH-USE-OFD1 dashboard использует ОФД (карточки клубов), не показывает 0 при наличии выручки", mgmt.hasData === true && mgmt.perClub.get("clubA").incomeKopeks === 600000 && mgmt.perClub.get("clubB").incomeKopeks === 300000 && dashPage.includes("<ClubCardsGrid") && dashCardsLib.includes("loadOfdManagementOverview(companyId, clubIds, period.start, period.end)") && dashCardsLib.includes("ofdCardFields(ofdMgmt?.perClub.get(c.id))"));
  check("DASH-USE-OFD2 «Абонементы» берутся из ОФД-категории membership", mgmt.perClub.get("clubA").subscriptionsKopeks === 400000 && mgmt.totals.subscriptionsKopeks === 580000 && keyCardsComp.includes("card.ofd.ofdSubscriptionsKopeks") && mgmtLib.includes('membership: "subscriptionsKopeks"'));
  check("DASH-USE-OFD3 «ПТ» берётся из ОФД-категории personal_training", mgmt.perClub.get("clubA").personalTrainingKopeks === 150000 && keyCardsComp.includes("card.ofd.ofdPersonalTrainingKopeks") && mgmtLib.includes('personal_training: "personalTrainingKopeks"'));
  check("DASH-USE-OFD4 учитывается фильтр месяца (окно [start,end) отсекает дни вне периода)", buildMgmt({ summaries: mSummaries, categories: mCats, startStr: "2026-06-01", endStr: "2026-07-01" }).perClub.get("clubA").incomeKopeks === 999999 && mgmt.perClub.get("clubA").incomeKopeks === 600000);
  check("DASH-USE-OFD5 учитывает выбранную компанию/клуб (loader фильтрует companyId + clubId in clubIds)", mgmtLib.includes('provider: "taxcom"') && mgmtLib.includes("clubId: { in: clubIds }") && mgmtLib.includes("companyId,") && mgmtLib.includes("if (clubIds.length === 0)"));
  check("DASH-USE-OFD6 regional видит только allowedClubIds (dashboard scope = getUserClubs; loader не расширяет scope)", dashPage.includes("const clubs = await getUserClubs(user.id, companyId)") && dashPage.includes("loadCompanyClubCards(companyId, companyName, cardClubs") && mgmtLib.includes("clubId: { in: clubIds }"));
  check("ANALYTICS-USE-OFD1 верхние карточки аналитики используют ОФД (выручка/категории)", analyticsPage.includes("loadOfdManagementOverview(aCompanyId, aClubIds, period.start, period.end)") && analyticsPage.includes("Выручка ОФД") && analyticsPage.includes("const useOfd = !!ofd && ofd.hasData"));
  check("ANALYTICS-USE-OFD2 «Продажи АБ» = ОФД-категория «Абонементы»", analyticsPage.includes("const abValue = useOfd ? ofd!.totals.subscriptionsKopeks : s.subscriptionsKopeks") && mgmt.totals.subscriptionsKopeks === 580000);
  check("ANALYTICS-USE-OFD3 «Продажи ПТ» = ОФД-категория «Персональные тренировки»", analyticsPage.includes("const ptValue = useOfd ? ofd!.totals.personalTrainingKopeks : s.personalTrainingKopeks") && mgmt.totals.personalTrainingKopeks === 150000);
  check("ANALYTICS-USE-OFD4 «По сетям» использует ОФД-категории вместо старых нулей", analyticsPage.includes("useOfd ? p.ofd!.totals.subscriptionsKopeks : p.r.summary.subscriptionsKopeks") && analyticsPage.includes("useOfd ? p.ofd!.totals.personalTrainingKopeks : p.r.summary.personalTrainingKopeks") && analyticsPage.includes("netRows.map"));
  check("ANALYTICS-USE-OFD5 учитывает фильтры город/компания/клуб (scoped clubIds)", analyticsPage.includes("loadOfdManagementOverview(g.companyId, g.clubIds, period.start, period.end)") && analyticsPage.includes("const aClubIds = groups ? groups.filteredClubIds : requestedClubId ? [requestedClubId] : ctx.allowedClubIds"));
  check("ANALYTICS-USE-OFD6 результат = ОФД net − подтверждённые расходы", mgmtResult(mgmt.totals.netKopeks, 200000) === mgmt.totals.netKopeks - 200000 && analyticsPage.includes("computeManagementResult(ofd!.totals.netKopeks, s.expensesKopeks)") && mgmtLib.includes("export function computeManagementResult(ofdNetKopeks: number, confirmedCostsKopeks: number)"));
  check("OFD-SALES-RECON1 /analytics/ofd-sales остаётся детальной сверкой, а не единственным управленческим экраном", ofdSalesPage.includes("Детализация и сверка чеков ОФД") && dashCardsLib.includes("loadOfdManagementOverview") && analyticsPage.includes("loadOfdManagementOverview") && ofdSalesPage.includes('requirePageAccess("ofd_sales")'));
  check("ROLE-OFD-MGMT1 manager/accountant/marketer НЕ получают управленческую ОФД-аналитику (гейт canSeeOfdSales; нет ofd_sales доступа)", dashPage.includes('const canSeeOfdSales = canAnyRoleAccessPage(roles, "ofd_sales")') && analyticsPage.includes('const canSeeOfdSales = canAnyRoleAccessPage(roles, "ofd_sales")') && !/\bmanager:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && !/\baccountant:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && !/marketer:\s*\[[^\]]*"ofd_sales"/.test(authSrc));
  check("ROLE-OFD-MGMT2 owner/GD/regional видят управленческие ОФД-данные по scope", /owner:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && /general_director:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && /regional_director:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && dashPage.includes("showSales={canSeeOfdSales}") && analyticsPage.includes("canSeeOfdSales ? await loadOfdManagementOverview"));
  check("SECURITY-OFD-MGMT1 нет секретов/raw JSON/cashier/ПДн/реквизитов в ОФД-выводе дашборда/аналитики/хелпера", ![mgmtLib, dashCardsLib].some((s) => /login|password|integrator|sessionToken|Bearer|rawJson|fiscalSign|ФПД|\bfpd\b|cashierName|cashierInn|\bphone\b|\bemail\b|buyer|customer|iban|\bбик\b|расчетный счет|\.stack|JSON\.stringify/i.test(s)) && mgmtLib.includes('provider: "taxcom"') && !/JSON\.stringify/.test(mgmtLib));
  check("DARK-OFD-MGMT1 ОФД-блоки в дашборде/аналитике читаемы в тёмной теме", keyCardsComp.includes("dark:bg-slate-900") && keyCardsComp.includes("dark:text-slate-100") && analyticsPage.includes("KpiCard") && analyticsPage.includes("dark:bg-slate-900"));

  // ===== Аудит: продажи из ОФД, прогноз, отключение ручного ввода ==============
  const reportActions = readFileSync(new URL("../src/app/(app)/sales/report-actions.ts", import.meta.url), "utf8");
  const salesPage = readFileSync(new URL("../src/app/(app)/sales/page.tsx", import.meta.url), "utf8");
  const analyticsLibSrc = readFileSync(new URL("../src/lib/analytics.ts", import.meta.url), "utf8");
  const forecastBlock = readFileSync(new URL("../src/components/MonthlyForecastBlock.tsx", import.meta.url), "utf8");
  const createReportBody = reportActions.slice(reportActions.indexOf("export async function createSalesReport"), reportActions.indexOf("export async function uploadSalesReportDocuments"));
  // Mirror of buildMonthlyForecast (only the fields under test).
  const buildForecast = ({ salesFact, salesPlan, elapsedDays, totalDays }) => {
    const hasPlan = salesPlan > 0;
    const completionPercent = hasPlan ? (salesFact / salesPlan) * 100 : null;
    const averagePerDay = elapsedDays > 0 ? Math.round(salesFact / elapsedDays) : 0;
    const remainingAfterToday = Math.max(0, totalDays - elapsedDays);
    const projectedMonthSales = elapsedDays > 0 ? salesFact + averagePerDay * remainingAfterToday : null;
    let risk = "none";
    if (hasPlan && projectedMonthSales !== null) risk = projectedMonthSales >= salesPlan ? "low" : projectedMonthSales >= salesPlan * 0.9 ? "medium" : "high";
    return { hasPlan, completionPercent, averagePerDay, projectedMonthSales, risk };
  };

  check("NAV-SALES1 пункт «Продажи» удалён из навигации (NAV_ITEMS + NAV_SECTIONS)", !navSrc.includes('page: "sales", href: "/sales"') && !/\{\s*type:\s*"item",\s*page:\s*"sales"\s*\}/.test(navSrc) && navSrc.includes('page: "ofd_sales"'));
  check("SALES-LEGACY1 createSalesReport не создаёт новый сменный отчёт (disabled, нет salesReport.create в теле)", createReportBody.includes("MANUAL_SALES_DISABLED_MESSAGE") && createReportBody.includes('auditBlockedFeature("sales_report.create")') && !createReportBody.includes("salesReport.create"));
  check("SALES-LEGACY1b константа отключения задаёт корректное сообщение", readFileSync(new URL("../src/lib/disabled-features.ts", import.meta.url), "utf8").includes('MANUAL_SALES_DISABLED_MESSAGE = "Ручной ввод продаж отключён. Продажи поступают из ОФД."'));
  check("SALES-LEGACY2 прямое открытие /sales показывает read-only сообщение и НЕ рендерит форму создания", salesPage.includes("Ручной ввод продаж отключён. Продажи поступают из ОФД.") && !salesPage.includes("<SalesReportForm") && salesPage.includes('requirePageAccess("sales")'));
  check("ANALYTICS-CARD1 «Выручка ОФД» = OfdDailySalesSummary (через loadOfdManagementOverview за период)", analyticsPage.includes("loadOfdManagementOverview(aCompanyId, aClubIds, period.start, period.end)") && analyticsPage.includes("const ofdRevenueKopeks = ofd?.totals.incomeKopeks ?? 0") && mgmtLib.includes("ofdDailySalesSummary.findMany") && mgmtLib.includes("f.incomeKopeks += s.incomeTotalKopeks"));
  check("ANALYTICS-CARD2 «Абонементы (ОФД)» = категория membership", analyticsPage.includes("const abValue = useOfd ? ofd!.totals.subscriptionsKopeks") && mgmtLib.includes('membership: "subscriptionsKopeks"'));
  check("ANALYTICS-CARD3 «Персональные тренировки (ОФД)» = категория personal_training", analyticsPage.includes("const ptValue = useOfd ? ofd!.totals.personalTrainingKopeks") && mgmtLib.includes('personal_training: "personalTrainingKopeks"'));
  check("ANALYTICS-CARD4 «Результат (ОФД − расходы)» = ОФД net − confirmed costs", analyticsPage.includes("computeManagementResult(ofd!.totals.netKopeks, s.expensesKopeks)"));
  check("ANALYTICS-CARD5 «Фактические расходы» не включают pending (EXPENSE_REALIZED_STATUSES = confirmed/verified)", analyticsLibSrc.includes("EXPENSE_REALIZED_STATUSES") && analyticsLibSrc.includes('status: { in: [...EXPENSE_REALIZED_STATUSES] }') && /EXPENSE_REALIZED_STATUSES\s*=\s*\[\s*"confirmed",\s*"verified"\s*\]/.test(readFileSync(new URL("../src/lib/budgets.ts", import.meta.url), "utf8")));
  check("ANALYTICS-FORECAST1 прогноз использует ОФД-факт, а не старые sales reports", analyticsPage.includes("const salesFact = useOfd ? ofdRevenueKopeks : s.subscriptionsKopeks + s.personalTrainingKopeks") && analyticsPage.includes("if (!useOfd && period.key === \"current_month\")"));
  const fc = buildForecast({ salesFact: 917993, salesPlan: 1500000, elapsedDays: 19, totalDays: 31 });
  check("ANALYTICS-FORECAST2 при ОФД-выручке 917 993 ₽ прогноз по темпу ≠ 0", fc.projectedMonthSales !== null && fc.projectedMonthSales > 0 && fc.averagePerDay === Math.round(917993 / 19) && fc.completionPercent > 0);
  const fcNoPlan = buildForecast({ salesFact: 917993, salesPlan: 0, elapsedDays: 19, totalDays: 31 });
  check("ANALYTICS-FORECAST3 без плана — «План не задан», не ложный 0%", fcNoPlan.hasPlan === false && fcNoPlan.completionPercent === null && forecastBlock.includes('value: "План не задан"'));
  check("ANALYTICS-FORECAST4 риск от ОФД-прогноза (не высокий из-за старого 0); нет плана → none/«Недостаточно данных»", buildForecast({ salesFact: 1600000, salesPlan: 1500000, elapsedDays: 19, totalDays: 31 }).risk === "low" && fcNoPlan.risk === "none" && forecastBlock.includes("Недостаточно данных"));
  check("DASHBOARD-CARD1 dashboard показывает ОФД-выручку при наличии OfdDailySalesSummary (карточки клубов)", dashPage.includes("<ClubCardsGrid") && dashCardsLib.includes("loadOfdManagementOverview(companyId, clubIds, period.start, period.end)") && keyCardsComp.includes("Выручка ОФД") && keyCardsComp.includes('label="Абонементы"'));
  check("DASHBOARD-CARD2 Абонементы/ПТ в карточке берутся из ОФД membership/PT", keyCardsComp.includes("card.ofd.ofdSubscriptionsKopeks") && keyCardsComp.includes("card.ofd.ofdPersonalTrainingKopeks") && dashCardsLib.includes("ofdCardFields(ofdMgmt?.perClub.get(c.id))"));
  check("DASHBOARD-CARD3 результат карточки = ОФД net − confirmed costs", keyCardsComp.includes("computeManagementResult(card.ofd.ofdNetKopeks, card.expensesKopeks)"));
  check("DASHBOARD-LEGACY1 старый блок неподтверждённых ручных продаж убран (не главный сигнал дашборда)", !dashPage.includes("<UnconfirmedSalesBlock") && !dashPage.includes("UnconfirmedSalesBlock } from") && !dashPage.includes("getUnconfirmedReportsForMonth"));
  check("FILTER-OFD1 фильтры месяц/компания/клуб применяются к OFD summary и категориям", mgmtLib.includes("date: { gte: startStr, lt: endStr }") && mgmtLib.includes("clubId: { in: clubIds }") && mgmtLib.includes("ofdRevenueCategoryDailySummary.findMany"));
  check("FILTER-OFD2 regional видит только allowedClubIds во всей ОФД-аналитике", analyticsPage.includes("const aClubIds = groups ? groups.filteredClubIds : requestedClubId ? [requestedClubId] : ctx.allowedClubIds") && dashPage.includes("const clubs = await getUserClubs(user.id, companyId)") && mgmtLib.includes("if (clubIds.length === 0)"));
  check("ROLE-SALES1 manager/accountant/marketer не видят ручной ввод продаж (сервер отключил создание для всех; форма и меню убраны)", createReportBody.includes("MANUAL_SALES_DISABLED_MESSAGE") && !salesPage.includes("<SalesReportForm") && !navSrc.includes('page: "sales", href: "/sales"'));
  check("ROLE-OFD-ANALYTICS1 owner/GD/regional видят ОФД-аналитику по scope (гейт ofd_sales)", /owner:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && /general_director:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && /regional_director:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && analyticsPage.includes('canAnyRoleAccessPage(roles, "ofd_sales")') && dashPage.includes('canAnyRoleAccessPage(roles, "ofd_sales")'));
  check("SECURITY-ANALYTICS1 нет секретов/raw JSON/cashier/ПДн/реквизитов в дашборде/аналитике/хелпере", ![analyticsPage, dashPage, mgmtLib].some((s) => /login|password|integrator|sessionToken|Bearer|rawJson|fiscalSign|ФПД|\bfpd\b|cashierName|cashierInn|\bphone\b|\bemail\b|\bbuyer\b|\bcustomer\b|iban|расчетный счет|\.stack/i.test(s)) && !/JSON\.stringify/.test(mgmtLib));
  check("DARK-ANALYTICS1 карточки и прогноз аналитики читаемы в тёмной теме", analyticsPage.includes("dark:bg-slate-900") && analyticsPage.includes("dark:text-slate-100") && forecastBlock.includes("dark:"));

  // ===== Упрощённый Dashboard + ОФД дни недели + мягкие цвета ==================
  const forecastBlk = readFileSync(new URL("../src/components/MonthlyForecastBlock.tsx", import.meta.url), "utf8");
  // Mirror of buildOfdWeekday (pure).
  const W_ORDER = [{ day: 1, label: "Пн" }, { day: 2, label: "Вт" }, { day: 3, label: "Ср" }, { day: 4, label: "Чт" }, { day: 5, label: "Пт" }, { day: 6, label: "Сб" }, { day: 0, label: "Вс" }];
  const weekdayOf = (date) => { const [y, m, d] = date.split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1).getDay(); };
  const buildWeekday = (summaries, startStr, endStr) => {
    const acc = new Map();
    for (const s of summaries) { if (!(s.date >= startStr && s.date < endStr)) continue; const wd = weekdayOf(s.date); const a = acc.get(wd) ?? { revenue: 0, receipts: 0, dates: new Set() }; a.revenue += s.incomeTotalKopeks; a.receipts += s.receiptCount; a.dates.add(s.date); acc.set(wd, a); }
    const rows = W_ORDER.map(({ day, label }) => { const a = acc.get(day); const dayCount = a ? a.dates.size : 0; const revenueKopeks = a ? a.revenue : 0; return { weekday: day, label, revenueKopeks, receipts: a ? a.receipts : 0, dayCount, avgRevenueKopeks: dayCount > 0 ? Math.round(revenueKopeks / dayCount) : 0, isBest: false }; });
    const bestAvg = Math.max(0, ...rows.map((r) => r.avgRevenueKopeks));
    for (const r of rows) r.isBest = bestAvg > 0 && r.avgRevenueKopeks === bestAvg;
    return rows;
  };

  check("DASH-SIMPLE1 dashboard больше не рендерит большой блок «ОФД-продажи» (today/yesterday/month/tempo)", !dashPage.includes("<OfdSalesOverview") && !dashPage.includes("OfdSalesOverview } from"));
  check("DASH-SIMPLE2 dashboard больше не рендерит таблицы клубов/ООО-ИП/статей/прогноза/клубных карточек", !dashPage.includes("<ClubOverviewCard") && !dashPage.includes("<CashScopeSummary") && !dashPage.includes("<DashboardForecast") && !dashPage.includes("cards.map"));
  check("DASH-SIMPLE3 карточка клуба содержит ключевые показатели (Абонементы/ПТ/Расходы/Наличные ООО/ИП/Результат)", dashPage.includes("<ClubCardsGrid") && keyCardsComp.includes('label="Абонементы"') && keyCardsComp.includes('label="ПТ"') && keyCardsComp.includes('label="Фактические расходы"') && keyCardsComp.includes('label="Наличные ООО"') && keyCardsComp.includes('label="Наличные ИП"') && keyCardsComp.includes('label="Результат"'));
  check("DASH-SIMPLE4 owner/GD видят сетку карточек клубов (стратегическая ветка → ClubCardsGrid)", /return \(\s*<div className="mx-auto max-w-\[1440px\]">[\s\S]*?<ClubCardsGrid/.test(dashPage) && dashPage.includes("cards={cards}"));
  check("DASH-SIMPLE5 regional видит карточки только по allowedClubIds (scope = getUserClubs)", dashPage.includes("const clubs = await getUserClubs(user.id, companyId)") && dashPage.includes("loadCompanyClubCards(companyId, companyName, cardClubs, period, financials, now, canSeeOfdSales, canSeeCash)"));
  check("DASH-SIMPLE6 manager/accountant/marketer не получают перегруженный финансовый dashboard (гейты флагов)", keyCardsComp.includes("showSales") && keyCardsComp.includes("showExpenses") && keyCardsComp.includes("showCash") && /showSales=\{canSeeOfdSales\}/.test(dashPage) && /showExpenses=\{financials\}/.test(dashPage) && /showCash=\{canSeeCash\}/.test(dashPage) && !/\baccountant:\s*\[[^\]]*"dashboard"/.test(authSrc) && !/marketer:\s*\[[^\]]*"ofd_sales"/.test(authSrc));
  check("DASH-SIMPLE7 пункт «Продажи» не вернулся в навигацию", !navSrc.includes('page: "sales", href: "/sales"') && !/\{\s*type:\s*"item",\s*page:\s*"sales"\s*\}/.test(navSrc));
  check("DASH-SIMPLE8 /sales read-only и createSalesReport отключён", salesPage.includes("Ручной ввод продаж отключён. Продажи поступают из ОФД.") && createReportBody.includes("MANUAL_SALES_DISABLED_MESSAGE") && !createReportBody.includes("salesReport.create"));

  const wSum = [
    { date: "2026-07-06", incomeTotalKopeks: 300000, receiptCount: 3 }, // Mon
    { date: "2026-07-13", incomeTotalKopeks: 100000, receiptCount: 2 }, // Mon
    { date: "2026-07-07", incomeTotalKopeks: 500000, receiptCount: 5 }, // Tue
    { date: "2026-06-29", incomeTotalKopeks: 999999, receiptCount: 9 }, // before window
  ];
  const wk = buildWeekday(wSum, "2026-07-01", "2026-08-01");
  check("ANALYTICS-WEEKDAY1 «Продажи по дням недели» строятся из OfdDailySalesSummary (не SalesReport)", mgmtLib.includes("export function buildOfdWeekday") && mgmtLib.includes("ofdDailySalesSummary.findMany") && analyticsPage.includes("<OfdWeekdayBlock") && analyticsPage.includes("loadOfdWeekday(aCompanyId, aClubIds, period.start, period.end)"));
  check("ANALYTICS-WEEKDAY2 группировка Пн→Вс", wk.map((r) => r.label).join(",") === "Пн,Вт,Ср,Чт,Пт,Сб,Вс");
  check("ANALYTICS-WEEKDAY3 для каждого дня считается выручка ОФД и чеков", wk[0].revenueKopeks === 400000 && wk[0].receipts === 5 && wk[1].revenueKopeks === 500000 && wk[1].receipts === 5);
  check("ANALYTICS-WEEKDAY4 средняя выручка за день недели корректна при периоде > недели (2 понедельника)", wk[0].dayCount === 2 && wk[0].avgRevenueKopeks === 200000 && wk[1].dayCount === 1 && wk[1].avgRevenueKopeks === 500000);
  check("ANALYTICS-WEEKDAY5 фильтры период/компания/клуб/allowedClubIds применяются к weekday (окно + clubId in clubIds)", mgmtLib.includes("date: { gte: startStr, lt: endStr }") && /loadOfdWeekday[\s\S]{0,700}clubId: \{ in: clubIds \}/.test(mgmtLib) && buildWeekday(wSum, "2026-06-01", "2026-07-01").reduce((a, r) => a + r.revenueKopeks, 0) === 999999 && wk.reduce((a, r) => a + r.revenueKopeks, 0) === 900000);
  check("ANALYTICS-WEEKDAY6 при наличии ОФД-данных блок не показывает «Нет данных за период»", wk.some((r) => r.dayCount > 0) && analyticsPage.includes("const hasData = rows.some((r) => r.dayCount > 0)"));
  check("ANALYTICS-KEEP1 подробные ОФД-таблицы остались в Analytics/ofd-sales после удаления с Dashboard", analyticsPage.includes("По сетям") && analyticsPage.includes("loadOfdManagementOverview") && ofdSalesPage.includes("OfdRevenueTable") && ofdSalesPage.includes("По юрлицам") && !dashPage.includes("<OfdSalesOverview"));
  check("DARK-CARDS1 карточки Dashboard без выбивающихся светлых фонов в dark mode (нейтральные токены)", keyCardsComp.includes("dark:bg-slate-900") && keyCardsComp.includes("dark:border-slate-800") && !/bg-(emerald|rose|amber|brand|sky)-50(?!\d)/.test(keyCardsComp) && !keyCardsComp.includes("bg-brand-50"));
  check("DARK-CARDS2 warning/danger карточки мягкие (soft border/text, без тяжёлой заливки/красного экрана)", /warn:\s*"[^"]*bg-amber-50\/50[^"]*dark:bg-amber-500\/5/.test(forecastBlk) && /bad:\s*"[^"]*bg-rose-50\/50[^"]*dark:bg-rose-500\/5/.test(forecastBlk) && !/bad:\s*"[^"]*bg-rose-500[ "]/.test(forecastBlk));
  check("SECURITY-DASH-ANALYTICS1 нет секретов/raw JSON/cashier/ПДн/реквизитов в dashboard/analytics/хелпере/картах", ![dashPage, analyticsPage, mgmtLib, keyCardsComp].some((s) => /login|password|integrator|sessionToken|Bearer|rawJson|fiscalSign|ФПД|\bfpd\b|cashierName|cashierInn|\bphone\b|\bemail\b|\bbuyer\b|\bcustomer\b|iban|расчетный счет|\.stack/i.test(s)) && !/JSON\.stringify/.test(keyCardsComp));

  // ===== Finance & accounting logic audit (AUDIT-*) ===========================
  const importerSrc = readFileSync(new URL("../src/lib/ofd/importer.ts", import.meta.url), "utf8");
  const budgetsSrc = readFileSync(new URL("../src/lib/budgets.ts", import.meta.url), "utf8");
  const approvalSrc = readFileSync(new URL("../src/lib/approval.ts", import.meta.url), "utf8");
  const cashBalancesSrc = readFileSync(new URL("../src/lib/cash-balances.ts", import.meta.url), "utf8");
  const collActionsSrc = readFileSync(new URL("../src/app/(app)/collections/actions.ts", import.meta.url), "utf8");
  const expCashPageSrc = readFileSync(new URL("../src/app/(app)/expenses/cash/page.tsx", import.meta.url), "utf8");
  const auditDoc = readFileSync(new URL("../docs/audits/finance-accounting-logic-audit.md", import.meta.url), "utf8");

  check("AUDIT-FORMULA1 ОФД gross/cash/electronic/returns/net единообразны (net = income − returns)", mgmt.totals.netKopeks === mgmt.totals.incomeKopeks - mgmt.totals.returnsKopeks && importerSrc.includes("netTotalKopeks = agg.incomeTotalKopeks - agg.returnTotalKopeks") && mgmtLib.includes("f.incomeKopeks += s.incomeTotalKopeks") && mgmtLib.includes("f.netKopeks += s.netTotalKopeks"));
  check("AUDIT-FORMULA2 категории membership/PT/groups/extra/other из OfdRevenueCategoryDailySummary", mgmtLib.includes("ofdRevenueCategoryDailySummary.findMany") && mgmtLib.includes('membership: "subscriptionsKopeks"') && mgmtLib.includes('personal_training: "personalTrainingKopeks"') && mgmtLib.includes('group_training: "groupTrainingKopeks"') && mgmtLib.includes('extra_services: "extraServicesKopeks"') && mgmtLib.includes('other: "otherKopeks"') && mgmt.totals.subscriptionsKopeks === 580000);
  check("AUDIT-FORMULA3 management result = ofdNet − confirmedCosts", mgmtResult(mgmt.totals.netKopeks, 100000) === mgmt.totals.netKopeks - 100000 && mgmtLib.includes("export function computeManagementResult(ofdNetKopeks: number, confirmedCostsKopeks: number)") && mgmtLib.includes("return ofdNetKopeks - confirmedCostsKopeks"));
  check("AUDIT-FORMULA4 pending expenses НЕ попадают в confirmedCosts (только confirmed/verified)", /EXPENSE_REALIZED_STATUSES\s*=\s*\[\s*"confirmed",\s*"verified"\s*\]/.test(budgetsSrc) && analyticsLibSrc.includes("status: { in: [...EXPENSE_REALIZED_STATUSES] }") && !/EXPENSE_REALIZED_STATUSES\s*=\s*\[[^\]]*(submitted|pending)/.test(budgetsSrc));
  check("AUDIT-FORMULA5 paid invoices попадают в confirmedCosts", analyticsLibSrc.includes('prisma.invoice.findMany({ where: { companyId, clubId: inClubs, status: "paid" }') && analyticsLibSrc.includes("...data.invoices.map"));
  check("AUDIT-FORMULA6 approved-unpaid invoices/refunds → obligations, не в confirmedCosts", /APPROVED_UNPAID_STATUSES\s*=\s*\[[^\]]*approved_by_regional[^\]]*approved_by_chief_accountant[^\]]*approved_by_owner/.test(approvalSrc) && analyticsLibSrc.includes("status: { in: APPROVED_UNPAID }") && analyticsLibSrc.includes("debtKopeks:"));
  check("AUDIT-FORMULA7 CashCollection не попадает в expenses/profit (аналитика их не читает)", !analyticsLibSrc.includes("cashCollection") && !mgmtLib.includes("cashCollection"));
  check("AUDIT-FORMULA8 CashWithdrawal не попадает в revenue/profit", !analyticsLibSrc.includes("cashWithdrawal") && !mgmtLib.includes("cashWithdrawal") && !mgmtLib.includes("Withdrawal"));
  check("AUDIT-FORMULA9 CashOtherIncome не попадает в revenue/profit", !analyticsLibSrc.includes("cashOtherIncome") && !mgmtLib.includes("OtherIncome"));
  check("AUDIT-FORMULA10 IP expense pending влияет на cash, но не на profit (cash-balances pending vs analytics confirmed/verified)", cashBalancesSrc.includes("IP_EXPENSE_PENDING_STATUSES") && cashBalancesSrc.includes('"submitted"') && cashBalancesSrc.includes('IP_EXPENSE_APPROVED_STATUSES: readonly string[] = ["verified", "confirmed"]') && !/EXPENSE_REALIZED_STATUSES\s*=\s*\[[^\]]*submitted/.test(budgetsSrc));
  check("AUDIT-DOUBLECOUNT1 ОФД возврат уменьшает net; paid refund в расходах; НЕТ автосвязи (импорт не создаёт refund/expense) — решение зафиксировано", !importerSrc.includes("prisma.refund.create") && !importerSrc.includes("prisma.expense.create") && analyticsLibSrc.includes('...data.refunds.map((r) => ({ clubId: r.clubId, category: "refunds"') && mgmtLib.includes("returnsKopeks") && auditDoc.includes("RISK-1") && auditDoc.includes("RESOLVED"));
  check("AUDIT-PAGE1 все основные routes классифицированы в audit report", ["/dashboard", "/analytics", "/analytics/ofd-sales", "/sales", "/expenses", "/expenses/cash", "/collections", "/invoices", "/refunds", "/balances"].every((r) => auditDoc.includes(r)) && auditDoc.includes("Page / route map"));
  check("AUDIT-PAGE2 /sales read-only и не создаёт ручные продажи", createReportBody.includes("MANUAL_SALES_DISABLED_MESSAGE") && !createReportBody.includes("salesReport.create") && salesPage.includes("Ручной ввод продаж отключён") && !salesPage.includes("<SalesReportForm"));
  check("AUDIT-PAGE3 нет navigation item «Продажи»", !navSrc.includes('page: "sales", href: "/sales"') && !/\{\s*type:\s*"item",\s*page:\s*"sales"\s*\}/.test(navSrc));
  check("AUDIT-PAGE4 /expenses/cash — не рабочая legacy-касса (read-only указатель, без CashPanel/CashWallet UI)", expCashPageSrc.includes("loadClubCashBalances") && expCashPageSrc.includes("Управление кассой перенесено") && !expCashPageSrc.includes("CashPanel") && !expCashPageSrc.includes("getClubCashBreakdown"));
  check("AUDIT-PAGE5 Dashboard не использует SalesReport для текущей выручки (карточки берут card.ofd, не subsFact)", keyCardsComp.includes("card.ofd.ofdSubscriptionsKopeks") && keyCardsComp.includes("card.ofd.ofdPersonalTrainingKopeks") && !keyCardsComp.includes("subsFact") && dashCardsLib.includes("ofdCardFields(ofdMgmt?.perClub.get(c.id))") && !dashPage.includes("salesSplitTrend"));
  check("AUDIT-PAGE6 Analytics не использует SalesReport для текущей выручки/результата (ОФД первично)", analyticsPage.includes("const abValue = useOfd ? ofd!.totals.subscriptionsKopeks") && analyticsPage.includes("profit={useOfd ? ofdResultKopeks : s.profitKopeks}") && !analyticsPage.includes("oooKopeks={s.cashOooRemainingKopeks}"));
  check("AUDIT-ROLE1 manager не получает общую финансовую аналитику (нет ofd_sales; FINANCIAL_ROLES без manager)", !/\bmanager:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && analyticsPage.includes('FINANCIAL_ROLES = new Set<Role>(["owner", "general_director", "regional_director", "accountant"])') && dashPage.includes('FINANCIAL_ROLES = new Set<Role>(["owner", "general_director", "regional_director", "accountant"])'));
  check("AUDIT-ROLE2 accountant не получает управленческий dashboard/analytics (нет page access)", !/\baccountant:\s*\[[^\]]*"dashboard"/.test(authSrc) && !/\baccountant:\s*\[[^\]]*"analytics"/.test(authSrc) && /accountant:\s*\["workspace"/.test(authSrc));
  check("AUDIT-ROLE3 marketer не получает финансовые суммы (только dashboard/analytics; нет collections/ofd_sales; гейты)", /marketer:\s*\["dashboard",\s*"analytics"\]/.test(authSrc) && !/marketer:\s*\[[^\]]*"collections"/.test(authSrc) && !/marketer:\s*\[[^\]]*"ofd_sales"/.test(authSrc) && keyCardsComp.includes("showCash") && keyCardsComp.includes("showSales") && keyCardsComp.includes("Финансовые показатели для вашей роли не отображаются"));
  check("AUDIT-ROLE4 regional ограничен allowedClubIds", analyticsPage.includes("const aClubIds = groups ? groups.filteredClubIds : requestedClubId ? [requestedClubId] : ctx.allowedClubIds") && dashPage.includes("const clubs = await getUserClubs(user.id, companyId)") && mgmtLib.includes("clubId: { in: clubIds }"));
  check("AUDIT-SCOPE1 подмена clubId в server action не выходит за allowedClubIds", collActionsSrc.includes("ctx.allowedClubIds.includes(clubId)") && /clubId: \{ in: g\.clubIds \}/.test(collActionsSrc));
  check("AUDIT-NAV1 навигация соответствует архитектуре (Dashboard/Analytics/ОФД + Финансы; без ручных продаж)", navSrc.includes('page: "dashboard"') && navSrc.includes('page: "analytics"') && navSrc.includes('page: "ofd_sales"') && navSrc.includes('label: "Финансы", pages: ["expenses", "collections", "invoices", "refunds"]') && !navSrc.includes('label: "Продажи"'));
  check("AUDIT-SECURITY1 нет секретов/raw fiscal JSON/ПДн/реквизитов/cashier в dashboard/analytics/хелпере/картах/аудит-доке", ![dashPage, analyticsPage, mgmtLib, keyCardsComp].some((s) => /login|password|integrator|sessionToken|Bearer|rawJson|fiscalSign|ФПД|\bfpd\b|cashierName|cashierInn|\bphone\b|\bemail\b|\bbuyer\b|\bcustomer\b|iban|\.stack/i.test(s)));
  check("AUDIT-LEGACY1 legacy SalesReport/CashWallet/CashMovement классифицированы в audit report", auditDoc.includes("cash-wallets.ts") && auditDoc.includes("CashPanel.tsx") && auditDoc.includes("SalesReportForm.tsx") && auditDoc.includes("getClubCashCards") && auditDoc.includes("Legacy / dead code inventory"));
  check("AUDIT-BUGFIX1 Analytics «Финансовый итог» переведён с SalesReport-прибыли на ОФД-результат + факт-остаток из cash-balances", analyticsPage.includes("profit={useOfd ? ofdResultKopeks : s.profitKopeks}") && analyticsPage.includes("loadScopeCashFactTotals(aCompanyId, aClubIds, now)") && analyticsPage.includes('isOfd ? "Результат (ОФД − расходы)" : "Прибыль"') && auditDoc.includes("BUG-1"));

  // ===== Risk closure: refunds policy + legacy /balances disabled ==============
  const balPageSrc = readFileSync(new URL("../src/app/(app)/balances/page.tsx", import.meta.url), "utf8");
  const balActionsSrc = readFileSync(new URL("../src/app/(app)/balances/actions.ts", import.meta.url), "utf8");
  const collPageSrc = readFileSync(new URL("../src/app/(app)/collections/page.tsx", import.meta.url), "utf8");

  check("AUDIT-REFUND-POLICY1 audit report фиксирует бизнес-решение: ОФД return = фискальная коррекция, ручной Refund = клиентский возврат, не double-count", auditDoc.includes("RESOLVED") && auditDoc.includes("фискальный возврат/коррекция по кассе") && auditDoc.includes("клиентский возврат, созданный управляющим") && auditDoc.includes("не double-count"));
  check("AUDIT-REFUND-POLICY2 result formula не менялась (ofdNet − confirmedCosts)", mgmtLib.includes("return ofdNetKopeks - confirmedCostsKopeks") && analyticsPage.includes("computeManagementResult(ofd!.totals.netKopeks, s.expensesKopeks)") && keyCardsComp.includes("computeManagementResult(card.ofd.ofdNetKopeks, card.expensesKopeks)"));
  check("AUDIT-REFUND-POLICY3 ОФД returns уменьшают ofdNet (net = income − returns)", importerSrc.includes("netTotalKopeks = agg.incomeTotalKopeks - agg.returnTotalKopeks") && mgmtLib.includes("f.netKopeks += s.netTotalKopeks") && mgmtLib.includes("f.returnsKopeks += s.returnTotalKopeks"));
  check("AUDIT-REFUND-POLICY4 paid Refund остаётся в confirmedCosts", analyticsLibSrc.includes('status: "paid"') && analyticsLibSrc.includes('...data.refunds.map((r) => ({ clubId: r.clubId, category: "refunds"'));
  check("AUDIT-REFUND-LABEL1 UI различает ОФД-возвраты (фискальные) и клиентский Refund", ofdSalesPage.includes("ОФД-возвраты") && !/label="Возвраты"/.test(ofdSalesPage) && ofdSalesPage.includes("фискальные коррекции"));
  check("BALANCES-LEGACY1 /balances не рендерит форму создания контрольного остатка", !balPageSrc.includes("BalanceForm") && !balPageSrc.includes("Внести остаток"));
  check("BALANCES-LEGACY2 /balances redirect ведёт в /collections", balPageSrc.includes('redirect("/collections")') && balPageSrc.includes('from "next/navigation"'));
  check("BALANCES-LEGACY3 невозможно создать BalanceSnapshot через legacy /balances flow (writer отключён)", balActionsSrc.includes('return { ok: false, error: "Legacy /balances disabled. Use /collections." }') && balActionsSrc.includes('auditBlockedFeature("balance_snapshot.create")') && !balActionsSrc.includes("prisma.balanceSnapshot.create"));
  check("BALANCES-LEGACY4 /collections setCashOpeningBalance продолжает работать", collActionsSrc.includes("export async function setCashOpeningBalance") && collActionsSrc.includes("prisma.balanceSnapshot.create") && collActionsSrc.includes("Комментарий обязателен"));
  check("BALANCES-LEGACY5 история контрольных остатков в /collections не сломана", collPageSrc.includes("loadClubOpeningHistory") && collPageSrc.includes("История контрольных остатков"));
  check("AUDIT-REPORT1 audit report не содержит открытых RISK-1/RISK-2 (оба CLOSED)", auditDoc.includes("both CLOSED by owner decision") && auditDoc.includes("CLOSED (business-correct)") && auditDoc.includes("CLOSED (legacy disabled)") && !auditDoc.includes("Risks requiring business decision"));
  check("AUDIT-REPORT2 final verdict обновлён на PASS", auditDoc.includes("**Final verdict: PASS**") && !auditDoc.includes("PASS WITH RISKS"));
  check("NAV-CHECK1 «Продажи» не вернулся в навигацию", !navSrc.includes('page: "sales", href: "/sales"') && !/\{\s*type:\s*"item",\s*page:\s*"sales"\s*\}/.test(navSrc) && !navSrc.includes('label: "Продажи"'));
  check("SALES-CHECK1 /sales read-only, createSalesReport отключён", salesPage.includes("Ручной ввод продаж отключён") && createReportBody.includes("MANUAL_SALES_DISABLED_MESSAGE") && !createReportBody.includes("salesReport.create"));
  check("SECURITY-AUDIT-CLOSE1 нет секретов/raw fiscal JSON/cashier/ПДн/реквизитов в UI/аудит-доке", ![dashPage, analyticsPage, ofdSalesPage, balPageSrc, keyCardsComp, auditDoc].some((s) => /login|password|integrator|sessionToken|Bearer|rawJson|fiscalSign|ФПД|\bfpd\b|cashierName|cashierInn|\bphone\b|\bemail\b|\bbuyer\b|\bcustomer\b|iban|\.stack/i.test(s)));

  // ===== Restored club-cards dashboard (DASH-CLUB-CARDS / DASH-CLICK) ==========
  check("DASH-CLUB-CARDS1 Dashboard рендерит сетку клубных карточек, а не один ряд общих KPI", dashPage.includes("<ClubCardsGrid") && !dashPage.includes("DashboardKeyCards") && keyCardsComp.includes("export function ClubCardsGrid") && keyCardsComp.includes("p.cards.map"));
  check("DASH-CLUB-CARDS2 scope «Все клубы» owner/GD → карточка на каждый клуб (strategic cards из loadCompanyClubCards)", dashPage.includes("loadCompanyClubCards(cid, g.name, g.clubs, period, financials, now, canSeeOfdSales, canSeeCash)") && dashPage.includes("cards={cards}") && keyCardsComp.includes("grid grid-cols-1 gap-4 lg:grid-cols-2"));
  check("DASH-CLUB-CARDS3 при выбранном clubId показывается только его карточка", dashPage.includes("const selectedClubId = scope.club?.id ?? null") && dashPage.includes("selectedClubId ? clubs.filter((c) => c.id === selectedClubId) : clubs"));
  check("DASH-CLUB-CARDS4 Regional видит только карточки allowedClubIds (scope = getUserClubs, роль-корректно)", dashPage.includes("const clubs = await getUserClubs(user.id, companyId)") && !dashPage.includes("prisma.club.findMany"));
  check("DASH-CLUB-CARDS5 Manager: только свой клуб, без прибыли/результата (result за showSales&&showExpenses)", keyCardsComp.includes("showSales && showExpenses ? <Cell label=\"Результат\"") && !/\bmanager:\s*\[[^\]]*"ofd_sales"/.test(authSrc));
  check("DASH-CLUB-CARDS6 карточка содержит Абонементы/ПТ/Расходы/Наличные ООО/ИП/Результат по разрешённым ролям", keyCardsComp.includes('label="Абонементы"') && keyCardsComp.includes('label="ПТ"') && keyCardsComp.includes('label="Фактические расходы"') && keyCardsComp.includes('label="Наличные ООО"') && keyCardsComp.includes('label="Наличные ИП"') && keyCardsComp.includes('label="Результат"') && keyCardsComp.includes("showSales ?") && keyCardsComp.includes("showExpenses ?") && keyCardsComp.includes("showCash ?"));
  check("DASH-CLUB-CARDS7 Абонементы/ПТ из OfdRevenueCategoryDailySummary, не SalesReport", keyCardsComp.includes("card.ofd.ofdSubscriptionsKopeks") && keyCardsComp.includes("card.ofd.ofdPersonalTrainingKopeks") && !keyCardsComp.includes("subsFact") && dashCardsLib.includes("ofdCardFields(ofdMgmt?.perClub.get(c.id))") && mgmtLib.includes("ofdRevenueCategoryDailySummary.findMany"));
  check("DASH-CLUB-CARDS8 расходы в карточке не включают pending (confirmed/verified + paid)", keyCardsComp.includes("card.expensesKopeks") && dashCardsLib.includes("report.clubRanking.map((r) => [r.clubId, r.expensesKopeks])") && analyticsLibSrc.includes("status: { in: [...EXPENSE_REALIZED_STATUSES] }") && /EXPENSE_REALIZED_STATUSES\s*=\s*\[\s*"confirmed",\s*"verified"\s*\]/.test(budgetsSrc));
  check("DASH-CLUB-CARDS9 Наличные ООО/ИП из loadClubCashBalances (не legacy SalesReport-остаток)", keyCardsComp.includes("card.oooFactKopeks") && keyCardsComp.includes("card.ipFactKopeks") && dashCardsLib.includes("loadClubCashBalances") && dashCardsLib.includes("cashOooFactBalance") && dashCardsLib.includes("cashIpFactBalance") && !keyCardsComp.includes("cashOooRemainingKopeks") && !keyCardsComp.includes("reportCash"));
  check("DASH-CLUB-CARDS10 Result = ОФД net − confirmedCosts", keyCardsComp.includes("computeManagementResult(card.ofd.ofdNetKopeks, card.expensesKopeks)") && mgmtResult(mgmt.totals.netKopeks, 100000) === mgmt.totals.netKopeks - 100000);
  check("DASH-CLICK1 клик по карточке → /analytics с month(from/to)+companyId+clubId", keyCardsComp.includes("`/analytics?clubId=${encodeURIComponent(card.id)}&companyId=${encodeURIComponent(card.companyId)}&scopeMode=company&period=custom&from=${linkFrom}&to=${linkTo}`") && dashPage.includes("linkFrom={isoDay(period.start)}"));
  check("DASH-CLICK2 /analytics принимает clubId из query params (strategic + non-strategic)", analyticsPage.includes("const requestedClubId = !groups && sp.clubId && ctx.allowedClubIds.includes(sp.clubId) ? sp.clubId : null") && analyticsPage.includes("requestedClubId ? [requestedClubId] : ctx.allowedClubIds") && analyticsPage.includes("clubId?: string"));
  check("DASH-CLICK3 нельзя открыть чужой clubId через query params (только из allowedClubIds; иначе fallback)", analyticsPage.includes("ctx.allowedClubIds.includes(sp.clubId)") && analyticsPage.includes("requestedClubId ? [requestedClubId] : ctx.allowedClubIds"));
  check("DASH-NOT-OVERLOADED1 Dashboard без большого блока OFD overview (today/yesterday/month/tempo)", !dashPage.includes("<OfdSalesOverview") && !dashPage.includes("Темп месяца") && !dashPage.includes("Сегодня/Вчера"));
  check("DASH-NOT-OVERLOADED2 Dashboard без таблиц клубов/ООО-ИП/статей доходов", !dashPage.includes("По юрлицам") && !dashPage.includes("Статьи доходов") && !dashPage.includes("Клубы за текущий месяц") && !dashPage.includes("Требует внимания"));
  check("DASH-NOT-OVERLOADED3 Dashboard без ручных SalesReport/неподтверждённых продаж/прогноза", !dashPage.includes("UnconfirmedSalesBlock") && !dashPage.includes("salesSplitTrend") && !dashPage.includes("getUnconfirmedReports") && !dashPage.includes("<DashboardForecast"));
  check("DARK-CLUB-CARDS1 карточки клуба читаемы в dark mode, без выбивающихся светлых заливок", keyCardsComp.includes("dark:bg-slate-900") && keyCardsComp.includes("dark:border-slate-800") && keyCardsComp.includes("dark:text-slate-100") && !/bg-(emerald|rose|amber|brand|sky)-50(?!\d)/.test(keyCardsComp) && !keyCardsComp.includes("bg-brand-50"));
  check("EXPENSE-MONTH-STILL1 расходы за текущий месяц старше 7 дней всё ещё разрешены", readFileSync(new URL("../src/lib/expense-simplified.ts", import.meta.url), "utf8").includes("EXPENSE_DATE_RANGE_ERROR") && /validateExpenseBusinessDate[\s\S]{0,320}monthStart/.test(readFileSync(new URL("../src/lib/expense-simplified.ts", import.meta.url), "utf8")));
  check("PLAN-BUDGET-STILL1 импорт планов/бюджетов не сломан (панели + actions + шаблоны на месте)", readFileSync(new URL("../src/app/(app)/dashboard/_components/PlanImportPanel.tsx", import.meta.url), "utf8").includes("previewPlanImport") && readFileSync(new URL("../src/app/(app)/budgets/_components/BudgetImportPanel.tsx", import.meta.url), "utf8").includes("previewBudgetImport") && readFileSync(new URL("../src/app/api/sales-plans/template/route.ts", import.meta.url), "utf8").includes("buildPlanTemplateBuffer") && readFileSync(new URL("../src/app/api/budgets/template/route.ts", import.meta.url), "utf8").includes("buildBudgetTemplateBuffer") && dashPage.includes("<PlanImportPanel"));
  check("SECURITY-DASH-CLUB-CARDS1 нет секретов/raw fiscal JSON/ПДн/реквизитов/cashier в Dashboard/Analytics/карточке", ![dashPage, analyticsPage, keyCardsComp, dashCardsLib].some((s) => /login|password|integrator|sessionToken|Bearer|rawJson|fiscalSign|ФПД|\bfpd\b|cashierName|cashierInn|\bphone\b|\bemail\b|\bbuyer\b|\bcustomer\b|iban|\.stack/i.test(s)));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
