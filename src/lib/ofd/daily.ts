// Server-only daily OFD auto-import. Selects every ACTIVE Taxcom connection and
// imports YESTERDAY's sales via the existing importTaxcomSalesForPeriod (mode
// "auto_daily"). Returns SAFE aggregates only — never secrets / Session-Token /
// raw Taxcom response / fiscal JSON / buyer PII / error stacks. Per-connection
// concurrency is handled by the importer's own "already_running" guard, so a
// second overlapping cron never corrupts data; a busy connection is reported and
// the others continue. The HTTP wrapper lives in the route; the auth check and
// the run loop are pure/injectable here so they are unit-testable.
import { prisma } from "@/lib/prisma";
import { bearerEquals, secretEquals } from "@/lib/secure-compare";
import { importTaxcomSalesForPeriod } from "@/lib/ofd/importer";
import { importAstralSalesForPeriod } from "@/lib/ofd/astral/importer";

/** CRON_SECRET (never the value in any response). */
export function ofdCronSecret(): string | null {
  return process.env.CRON_SECRET || null;
}

/** A local date as "YYYY-MM-DD" — pure Y/M/D, no UTC/timezone drift. */
function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Yesterday by the SERVER's local calendar day, as "YYYY-MM-DD". */
export function ofdYesterday(now: Date): string {
  return localYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
}

/** Today by the SERVER's local calendar day, as "YYYY-MM-DD". */
export function ofdToday(now: Date): string {
  return localYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
}

export type OfdCronAuthInput = {
  method: string;
  authorization: string | null;
  cronHeader: string | null;
  enabled: boolean;
  secret: string | null;
};
export type OfdCronAuthResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Authorize a daily-cron request. Order: method → feature flag → secret config →
 * request secret. A missing CRON_SECRET is a CONFIG error (503) and never runs —
 * this covers "production without CRON_SECRET" and refuses in dev too (no secret
 * = no possible auth). A present secret with a wrong/absent request header → 401.
 */
export function authorizeOfdCron(p: OfdCronAuthInput): OfdCronAuthResult {
  if (p.method !== "POST") return { ok: false, status: 405, error: "method_not_allowed" };
  if (!p.enabled) return { ok: false, status: 503, error: "ofd_integrations_disabled" };
  if (!p.secret) return { ok: false, status: 503, error: "cron_secret_not_configured" };
  const matches = bearerEquals(p.authorization, p.secret) || secretEquals(p.cronHeader, p.secret);
  if (!matches) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true };
}

export type OfdDailyRunSummary = {
  connectionId: string;
  status: string;
  foundReceipts: number;
  importedReceipts: number;
  skippedReceipts: number;
  totalIncomeKopeks: number;
  totalReturnKopeks: number;
  safeErrorCode: string | null;
};

export type OfdDailyResult = {
  ok: true;
  date: string;
  processedConnections: number;
  succeeded: number;
  failed: number;
  totals: { foundReceipts: number; importedReceipts: number; skippedReceipts: number; totalIncomeKopeks: number; totalReturnKopeks: number };
  runs: OfdDailyRunSummary[];
};

export type OfdImportMode = "auto_daily" | "sync_now";
type ImportFn = (connectionId: string, date: string, mode: OfdImportMode) => Promise<
  | { ok: true; found: number; imported: number; skipped: number; status: string; totalIncomeKopeks: number; totalReturnKopeks: number }
  | { ok: false; safeCode: string }
>;

export type RunDailyOptions = {
  now?: Date;
  listConnections?: () => Promise<{ id: string }[]>;
  importer?: ImportFn;
};

/**
 * The real importer bound to a mode. Dispatches per connection PROVIDER so a single
 * "sync" covers both Taxcom and Astral. Each provider's import is fully independent;
 * the batch loop's per-connection try/catch guarantees one provider's failure never
 * aborts the others.
 */
function defaultImporter(): ImportFn {
  return async (connectionId, date, mode) => {
    const conn = await prisma.ofdConnection.findUnique({ where: { id: connectionId }, select: { provider: true } });
    if (conn?.provider === "astral") {
      const r = await importAstralSalesForPeriod({ connectionId, dateFrom: date, dateTo: date, mode });
      return r.ok
        ? { ok: true, found: r.found, imported: r.imported, skipped: r.skipped, status: r.status, totalIncomeKopeks: r.totalIncomeKopeks, totalReturnKopeks: r.totalReturnKopeks }
        : { ok: false, safeCode: r.safeCode };
    }
    const r = await importTaxcomSalesForPeriod({ connectionId, dateFrom: date, dateTo: date, mode });
    return r.ok
      ? { ok: true, found: r.found, imported: r.imported, skipped: r.skipped, status: r.status, totalIncomeKopeks: r.totalIncomeKopeks, totalReturnKopeks: r.totalReturnKopeks }
      : { ok: false, safeCode: r.safeCode };
  };
}

/**
 * Shared batch runner for a set of connections and a single day. Injectable
 * listConnections/importer so tests never touch the DB or the real Taxcom API.
 * One connection's failure never aborts the others (exceptions are caught and
 * surfaced as a safe code). Returns SAFE aggregates only; logs ids + counts only.
 */
export async function runOfdImportBatch(opts: {
  date: string;
  mode: OfdImportMode;
  logTag: string;
  listConnections: () => Promise<{ id: string }[]>;
  importer?: ImportFn;
}): Promise<OfdDailyResult> {
  const importer = opts.importer ?? defaultImporter();
  const connections = await opts.listConnections();
  console.warn(`[${opts.logTag}] batch_start date=${opts.date} mode=${opts.mode} connections=${connections.length}`);

  const runs: OfdDailyRunSummary[] = [];
  const totals = { foundReceipts: 0, importedReceipts: 0, skippedReceipts: 0, totalIncomeKopeks: 0, totalReturnKopeks: 0 };
  let succeeded = 0, failed = 0;

  for (const c of connections) {
    let summary: OfdDailyRunSummary;
    try {
      const r = await importer(c.id, opts.date, opts.mode);
      if (r.ok) {
        summary = { connectionId: c.id, status: r.status, foundReceipts: r.found, importedReceipts: r.imported, skippedReceipts: r.skipped, totalIncomeKopeks: r.totalIncomeKopeks, totalReturnKopeks: r.totalReturnKopeks, safeErrorCode: null };
      } else {
        summary = { connectionId: c.id, status: "failed", foundReceipts: 0, importedReceipts: 0, skippedReceipts: 0, totalIncomeKopeks: 0, totalReturnKopeks: 0, safeErrorCode: r.safeCode };
      }
    } catch {
      // Never leak an error stack; surface a safe code and keep going.
      summary = { connectionId: c.id, status: "failed", foundReceipts: 0, importedReceipts: 0, skippedReceipts: 0, totalIncomeKopeks: 0, totalReturnKopeks: 0, safeErrorCode: "import_exception" };
    }
    const isSuccess = summary.safeErrorCode === null && summary.status === "success";
    if (isSuccess) succeeded += 1; else failed += 1;
    totals.foundReceipts += summary.foundReceipts;
    totals.importedReceipts += summary.importedReceipts;
    totals.skippedReceipts += summary.skippedReceipts;
    totals.totalIncomeKopeks += summary.totalIncomeKopeks;
    totals.totalReturnKopeks += summary.totalReturnKopeks;
    runs.push(summary);
    console.warn(`[${opts.logTag}] connection_done connectionId=${c.id} status=${summary.status} found=${summary.foundReceipts} imported=${summary.importedReceipts} skipped=${summary.skippedReceipts}`);
  }

  console.warn(`[${opts.logTag}] batch_done date=${opts.date} mode=${opts.mode} succeeded=${succeeded} failed=${failed}`);
  return { ok: true, date: opts.date, processedConnections: connections.length, succeeded, failed, totals, runs };
}

/**
 * Daily cron: import YESTERDAY for ALL active Taxcom connections (mode auto_daily).
 */
export async function runDailyOfdImport(opts: RunDailyOptions = {}): Promise<OfdDailyResult> {
  const now = opts.now ?? new Date();
  return runOfdImportBatch({
    date: ofdYesterday(now),
    mode: "auto_daily",
    logTag: "ofd-cron",
    listConnections: opts.listConnections ?? (() => prisma.ofdConnection.findMany({ where: { provider: { in: ["taxcom", "astral"] }, isActive: true }, select: { id: true } })),
    importer: opts.importer,
  });
}

/**
 * On-demand "Sync now": import TODAY for the active Taxcom + Astral connections of
 * ONE company (mode sync_now). Company-scoped so the button only touches the caller's
 * own connections. Both providers run independently; idempotent per day.
 */
export async function runSyncNowForCompany(companyId: string, opts: RunDailyOptions = {}): Promise<OfdDailyResult> {
  const now = opts.now ?? new Date();
  return runOfdImportBatch({
    date: ofdToday(now),
    mode: "sync_now",
    logTag: "ofd-sync",
    listConnections: opts.listConnections ?? (() => prisma.ofdConnection.findMany({ where: { companyId, provider: { in: ["taxcom", "astral"] }, isActive: true }, select: { id: true } })),
    importer: opts.importer,
  });
}
