// Server-only Taxcom sales importer. Idempotent (dedupe by dedupeKey), day-batched
// for backfill, per-KKT error isolation (one bad register never fails the rest),
// and never stores buyer PII / items / raw JSON. Recomputes OfdDailySalesSummary
// from the imported fingerprints so cards are always consistent.
import { prisma } from "@/lib/prisma";
import { decryptOfdSecret } from "@/lib/ofd/crypto";
import { createTaxcomClient, type FetchImpl, type TaxcomClient } from "@/lib/ofd/taxcom/client";
import { normalizeDocuments } from "@/lib/ofd/taxcom/adapter";
import { normalizeContractNumber } from "@/lib/ofd/contract";
import type { NormalizedOfdReceipt, OfdConnectionConfig } from "@/lib/ofd/types";

export type ImportMode = "manual_day" | "manual_period" | "backfill_july" | "daily";

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
  | { ok: true; syncRunId: string; found: number; imported: number; skipped: number; status: string }
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

  const mappings = await prisma.ofdCashRegisterMapping.findMany({
    where: { connectionId, isActive: true },
  });

  const client = (params.clientFactory ?? createTaxcomClient)(cfg, { fetchImpl: params.fetchImpl });
  const days = eachDay(dateFrom, dateTo);

  // Account guard: ShiftList/kktstat operate on the CURRENT ЛК (currentSession).
  // If the connection targets a specific договор but the API session is open in a
  // DIFFERENT ЛК, the target KKT resolves to 3103 "ККТ не найдена". Fail fast with
  // a clear reason instead of misreporting a per-KKT "not found". (AccountList also
  // performs Login lazily.) A failed AccountList here is not conclusive → proceed.
  if (connection.contractNumber?.trim()) {
    const accounts = await client.listAccounts();
    if (accounts.ok && normalizeContractNumber(accounts.data.currentAgreementNumber) !== normalizeContractNumber(connection.contractNumber)) {
      await recordSyncError(run.id, connection.id, connection.companyId, null, null, "account_check", "taxcom_wrong_current_account", "Текущий ЛК Такском не соответствует выбранному договору.");
      await prisma.ofdSyncRun.update({
        where: { id: run.id },
        data: { status: "failed", finishedAt: new Date(), safeErrorCode: "taxcom_wrong_current_account", safeErrorMessage: "Текущий ЛК Такском не соответствует выбранному договору." },
      });
      return { ok: false, safeCode: "taxcom_wrong_current_account", safeMessage: "Текущий ЛК Такском не соответствует выбранному договору.", syncRunId: run.id };
    }
  }

  let found = 0, imported = 0, skipped = 0, kktFailures = 0;
  let incomeTotal = 0, returnTotal = 0;
  const touched = new Set<string>(); // `${clubId}|${legalEntityId ?? ""}|${day}`

  for (const m of mappings) {
    const legal = m.legalEntityId ?? connection.legalEntityId ?? null;
    const perKktReceipts: NormalizedOfdReceipt[] = [];
    let kktFailed = false;

    for (const day of days) {
      const shifts = await client.listShifts(m.fnNumber, day, day);
      if (!shifts.ok) {
        kktFailed = true;
        await recordSyncError(run.id, connection.id, connection.companyId, m.clubId, m.fnNumber, "list_shifts", shifts.safeCode, shifts.safeMessage);
        continue; // try other days; do not abandon the whole KKT
      }
      for (const shift of shifts.data) {
        const docs = await client.listDocumentsByShift(m.fnNumber, shift.shiftNumber);
        if (!docs.ok) {
          kktFailed = true;
          await recordSyncError(run.id, connection.id, connection.companyId, m.clubId, m.fnNumber, "list_documents", docs.safeCode, docs.safeMessage);
          continue;
        }
        perKktReceipts.push(...normalizeDocuments(docs.data));
      }
    }
    if (kktFailed) kktFailures += 1;

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
  }

  // Recompute affected daily summaries from the stored fingerprints (authoritative).
  for (const key of touched) {
    const [clubId, legalRaw, day] = key.split("|");
    await recomputeDailySummary(connection.companyId, clubId, legalRaw || null, connection.provider, day);
  }

  const status = kktFailures === 0 ? "success" : imported > 0 || mappings.length > kktFailures ? "partial_failed" : "failed";
  await prisma.ofdSyncRun.update({
    where: { id: run.id },
    data: { status, finishedAt: new Date(), foundReceipts: found, importedReceipts: imported, skippedReceipts: skipped, totalIncomeKopeks: incomeTotal, totalReturnKopeks: returnTotal },
  });
  await prisma.ofdConnection.update({ where: { id: connection.id }, data: { lastSyncAt: new Date() } });

  return { ok: true, syncRunId: run.id, found, imported, skipped, status };
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
