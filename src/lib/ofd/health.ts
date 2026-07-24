// OFD sync health — derived from OfdSyncRun history + active connections. Read-only, no
// side effects. Shared by the dashboard "Данные ОФД" card and the auto-sync diagnostics.
import { prisma } from "@/lib/prisma";
import { ofdEnabled } from "@/lib/ofd/config";

export type OfdSyncHealthState =
  | "disabled" // integrations off or no active connection
  | "never_synced"
  | "running"
  | "failed" // last run failed
  | "delayed" // last success older than the daily cadence
  | "healthy";

export type OfdSyncStatus = {
  state: OfdSyncHealthState;
  provider: string;
  connectionCount: number;
  lastRunStatus: string | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
  found: number;
  imported: number;
  skipped: number;
};

// A daily job that hasn't succeeded within this window is "delayed".
const HEALTHY_WINDOW_HOURS = 30;

/** Company-wide OFD sync status (never returns raw error text — safe codes only). */
export async function loadOfdSyncStatus(companyId: string, now: Date = new Date()): Promise<OfdSyncStatus> {
  const base: OfdSyncStatus = {
    state: "disabled",
    provider: "taxcom",
    connectionCount: 0,
    lastRunStatus: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    found: 0,
    imported: 0,
    skipped: 0,
  };
  if (!ofdEnabled()) return base;

  const [connectionCount, latest, lastSuccess] = await Promise.all([
    prisma.ofdConnection.count({ where: { companyId, provider: "taxcom", isActive: true } }),
    prisma.ofdSyncRun.findFirst({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      select: { status: true, finishedAt: true, startedAt: true, createdAt: true, safeErrorCode: true, foundReceipts: true, importedReceipts: true, skippedReceipts: true },
    }),
    prisma.ofdSyncRun.findFirst({
      where: { companyId, status: { in: ["success", "partial_failed"] } },
      orderBy: { createdAt: "desc" },
      select: { finishedAt: true, createdAt: true },
    }),
  ]);

  base.connectionCount = connectionCount;
  if (connectionCount === 0) return base; // disabled — nothing to sync

  if (!latest) return { ...base, state: "never_synced" };

  base.lastRunStatus = latest.status;
  base.lastRunAt = latest.finishedAt ?? latest.startedAt ?? latest.createdAt;
  base.lastErrorCode = latest.safeErrorCode ?? null;
  base.found = latest.foundReceipts;
  base.imported = latest.importedReceipts;
  base.skipped = latest.skippedReceipts;
  base.lastSuccessAt = lastSuccess?.finishedAt ?? lastSuccess?.createdAt ?? null;

  if (latest.status === "pending" || latest.status === "running") return { ...base, state: "running" };
  if (!base.lastSuccessAt) return { ...base, state: latest.status === "failed" ? "failed" : "never_synced" };
  if (latest.status === "failed") return { ...base, state: "failed" };

  const ageHours = (now.getTime() - base.lastSuccessAt.getTime()) / 3_600_000;
  return { ...base, state: ageHours <= HEALTHY_WINDOW_HOURS ? "healthy" : "delayed" };
}

export const OFD_HEALTH_LABELS: Record<OfdSyncHealthState, string> = {
  disabled: "Отключено",
  never_synced: "Ещё не синхронизировалось",
  running: "Выполняется",
  failed: "Ошибка последнего запуска",
  delayed: "Задержка синхронизации",
  healthy: "В норме",
};
