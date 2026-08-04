// REM-06 — readiness orchestrator (spec §2B/§6/§7). Answers "can we accept user
// traffic?" — env contract + DB validity + DB connection + schema compatibility +
// provider match + storage readiness. ALL are required; any failure → not_ready
// (non-2xx). Bounded + cached + single-flight; a cached FAILURE never sticks as
// success. Secret-free.

import { prisma } from "@/lib/prisma";
import { storageReadiness } from "@/lib/storage/readiness";
import type { DependencyCheckResult, ReadinessVerdict } from "./types";
import { resolveDatabaseValidation } from "./database-validation";
import { checkDatabase, detectDbProvider } from "./runtime-checks";
import { checkSchemaCompatibility } from "./schema-compatibility";
import { createProbeCache } from "./cache";

type RawClient = { $queryRawUnsafe: (sql: string) => Promise<unknown> };

function iso(): string {
  return new Date().toISOString();
}

/** Compute readiness. `client` defaults to the app prisma; tests inject a mock. */
export async function computeReadiness(client: RawClient = prisma as unknown as RawClient): Promise<ReadinessVerdict> {
  const isProduction = process.env.NODE_ENV === "production";
  const checks: DependencyCheckResult[] = [];

  // 1. Env contract: DATABASE_URL provider/host (config-level, no I/O).
  const dbEnv = resolveDatabaseValidation();
  checks.push({
    name: "database_url",
    status: dbEnv.ok ? "ok" : "failed",
    requiredForReadiness: true,
    latencyMs: 0,
    checkedAt: iso(),
    errorCode: dbEnv.ok ? undefined : dbEnv.errors[0],
    metadata: { provider: dbEnv.provider, expected: dbEnv.expectedProvider, hostClass: dbEnv.hostClass },
  });

  // 2. Storage readiness (REM-04). Required in production; local ok in dev.
  const storage = storageReadiness();
  const storageRequired = isProduction;
  checks.push({
    name: "storage",
    status: storage.ready ? "ok" : storageRequired ? "failed" : "degraded",
    requiredForReadiness: storageRequired,
    latencyMs: 0,
    checkedAt: iso(),
    errorCode: storage.ready ? undefined : storage.errors[0],
    metadata: { provider: storage.provider },
  });

  // 3. DB connection probe (bounded SELECT 1). Only meaningful if the URL is usable.
  const db = dbEnv.errors.includes("DATABASE_URL_EMPTY")
    ? { name: "database", status: "failed" as const, requiredForReadiness: true, latencyMs: null, checkedAt: iso(), errorCode: "DATABASE_URL_EMPTY" }
    : await checkDatabase(client);
  checks.push(db);

  // 4. Schema/migration compatibility + 5. provider match — only if the DB answered.
  if (db.status === "ok") {
    const compat = await checkSchemaCompatibility(client);
    checks.push({
      name: "schema_migrations",
      status: compat.compatible ? (compat.code === "newer_schema" ? "degraded" : "ok") : "failed",
      requiredForReadiness: true,
      latencyMs: null,
      checkedAt: iso(),
      errorCode: compat.compatible ? undefined : compat.code,
      metadata: { code: compat.code, appliedCount: compat.appliedCount, latestApplied: compat.latestApplied, expected: compat.expectedLatest },
    });

    const actual = await detectDbProvider(client);
    const match = actual === dbEnv.expectedProvider || actual === "unknown";
    checks.push({
      name: "prisma_provider",
      status: actual === "unknown" ? "unknown" : match ? "ok" : "failed",
      requiredForReadiness: true,
      latencyMs: null,
      checkedAt: iso(),
      errorCode: match ? undefined : "PROVIDER_MISMATCH",
      metadata: { actual, expected: dbEnv.expectedProvider },
    });
  }

  // A required check blocks traffic only when it FAILED. degraded (e.g. newer_schema)
  // and unknown (e.g. provider undetectable) do not block — we never fabricate a
  // mismatch we cannot prove.
  const ready = checks.filter((c) => c.requiredForReadiness).every((c) => c.status !== "failed");
  return { status: ready ? "ready" : "not_ready", ready, checks };
}

// Short TTL so a failure clears quickly and a load-balancer storm hits one probe.
const cachedReadiness = createProbeCache(2000, () => computeReadiness());

/** Cached readiness for the endpoint (single-flight; failure never sticks past TTL). */
export function getReadiness(): Promise<ReadinessVerdict> {
  return cachedReadiness();
}
