// Server-only Astral.ОФД sales importer. Fetches fiscal documents via
// POST /documents.tickets (paginated), normalizes them with the SHARED receipt model,
// keeps only revenue documents (sale / sale-return) and books them through the SAME
// persistence + summary pipeline as Taxcom (OfdReceiptImport → OfdReceiptItem →
// categories → OfdDailySalesSummary → OfdRevenueCategoryDailySummary). Idempotent by
// dedupeKey, so re-import of the same / overlapping period never creates duplicates.
// A dryRun (preview) fetches + normalizes but writes NOTHING.
import { prisma } from "@/lib/prisma";
import {
  persistReceiptItems,
  recordSyncError,
  recomputeDailySummary,
  recomputeRevenueCategorySummaries,
  type ItemStats,
} from "@/lib/ofd/importer";
import type { OfdCategoryRuleLike } from "@/lib/ofd/revenue";
import type { NormalizedOfdReceipt } from "@/lib/ofd/types";
import {
  createAstralClient,
  type AstralClient,
  type AstralClientOpts,
} from "@/lib/ofd/astral/client";
import { decryptOfdSecret } from "@/lib/ofd/crypto";
import { fetchReceiptsPage } from "@/lib/ofd/astral/api";
import {
  normalizeAstralDocument,
  toNormalizedReceipt,
  clubDayRangeUnix,
  type AstralNormalizedDoc,
} from "@/lib/ofd/astral/receipts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 500; // guard against a non-terminating pagination loop
const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

export type AstralImportMode = "manual_day" | "manual_period" | "daily" | "auto_daily" | "sync_now" | "preview";

export type AstralImportParams = {
  connectionId: string;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string; // YYYY-MM-DD
  mode: AstralImportMode;
  requestedByUserId?: string | null;
  dryRun?: boolean; // preview: fetch + normalize, NO writes, no OfdSyncRun row
  /** Restrict to specific ФН (e.g. preview one KKT). */
  onlyKktFnNumbers?: string[];
  /** operationTypes request filter; default sales + returns; pass null for no filter. */
  operationTypesFilter?: string[] | null;
  pageSize?: number;
  maxPages?: number;
  // Injectable for tests — never hits the real Astral API in CI.
  clientFactory?: (apiKey: string, connectionId: string) => AstralClient;
  clientOpts?: AstralClientOpts;
};

export type AstralImportDiagnostics = {
  pagesProcessed: number;
  documentsReceived: number;
  salesCount: number;
  returnCount: number;
  expenseCount: number;
  serviceCount: number;
  unknownDocuments: number;
  foreignSkipped: number; // documents whose ФН is not mapped to a club
  positionsCount: number;
  paymentMismatchCount: number;
  cashKopeks: number;
  ecashKopeks: number;
  totalIncomeKopeks: number;
  totalReturnKopeks: number;
};

export type AstralImportResult =
  | { ok: true; syncRunId: string | null; found: number; imported: number; skipped: number; status: string; totalIncomeKopeks: number; totalReturnKopeks: number; diagnostics: AstralImportDiagnostics }
  | { ok: false; safeCode: string; safeMessage?: string; syncRunId?: string | null; diagnostics?: AstralImportDiagnostics };

function emptyDiagnostics(): AstralImportDiagnostics {
  return { pagesProcessed: 0, documentsReceived: 0, salesCount: 0, returnCount: 0, expenseCount: 0, serviceCount: 0, unknownDocuments: 0, foreignSkipped: 0, positionsCount: 0, paymentMismatchCount: 0, cashKopeks: 0, ecashKopeks: 0, totalIncomeKopeks: 0, totalReturnKopeks: 0 };
}

type EnrichedReceipt = { receipt: NormalizedOfdReceipt; clubId: string; legal: string | null };

/**
 * Import Astral sales for [dateFrom, dateTo]. Authorization is the caller's
 * responsibility. Refuses if another run is already in progress for the connection.
 * dryRun=true performs the same fetch/normalize but persists nothing (Step 5 preview).
 */
export async function importAstralSalesForPeriod(params: AstralImportParams): Promise<AstralImportResult> {
  const { connectionId, dateFrom, dateTo, mode } = params;
  if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo) || dateFrom > dateTo) {
    return { ok: false, safeCode: "bad_period" };
  }
  const dryRun = params.dryRun === true;

  const connection = await prisma.ofdConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.provider !== "astral") return { ok: false, safeCode: "connection_not_found" };
  if (!dryRun && !connection.isActive) return { ok: false, safeCode: "connection_not_found" };

  const organizationId = connection.externalOrganizationId;
  if (!organizationId) return { ok: false, safeCode: "astral_no_organization", safeMessage: "Не выбрана организация Астрал (шаг 2)." };

  // Concurrency guard (writes only): one active run per connection.
  if (!dryRun) {
    const inFlight = await prisma.ofdSyncRun.findFirst({ where: { connectionId, status: { in: ["pending", "running"] } }, select: { id: true } });
    if (inFlight) return { ok: false, safeCode: "already_running" };
  }

  const apiKey = decryptOfdSecret(connection.integrationTokenEncrypted);
  if (!apiKey) return { ok: false, safeCode: "astral_not_configured", safeMessage: "Нет API-ключа Астрал." };
  const client = params.clientFactory ? params.clientFactory(apiKey, connectionId) : createAstralClient({ connectionId, apiKey }, params.clientOpts);

  // Active KKT mappings for this connection scope. fnNumber = factoryFiscalDrive.
  const mappings = await prisma.ofdCashRegisterMapping.findMany({
    where: {
      companyId: connection.companyId,
      provider: "astral",
      isActive: true,
      activeMappingKey: { not: null },
      ...(connection.legalEntityId ? { legalEntityId: connection.legalEntityId } : {}),
      ...(params.onlyKktFnNumbers && params.onlyKktFnNumbers.length ? { fnNumber: { in: params.onlyKktFnNumbers } } : {}),
    },
  });
  if (mappings.length === 0) {
    if (dryRun) return { ok: false, safeCode: "astral_no_active_cash_register_mappings", safeMessage: "Нет активных касс Астрал для выбранного подключения." };
    // Fall through to record it on a run row below.
  }

  const fnLookup = new Map<string, { clubId: string; legal: string | null }>();
  const kktIds: number[] = [];
  const fnNumbers: string[] = [];
  for (const m of mappings) {
    if (m.fnNumber) { fnLookup.set(m.fnNumber, { clubId: m.clubId, legal: m.legalEntityId ?? connection.legalEntityId ?? null }); fnNumbers.push(m.fnNumber); }
    if (m.externalKktId && Number.isFinite(Number(m.externalKktId))) kktIds.push(Number(m.externalKktId));
  }

  const diagnostics = emptyDiagnostics();
  const start = Date.parse(`${dateFrom}T00:00:00+03:00`); // deterministic; for durationMs only
  let run: { id: string } | null = null;
  if (!dryRun) {
    run = await prisma.ofdSyncRun.create({
      data: { connectionId, companyId: connection.companyId, legalEntityId: connection.legalEntityId, mode, dateFrom, dateTo, status: "running", requestedByUserId: params.requestedByUserId ?? null, startedAt: new Date() },
    });
    if (mappings.length === 0) {
      await recordSyncError(run.id, connection.id, connection.companyId, null, null, "mapping_check", "astral_no_active_cash_register_mappings", "Нет активных касс Астрал для выбранного подключения.");
      await prisma.ofdSyncRun.update({ where: { id: run.id }, data: { status: "failed", finishedAt: new Date(), safeErrorCode: "astral_no_active_cash_register_mappings", safeErrorMessage: "Нет активных касс Астрал." } });
      return { ok: false, safeCode: "astral_no_active_cash_register_mappings", syncRunId: run.id, diagnostics };
    }
  }

  const { beginDate, endDate, beginIso, endIso } = clubDayRangeUnix(dateFrom, dateTo);
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
  // FIRST/default request sends NO server-side operationTypes filter — documents are
  // classified LOCALLY, so an enum mismatch can never zero out results (§6). A caller
  // may opt into a server filter once its exact enum values are confirmed on live data.
  const operationTypes = params.operationTypesFilter ?? undefined;

  // SAFE trace (§1): the exact request identifiers, never the api_key. kkts MUST be the
  // internal Astral KKT ids (externalKktId), never numberKKT / kktRegId / factoryFiscalDrive.
  console.warn(
    `[ofd-astral] import_trace endpoint=documents.tickets orgId=${organizationId} ` +
    `kkts=${JSON.stringify(kktIds)} fnNumbers=${JSON.stringify(fnNumbers)} ` +
    `mappings=${mappings.map((m) => `{externalKktId=${m.externalKktId ?? "-"},numberKKT=${m.kktFactoryNumber ?? "-"},kktRegId=${m.kktRegNumber ?? "-"},fiscalDriveNumber=${m.fnNumber}}`).join(",")} ` +
    `beginDate=${beginDate} endDate=${endDate} beginIso=${beginIso} endIso=${endIso} ` +
    `operationTypes=${JSON.stringify(operationTypes ?? null)}`,
  );

  const dbRules: OfdCategoryRuleLike[] = dryRun
    ? []
    : await prisma.ofdRevenueCategoryRule.findMany({
        where: { companyId: connection.companyId, isActive: true },
        select: { id: true, legalEntityId: true, categoryCode: true, categoryName: true, matchType: true, pattern: true, normalizedPattern: true, priority: true, isActive: true, createdAt: true },
      });
  const itemStats: ItemStats = { itemDocumentsSeen: 0, itemRowsSeen: 0, itemRowsSaved: 0, itemRowsSkipped: 0, categoryOtherCount: 0 };

  let found = 0, imported = 0, skipped = 0;
  let pageError = false;
  const touched = new Set<string>(); // `${clubId}|${legal ?? ""}|${day}`

  let pageNumber = 1;
  let prevFirstKey: string | null = null;
  for (; pageNumber <= maxPages; pageNumber++) {
    const page = await fetchReceiptsPage(client, { organizationId, pageNumber, count: pageSize, beginDate, endDate, kkts: kktIds.length ? kktIds : undefined, fiscalDriveNumber: kktIds.length ? undefined : fnNumbers, operationTypes });
    if (!page.ok) {
      pageError = true;
      if (run) await recordSyncError(run.id, connection.id, connection.companyId, null, null, "documents_tickets", page.code, page.message);
      break;
    }
    const { documents, totalCount } = page.data;
    if (documents.length === 0) break; // empty page ends the loop

    diagnostics.pagesProcessed += 1;
    diagnostics.documentsReceived += documents.length;

    const normalized = documents.map(normalizeAstralDocument);
    // Duplicate-page detection: if the first key repeats, pagination is not advancing.
    const firstKey = normalized[0]?.dedupeKey ?? null;
    if (firstKey && firstKey === prevFirstKey) {
      pageError = true;
      if (run) await recordSyncError(run.id, connection.id, connection.companyId, null, null, "pagination", "ASTRAL_PAGINATION_ERROR", `page ${pageNumber} repeats`);
      break;
    }
    prevFirstKey = firstKey;

    const pageReceipts: EnrichedReceipt[] = [];
    for (const doc of normalized) {
      tallyDoc(diagnostics, doc);
      const receipt = toNormalizedReceipt(doc);
      if (!receipt) continue; // non-revenue → counted only
      const target = fnLookup.get(doc.fnNumber);
      if (!target) { diagnostics.foreignSkipped += 1; continue; }
      pageReceipts.push({ receipt, clubId: target.clubId, legal: target.legal });
    }

    if (!dryRun && run) {
      const res = await persistPage(pageReceipts, connection.id, connection.companyId, connection.provider, run.id, dbRules, itemStats, touched);
      found += res.found; imported += res.imported; skipped += res.skipped;
    } else {
      found += pageReceipts.length;
    }

    if (diagnostics.documentsReceived >= totalCount) break; // collected everything
  }
  if (pageNumber > maxPages && run) {
    await recordSyncError(run.id, connection.id, connection.companyId, null, null, "pagination", "ASTRAL_PAGINATION_ERROR", `exceeded maxPages=${maxPages}`);
    pageError = true;
  }

  if (dryRun) {
    return { ok: true, syncRunId: null, found, imported: 0, skipped: 0, status: pageError ? "partial_failed" : "success", totalIncomeKopeks: diagnostics.totalIncomeKopeks, totalReturnKopeks: diagnostics.totalReturnKopeks, diagnostics };
  }

  // Recompute affected summaries from the stored rows (money + categories).
  for (const key of touched) {
    const [clubId, legalRaw, day] = key.split("|");
    await recomputeDailySummary(connection.companyId, clubId, legalRaw || null, connection.provider, day);
    await recomputeRevenueCategorySummaries(connection.companyId, clubId, legalRaw || null, connection.provider, day);
  }

  const status = !pageError ? "success" : imported > 0 ? "partial_failed" : "failed";
  const durationMs = Math.max(0, Date.parse(`${dateTo}T00:00:00+03:00`) - start); // deterministic placeholder; real wall-time added by caller if needed
  if (run) {
    await prisma.ofdSyncRun.update({
      where: { id: run.id },
      data: {
        status, finishedAt: new Date(),
        foundReceipts: found, importedReceipts: imported, skippedReceipts: skipped,
        totalIncomeKopeks: diagnostics.totalIncomeKopeks, totalReturnKopeks: diagnostics.totalReturnKopeks,
        pagesProcessed: diagnostics.pagesProcessed, documentsReceived: diagnostics.documentsReceived, unknownDocuments: diagnostics.unknownDocuments, durationMs,
        ...(pageError ? { safeErrorCode: "ASTRAL_SYNC_PARTIAL_FAILURE" } : {}),
      },
    });
    await prisma.ofdConnection.update({ where: { id: connection.id }, data: { lastSyncAt: new Date() } });
  }

  console.warn(`[ofd-astral] import_done connectionId=${connection.id} pages=${diagnostics.pagesProcessed} docs=${diagnostics.documentsReceived} sales=${diagnostics.salesCount} returns=${diagnostics.returnCount} unknown=${diagnostics.unknownDocuments} found=${found} imported=${imported} skipped=${skipped} status=${status}`);
  return { ok: true, syncRunId: run?.id ?? null, found, imported, skipped, status, totalIncomeKopeks: diagnostics.totalIncomeKopeks, totalReturnKopeks: diagnostics.totalReturnKopeks, diagnostics };
}

/** Accumulate SAFE diagnostics for one document (counts + money only). */
function tallyDoc(d: AstralImportDiagnostics, doc: AstralNormalizedDoc): void {
  switch (doc.docClass) {
    case "sale": d.salesCount += 1; d.totalIncomeKopeks += doc.totalKopeks; break;
    case "sale_return": d.returnCount += 1; d.totalReturnKopeks += doc.totalKopeks; break;
    case "expense": d.expenseCount += 1; break;
    case "expense_return": d.expenseCount += 1; break;
    case "service_document": d.serviceCount += 1; break;
    default: d.unknownDocuments += 1; break;
  }
  if (doc.isRevenue) { d.cashKopeks += doc.cashKopeks; d.ecashKopeks += doc.electronicKopeks; }
  if (doc.itemsPresent && doc.items) d.positionsCount += doc.items.length;
  if (doc.paymentMismatch) d.paymentMismatchCount += 1;
}

/** Persist one page's revenue receipts idempotently (dedupe within page + vs DB),
 * grouped by club so item categorization reuses the shared persistReceiptItems. */
async function persistPage(
  pageReceipts: EnrichedReceipt[],
  connectionId: string,
  companyId: string,
  provider: string,
  syncRunId: string,
  dbRules: OfdCategoryRuleLike[],
  itemStats: ItemStats,
  touched: Set<string>,
): Promise<{ found: number; imported: number; skipped: number }> {
  if (pageReceipts.length === 0) return { found: 0, imported: 0, skipped: 0 };
  // Dedupe within the page.
  const byKey = new Map<string, EnrichedReceipt>();
  for (const er of pageReceipts) byKey.set(er.receipt.dedupeKey, er);
  const keys = [...byKey.keys()];
  const existing = await prisma.ofdReceiptImport.findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true } });
  const existingSet = new Set(existing.map((e) => e.dedupeKey));
  const fresh = keys.filter((k) => !existingSet.has(k)).map((k) => byKey.get(k)!);

  if (fresh.length > 0) {
    await prisma.ofdReceiptImport.createMany({
      data: fresh.map((er) => ({
        connectionId, companyId, clubId: er.clubId, legalEntityId: er.legal, provider,
        fnNumber: er.receipt.fnNumber, shiftNumber: er.receipt.shiftNumber,
        fiscalDocumentNumber: er.receipt.fiscalDocumentNumber, fiscalSign: er.receipt.fiscalSign, operationType: er.receipt.operationType,
        receiptDate: er.receipt.receiptDate, totalKopeks: er.receipt.totalKopeks, cashKopeks: er.receipt.cashKopeks,
        electronicKopeks: er.receipt.electronicKopeks, dedupeKey: er.receipt.dedupeKey, source: "astral", syncRunId,
      })),
    });
  }

  // Item persistence per club group (idempotent by itemKey), for ALL receipts that
  // carried positions — fresh and already-imported.
  const idRows = await prisma.ofdReceiptImport.findMany({ where: { dedupeKey: { in: keys } }, select: { id: true, dedupeKey: true } });
  const idByKey = new Map(idRows.map((r) => [r.dedupeKey, r.id]));
  const byClub = new Map<string, { legal: string | null; receipts: NormalizedOfdReceipt[] }>();
  for (const er of byKey.values()) {
    touched.add(`${er.clubId}|${er.legal ?? ""}|${dayOf(er.receipt.receiptDate)}`);
    const g = byClub.get(er.clubId) ?? { legal: er.legal, receipts: [] };
    g.receipts.push(er.receipt);
    byClub.set(er.clubId, g);
  }
  for (const [clubId, g] of byClub) {
    try {
      await persistReceiptItems(g.receipts, idByKey, { companyId, clubId, legal: g.legal, provider }, dbRules, itemStats);
    } catch {
      await recordSyncError(syncRunId, connectionId, companyId, clubId, null, "save_items", "ofd_item_save_failed", "Не удалось сохранить позиции чека Астрал (чеки импортированы).");
    }
  }

  return { found: keys.length, imported: fresh.length, skipped: keys.length - fresh.length };
}
