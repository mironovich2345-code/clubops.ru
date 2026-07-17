// Server-only Taxcom sales importer. Idempotent (dedupe by dedupeKey), day-batched
// for backfill, per-KKT error isolation (one bad register never fails the rest),
// and never stores buyer PII / items / raw JSON. Recomputes OfdDailySalesSummary
// from the imported fingerprints so cards are always consistent.
import { prisma } from "@/lib/prisma";
import { decryptOfdSecret } from "@/lib/ofd/crypto";
import { createTaxcomClient, toTaxcomDayRange, type FetchImpl, type TaxcomClient } from "@/lib/ofd/taxcom/client";
import { normalizeDocumentsWithStats } from "@/lib/ofd/taxcom/adapter";
import { isCurrentAccountValid } from "@/lib/ofd/contract";
import { categorizeItem, type OfdCategoryRuleLike } from "@/lib/ofd/revenue";
import type { NormalizedOfdReceipt, OfdConnectionConfig } from "@/lib/ofd/types";

export type ImportMode = "manual_day" | "manual_period" | "backfill_july" | "daily" | "auto_daily" | "sync_now";

export type ImportParams = {
  connectionId: string;
  dateFrom: string; // "YYYY-MM-DD"
  dateTo: string; // "YYYY-MM-DD"
  mode: ImportMode;
  requestedByUserId?: string | null;
  // Injectable for tests — never hits the real Taxcom API in CI.
  clientFactory?: (cfg: OfdConnectionConfig, opts?: { fetchImpl?: FetchImpl }) => TaxcomClient;
  fetchImpl?: FetchImpl;
};

export type ImportResult =
  | { ok: true; syncRunId: string; found: number; imported: number; skipped: number; status: string; totalIncomeKopeks: number; totalReturnKopeks: number }
  | { ok: false; safeCode: string; safeMessage?: string; syncRunId?: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive list of "YYYY-MM-DD" days between from and to (bounded to 366). */
export function eachDay(from: string, to: string): string[] {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return [];
  const out: string[] = [];
  let cur = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  let guard = 0;
  while (cur.getTime() <= end.getTime() && guard < 366) {
    out.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 86_400_000);
    guard += 1;
  }
  return out;
}

export function buildSummaryKey(companyId: string, clubId: string, legalEntityId: string | null, provider: string, date: string): string {
  return `${companyId}:${clubId}:${legalEntityId ?? "none"}:${provider}:${date}`;
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Import Taxcom sales for [dateFrom, dateTo]. Authorization is the caller's
 * responsibility (the server action checks owner / general_director). Refuses to
 * run if another import is already in progress for the same connection.
 */
export async function importTaxcomSalesForPeriod(params: ImportParams): Promise<ImportResult> {
  const { connectionId, dateFrom, dateTo, mode } = params;
  if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo) || dateFrom > dateTo) {
    return { ok: false, safeCode: "bad_period" };
  }

  const connection = await prisma.ofdConnection.findUnique({ where: { id: connectionId } });
  if (!connection || !connection.isActive) return { ok: false, safeCode: "connection_not_found" };

  // Concurrency guard: one active run per connection.
  const inFlight = await prisma.ofdSyncRun.findFirst({
    where: { connectionId, status: { in: ["pending", "running"] } },
    select: { id: true },
  });
  if (inFlight) return { ok: false, safeCode: "already_running" };

  const cfg: OfdConnectionConfig = {
    id: connection.id,
    companyId: connection.companyId,
    legalEntityId: connection.legalEntityId,
    provider: connection.provider,
    serverBaseUrl: connection.serverBaseUrl,
    authType: connection.authType,
    contractNumber: connection.contractNumber,
    login: decryptOfdSecret(connection.loginEncrypted),
    password: decryptOfdSecret(connection.passwordEncrypted),
    integrationToken: decryptOfdSecret(connection.integrationTokenEncrypted),
    integratorId: decryptOfdSecret(connection.integratorIdEncrypted),
  };

  const run = await prisma.ofdSyncRun.create({
    data: {
      connectionId, companyId: connection.companyId, legalEntityId: connection.legalEntityId,
      mode, dateFrom, dateTo, status: "running", requestedByUserId: params.requestedByUserId ?? null,
      startedAt: new Date(),
    },
  });

  // Select ACTIVE cash registers by the connection SCOPE (company + legal entity +
  // provider), NOT by connectionId. A mapping created against an earlier connection
  // row (recreated/re-saved → new id) keeps its companyId/legalEntityId but a stale
  // connectionId; filtering on connectionId then silently found 0 mappings and the
  // import finished as success 0/0/0 without ever reaching ShiftList.
  const mappings = await prisma.ofdCashRegisterMapping.findMany({
    where: {
      companyId: connection.companyId,
      provider: connection.provider,
      isActive: true,
      activeMappingKey: { not: null },
      ...(connection.legalEntityId ? { legalEntityId: connection.legalEntityId } : {}),
    },
  });

  // SAFE debug: ids + counts only (no login/password/Integrator-ID/SessionToken).
  console.warn(`[ofd] mapping_debug connectionId=${connection.id} companyId=${connection.companyId} legalEntityId=${connection.legalEntityId ?? "null"} provider=${connection.provider} activeMappingCount=${mappings.length}`);

  // No active cash registers → NOT a silent success. Fail with a safe reason so the
  // admin knows to (re)map a касса for this подключение/юрлицо.
  if (mappings.length === 0) {
    await recordSyncError(run.id, connection.id, connection.companyId, null, null, "mapping_check", "ofd_no_active_cash_register_mappings", "Нет активных касс ОФД для выбранного подключения/юрлица.");
    await prisma.ofdSyncRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), safeErrorCode: "ofd_no_active_cash_register_mappings", safeErrorMessage: "Нет активных касс ОФД для выбранного подключения/юрлица." },
    });
    return { ok: false, safeCode: "ofd_no_active_cash_register_mappings", safeMessage: "Нет активных касс ОФД для выбранного подключения/юрлица.", syncRunId: run.id };
  }

  const client = (params.clientFactory ?? createTaxcomClient)(cfg, { fetchImpl: params.fetchImpl });
  const days = eachDay(dateFrom, dateTo);

  // Account guard: ShiftList/kktstat operate on the CURRENT ЛК (currentSession).
  // If the connection targets a specific договор but the API session is open in a
  // DIFFERENT ЛК, the target KKT resolves to 3103 "ККТ не найдена". Fail fast with
  // a clear reason instead of misreporting a per-KKT "not found". (AccountList also
  // performs Login lazily.) A failed AccountList here is not conclusive → proceed.
  if (connection.contractNumber?.trim()) {
    const accounts = await client.listAccounts();
    if (accounts.ok && !isCurrentAccountValid(accounts.data.currentAgreementNumber, connection.contractNumber, accounts.data.records.map((r) => r.agreementNumber))) {
      await recordSyncError(run.id, connection.id, connection.companyId, null, null, "account_check", "taxcom_wrong_current_account", "Текущий ЛК Такском не соответствует выбранному договору.");
      await prisma.ofdSyncRun.update({
        where: { id: run.id },
        data: { status: "failed", finishedAt: new Date(), safeErrorCode: "taxcom_wrong_current_account", safeErrorMessage: "Текущий ЛК Такском не соответствует выбранному договору." },
      });
      return { ok: false, safeCode: "taxcom_wrong_current_account", safeMessage: "Текущий ЛК Такском не соответствует выбранному договору.", syncRunId: run.id };
    }
  }

  // Load company category rules once — DB rules take priority over the in-code
  // fallback defaults. Never touched again per KKT.
  const dbRules: OfdCategoryRuleLike[] = await prisma.ofdRevenueCategoryRule.findMany({
    where: { companyId: connection.companyId, isActive: true },
    select: { id: true, legalEntityId: true, categoryCode: true, categoryName: true, matchType: true, pattern: true, normalizedPattern: true, priority: true, isActive: true, createdAt: true },
  });

  let found = 0, imported = 0, skipped = 0, kktFailures = 0;
  let incomeTotal = 0, returnTotal = 0;
  // SAFE aggregate item diagnostics (counts only — no names / no raw / no ФПД).
  const itemStats = { itemDocumentsSeen: 0, itemRowsSeen: 0, itemRowsSaved: 0, itemRowsSkipped: 0, categoryOtherCount: 0 };
  const touched = new Set<string>(); // `${clubId}|${legalEntityId ?? ""}|${day}`

  for (const m of mappings) {
    const legal = m.legalEntityId ?? connection.legalEntityId ?? null;
    const perKktReceipts: NormalizedOfdReceipt[] = [];
    let kktFailed = false;
    // SAFE aggregate counters (no document content) for the "documents but no
    // receipts" diagnostic — catches a broken parser/query silently importing 0.
    const stats = { shiftCount: 0, shiftReceiptCount: 0, documentCount: 0, normalizedReceiptCount: 0, serviceSkipped: 0, unsupportedSkipped: 0, invalidSkipped: 0 };

    for (const day of days) {
      // SAFE debug: confirms the importer actually reaches Taxcom for this KKT/day.
      const dbgRange = toTaxcomDayRange(day);
      console.warn(`[ofd] list_shifts_call fn=${m.fnNumber} date=${day} begin=${dbgRange.begin} end=${dbgRange.end}`);
      const shifts = await client.listShifts(m.fnNumber, day, day);
      if (!shifts.ok) {
        kktFailed = true;
        await recordSyncError(run.id, connection.id, connection.companyId, m.clubId, m.fnNumber, "list_shifts", shifts.safeCode, shifts.safeMessage);
        continue; // try other days; do not abandon the whole KKT
      }
      if (shifts.data.length === 0) {
        // Empty day is normal (not an error), but log the SAFE aggregate so a bad
        // date window is diagnosable (no token / no raw response). This is what
        // reveals a begin/end problem: the exact range we asked Taxcom for.
        const range = toTaxcomDayRange(day);
        console.warn(`[ofd] list_shifts_debug fn=${m.fnNumber} date=${day} begin=${range.begin} end=${range.end} shiftCount=0`);
      }
      for (const shift of shifts.data) {
        stats.shiftCount += 1;
        stats.shiftReceiptCount += Math.max(0, shift.receiptCount ?? 0);
        const docs = await client.listDocumentsByShift(m.fnNumber, shift.shiftNumber);
        if (!docs.ok) {
          kktFailed = true;
          await recordSyncError(run.id, connection.id, connection.companyId, m.clubId, m.fnNumber, "list_documents", docs.safeCode, docs.safeMessage);
          continue;
        }
        const norm = normalizeDocumentsWithStats(docs.data);
        stats.documentCount += norm.documentCount;
        stats.normalizedReceiptCount += norm.receipts.length;
        stats.serviceSkipped += norm.serviceSkipped;
        stats.unsupportedSkipped += norm.unsupportedSkipped;
        stats.invalidSkipped += norm.invalidSkipped;
        perKktReceipts.push(...norm.receipts);
      }
    }
    // Diagnostic: Taxcom declared receipts (shift.receiptCount) or returned
    // documents, but NONE became a sales receipt → a parser/filter problem, not a
    // truly empty shift. Never blocks other KKTs; surfaces a SAFE aggregate reason.
    const noReceiptsProblem = stats.normalizedReceiptCount === 0 && (stats.shiftReceiptCount > 0 || stats.documentCount > 0);
    if (noReceiptsProblem) {
      const agg = `shifts=${stats.shiftCount} shiftReceiptCount=${stats.shiftReceiptCount} documents=${stats.documentCount} normalized=0 service=${stats.serviceSkipped} unsupported=${stats.unsupportedSkipped} invalid=${stats.invalidSkipped}`;
      await recordSyncError(run.id, connection.id, connection.companyId, m.clubId, m.fnNumber, "normalize_documents", "taxcom_no_receipts_after_filter", `Такском вернул смены/документы, но CLUB-OPS не распознал чеки продаж. ${agg}`);
      // Safe, aggregate-only log (no raw JSON / no fiscal docs / no secrets / no PII).
      console.warn(`[ofd] taxcom_no_receipts_after_filter fn=${m.fnNumber} ${agg}`);
    }
    if (kktFailed || noReceiptsProblem) kktFailures += 1;

    // Persist this KKT's receipts idempotently (dedupe within batch + vs DB).
    const byKey = new Map<string, NormalizedOfdReceipt>();
    for (const r of perKktReceipts) byKey.set(r.dedupeKey, r);
    const keys = [...byKey.keys()];
    found += keys.length;
    if (keys.length === 0) continue;

    const existing = await prisma.ofdReceiptImport.findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true } });
    const existingSet = new Set(existing.map((e) => e.dedupeKey));
    const fresh = keys.filter((k) => !existingSet.has(k)).map((k) => byKey.get(k)!);
    skipped += keys.length - fresh.length;

    if (fresh.length > 0) {
      await prisma.ofdReceiptImport.createMany({
        data: fresh.map((r) => ({
          connectionId, companyId: connection.companyId, clubId: m.clubId, legalEntityId: legal,
          provider: connection.provider, fnNumber: r.fnNumber, shiftNumber: r.shiftNumber,
          fiscalDocumentNumber: r.fiscalDocumentNumber, fiscalSign: r.fiscalSign, operationType: r.operationType,
          receiptDate: r.receiptDate, totalKopeks: r.totalKopeks, cashKopeks: r.cashKopeks,
          electronicKopeks: r.electronicKopeks, dedupeKey: r.dedupeKey, source: "taxcom", syncRunId: run.id,
        })),
      });
      imported += fresh.length;
    }
    for (const r of byKey.values()) {
      if (r.operationType === "income") incomeTotal += r.totalKopeks; else returnTotal += r.totalKopeks;
      touched.add(`${m.clubId}|${legal ?? ""}|${dayOf(r.receiptDate)}`);
    }

    // Persist SAFE nomenclature lines (if the response carried any) for ALL of this
    // KKT's receipts — fresh and already-imported (backfill). Idempotent by itemKey.
    // Item failures never fail the receipt import (receipts are already saved).
    try {
      const idRows = await prisma.ofdReceiptImport.findMany({ where: { dedupeKey: { in: keys } }, select: { id: true, dedupeKey: true } });
      const idByKey = new Map(idRows.map((r) => [r.dedupeKey, r.id]));
      await persistReceiptItems([...byKey.values()], idByKey, { companyId: connection.companyId, clubId: m.clubId, legal, provider: connection.provider }, dbRules, itemStats);
    } catch {
      await recordSyncError(run.id, connection.id, connection.companyId, m.clubId, m.fnNumber, "save_items", "ofd_item_save_failed", "Не удалось сохранить позиции чека (чеки импортированы).");
    }
  }

  // Recompute affected daily + revenue-category summaries from the stored rows.
  for (const key of touched) {
    const [clubId, legalRaw, day] = key.split("|");
    await recomputeDailySummary(connection.companyId, clubId, legalRaw || null, connection.provider, day);
    await recomputeRevenueCategorySummaries(connection.companyId, clubId, legalRaw || null, connection.provider, day);
  }

  // SAFE item diagnostics (counts only). "items unavailable" is NOT an error — the
  // production DocumentList often returns receipt sums without positions.
  console.warn(`[ofd] items_debug itemDocumentsSeen=${itemStats.itemDocumentsSeen} itemRowsSeen=${itemStats.itemRowsSeen} itemRowsSaved=${itemStats.itemRowsSaved} itemRowsSkipped=${itemStats.itemRowsSkipped} categoryOtherCount=${itemStats.categoryOtherCount}`);
  if (found > 0 && itemStats.itemRowsSeen === 0) {
    console.warn(`[ofd] items_unavailable receipts=${found} — Taxcom returned receipt totals but no positions.`);
  }

  const status = kktFailures === 0 ? "success" : imported > 0 || mappings.length > kktFailures ? "partial_failed" : "failed";
  await prisma.ofdSyncRun.update({
    where: { id: run.id },
    data: { status, finishedAt: new Date(), foundReceipts: found, importedReceipts: imported, skippedReceipts: skipped, totalIncomeKopeks: incomeTotal, totalReturnKopeks: returnTotal },
  });
  await prisma.ofdConnection.update({ where: { id: connection.id }, data: { lastSyncAt: new Date() } });

  return { ok: true, syncRunId: run.id, found, imported, skipped, status, totalIncomeKopeks: incomeTotal, totalReturnKopeks: returnTotal };
}

async function recordSyncError(syncRunId: string, connectionId: string, companyId: string, clubId: string | null, fnNumber: string | null, stage: string, safeCode: string, safeMessage?: string): Promise<void> {
  await prisma.ofdSyncError.create({
    data: { syncRunId, connectionId, companyId, clubId, fnNumber, stage, safeCode, safeMessage: safeMessage ? safeMessage.slice(0, 200) : null },
  });
}

/** Recompute one (club, legalEntity, date) summary from OfdReceiptImport. */
export async function recomputeDailySummary(companyId: string, clubId: string, legalEntityId: string | null, provider: string, date: string): Promise<void> {
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const rows = await prisma.ofdReceiptImport.findMany({
    where: { companyId, clubId, provider, legalEntityId: legalEntityId ?? null, receiptDate: { gte: dayStart, lt: dayEnd } },
    select: { operationType: true, totalKopeks: true, cashKopeks: true, electronicKopeks: true },
  });
  const agg = {
    incomeTotalKopeks: 0, incomeCashKopeks: 0, incomeElectronicKopeks: 0,
    returnTotalKopeks: 0, returnCashKopeks: 0, returnElectronicKopeks: 0,
    receiptCount: 0, returnReceiptCount: 0,
  };
  for (const r of rows) {
    if (r.operationType === "income") {
      agg.incomeTotalKopeks += r.totalKopeks; agg.incomeCashKopeks += r.cashKopeks; agg.incomeElectronicKopeks += r.electronicKopeks; agg.receiptCount += 1;
    } else {
      agg.returnTotalKopeks += r.totalKopeks; agg.returnCashKopeks += r.cashKopeks; agg.returnElectronicKopeks += r.electronicKopeks; agg.returnReceiptCount += 1;
    }
  }
  const netTotalKopeks = agg.incomeTotalKopeks - agg.returnTotalKopeks;
  const summaryKey = buildSummaryKey(companyId, clubId, legalEntityId, provider, date);
  await prisma.ofdDailySalesSummary.upsert({
    where: { summaryKey },
    create: { companyId, clubId, legalEntityId: legalEntityId ?? null, provider, date, summaryKey, ...agg, netTotalKopeks },
    update: { ...agg, netTotalKopeks },
  });
}

type ItemStats = { itemDocumentsSeen: number; itemRowsSeen: number; itemRowsSaved: number; itemRowsSkipped: number; categoryOtherCount: number };

/** Persist SAFE nomenclature lines for a set of receipts. Categorizes each line,
 * writes only safe fields (name/numbers/category), and is idempotent by itemKey
 * ("<dedupeKey>:<lineIndex>") so a re-import (or backfill of a skipped receipt)
 * never creates duplicates. Never stores raw JSON / buyer PII. */
async function persistReceiptItems(
  receipts: NormalizedOfdReceipt[],
  idByDedupeKey: Map<string, string>,
  ctx: { companyId: string; clubId: string; legal: string | null; provider: string },
  dbRules: OfdCategoryRuleLike[],
  itemStats: ItemStats,
): Promise<void> {
  const rows: Array<Record<string, unknown>> = [];
  for (const r of receipts) {
    const receiptImportId = idByDedupeKey.get(r.dedupeKey);
    if (!receiptImportId) continue;
    if (r.itemsPresent) itemStats.itemDocumentsSeen += 1;
    const items = r.items ?? [];
    itemStats.itemRowsSeen += items.length;
    items.forEach((it, lineIndex) => {
      const cat = categorizeItem(it.normalizedName, dbRules, ctx.legal);
      if (cat.code === "other") itemStats.categoryOtherCount += 1;
      rows.push({
        receiptImportId, companyId: ctx.companyId, clubId: ctx.clubId, legalEntityId: ctx.legal, provider: ctx.provider,
        date: dayOf(r.receiptDate), fnNumber: r.fnNumber, fdNumber: r.fiscalDocumentNumber, fiscalSign: r.fiscalSign,
        lineIndex, itemName: it.name, normalizedItemName: it.normalizedName, quantityMilli: it.quantityMilli,
        priceKopeks: it.priceKopeks, totalKopeks: it.totalKopeks, operationType: r.operationType,
        revenueCategoryCode: cat.code, revenueCategoryName: cat.name, categoryRuleId: cat.ruleId,
        itemKey: `${r.dedupeKey}:${lineIndex}`,
      });
    });
  }
  if (rows.length === 0) return;
  const itemKeys = rows.map((r) => r.itemKey as string);
  const existing = await prisma.ofdReceiptItem.findMany({ where: { itemKey: { in: itemKeys } }, select: { itemKey: true } });
  const existingSet = new Set(existing.map((e) => e.itemKey));
  const fresh = rows.filter((r) => !existingSet.has(r.itemKey as string));
  itemStats.itemRowsSkipped += rows.length - fresh.length;
  if (fresh.length > 0) {
    await prisma.ofdReceiptItem.createMany({ data: fresh as never });
    itemStats.itemRowsSaved += fresh.length;
  }
}

/** Recompute the per-category daily summary for one (club, legalEntity, date) from
 * OfdReceiptItem. Idempotent: clears the day's category rows then recreates the
 * present categories. receiptCount is unique receipts within the category. */
export async function recomputeRevenueCategorySummaries(companyId: string, clubId: string, legalEntityId: string | null, provider: string, date: string): Promise<void> {
  const items = await prisma.ofdReceiptItem.findMany({
    where: { companyId, clubId, provider, legalEntityId: legalEntityId ?? null, date },
    select: { revenueCategoryCode: true, revenueCategoryName: true, operationType: true, totalKopeks: true, receiptImportId: true },
  });
  const byCat = new Map<string, { name: string; income: number; ret: number; itemCount: number; receipts: Set<string> }>();
  for (const it of items) {
    let c = byCat.get(it.revenueCategoryCode);
    if (!c) { c = { name: it.revenueCategoryName, income: 0, ret: 0, itemCount: 0, receipts: new Set() }; byCat.set(it.revenueCategoryCode, c); }
    if (it.operationType === "income") c.income += it.totalKopeks; else c.ret += it.totalKopeks;
    c.itemCount += 1;
    c.receipts.add(it.receiptImportId);
  }
  await prisma.ofdRevenueCategoryDailySummary.deleteMany({ where: { companyId, clubId, provider, legalEntityId: legalEntityId ?? null, date } });
  const rows = [...byCat.entries()].map(([code, c]) => ({
    companyId, clubId, legalEntityId: legalEntityId ?? null, provider, date, categoryCode: code, categoryName: c.name,
    incomeTotalKopeks: c.income, returnTotalKopeks: c.ret, netTotalKopeks: c.income - c.ret, itemCount: c.itemCount,
    receiptCount: c.receipts.size, summaryKey: `${companyId}:${clubId}:${legalEntityId ?? "none"}:${provider}:${date}:${code}`,
  }));
  if (rows.length > 0) await prisma.ofdRevenueCategoryDailySummary.createMany({ data: rows });
}
