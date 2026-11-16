// REM-06 — runtime dependency probes (DB connect, provider detection). Read-only,
// bounded, secret-free. Never writes business data.

import type { DependencyCheckResult, DependencyStatus } from "./types";

type RawClient = {
  $queryRawUnsafe: (sql: string) => Promise<unknown>;
};

function now(): string {
  return new Date().toISOString();
}

/** Detect the ACTUAL provider the live DB speaks, to catch a client/URL mismatch. */
export async function detectDbProvider(prisma: RawClient): Promise<"postgresql" | "sqlite" | "unknown"> {
  // The URL is only a hint for query ORDER, never trusted as the detected
  // provider. Probe the expected dialect first so a healthy PostgreSQL demo
  // does not emit a misleading Prisma error from SELECT sqlite_version().
  const databaseUrl = (process.env.DATABASE_URL ?? "").toLowerCase();
  const postgresExpected = databaseUrl.startsWith("postgresql://") || databaseUrl.startsWith("postgres://");
  const probes: { sql: string; provider: "postgresql" | "sqlite" }[] = postgresExpected
    ? [{ sql: "SELECT version() AS v", provider: "postgresql" }, { sql: "SELECT sqlite_version() AS v", provider: "sqlite" }]
    : [{ sql: "SELECT sqlite_version() AS v", provider: "sqlite" }, { sql: "SELECT version() AS v", provider: "postgresql" }];
  for (const probe of probes) {
    try {
      await prisma.$queryRawUnsafe(probe.sql);
      return probe.provider;
    } catch {
      // Fall back to the alternate dialect and then report unknown.
    }
  }
  return "unknown";
}

/**
 * DB readiness probe: a bounded `SELECT 1`. Returns a value-free DependencyCheckResult.
 * NO writes, NO heavy queries. A raw driver error is reduced to a machine code.
 */
export async function checkDatabase(prisma: RawClient, opts?: { timeoutMs?: number }): Promise<DependencyCheckResult> {
  const timeoutMs = opts?.timeoutMs ?? 3000;
  const started = Date.now();
  const base = { name: "database", requiredForReadiness: true, checkedAt: now() };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DependencyCheckResult>((res) => {
    timer = setTimeout(() => res({ ...base, status: "failed" as DependencyStatus, latencyMs: timeoutMs, errorCode: "DB_TIMEOUT", safeMessage: "Database did not respond in time." }), timeoutMs);
  });
  const probe = (async (): Promise<DependencyCheckResult> => {
    try {
      await prisma.$queryRawUnsafe("SELECT 1");
      return { ...base, status: "ok", latencyMs: Date.now() - started };
    } catch {
      return { ...base, status: "failed", latencyMs: Date.now() - started, errorCode: "DB_UNREACHABLE", safeMessage: "Database is not reachable." };
    }
  })();
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
