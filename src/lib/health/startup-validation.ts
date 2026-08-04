// REM-06 — startup validation (spec §6). Classifies config into FATAL (refuse to
// start in production), NOT-READY (temporary — DB/storage/migration) and DEGRADED
// (optional integrations). PURE over an env bag so it is unit-tested; the thin
// `assertProductionStartup` wrapper throws (secret-free) on a fatal condition.

import { validateDatabaseEnvironment } from "./database-validation";
import { validateStorageEnv } from "@/lib/storage/config";
import { secretMeetsPolicy } from "@/lib/env-secrets";

export type StartupClassification = {
  fatal: string[]; // process must not start (production)
  notReady: string[]; // start, but readiness=false until resolved
  degraded: string[]; // start + serve; feature limited
};

const SESSION_SECRET_MIN = 32;

/** Classify the environment. PURE — pass the env bag + isProduction. */
export function classifyStartup(env: Record<string, string | undefined>, opts: { isProduction: boolean }): StartupClassification {
  const fatal: string[] = [];
  const notReady: string[] = [];
  const degraded: string[] = [];

  // --- FATAL (production only for the environment-shape rules) ---
  const db = validateDatabaseEnvironment(env, { isProduction: opts.isProduction, allowLocalhost: env.ALLOW_DB_LOCALHOST === "true" });
  for (const e of db.errors) {
    // A temporarily-unreachable DB is NOT-READY, not fatal; but a mis-shaped URL
    // (sqlite in prod, malformed, unsupported, empty, provider mismatch) is fatal.
    fatal.push(`database:${e}`);
  }

  if (!secretMeetsPolicy(env.SESSION_SECRET, SESSION_SECRET_MIN) && opts.isProduction) fatal.push("SESSION_SECRET_MISSING_OR_SHORT");

  const storage = validateStorageEnv(env, { isProduction: opts.isProduction });
  if (opts.isProduction && !storage.ok) fatal.push(...storage.errors.map((e) => `storage:${e}`));

  // --- DEGRADED (optional integrations) ---
  if (!env.SMTP_HOST && !env.EMAIL_SERVER_HOST) degraded.push("smtp");
  if ((env.AI_PROVIDER ?? "mock") === "mock") degraded.push("ai");
  if (env.OFD_INTEGRATIONS_ENABLED !== "true") degraded.push("ofd");
  if (!env.BACKUP_S3_BUCKET) degraded.push("backup");

  return { fatal, notReady, degraded };
}

/** Read process.env for the current environment. */
export function resolveStartupClassification(): StartupClassification {
  return classifyStartup(process.env as Record<string, string | undefined>, { isProduction: process.env.NODE_ENV === "production" });
}

let asserted = false;

/**
 * FAIL FAST in production on a fatal config (secret-free message). Idempotent. Call
 * from a startup hook; readiness still re-checks the transient conditions.
 */
export function assertProductionStartup(): void {
  if (asserted) return;
  if (process.env.NODE_ENV !== "production") return;
  const c = resolveStartupClassification();
  if (c.fatal.length) {
    throw new Error(`Fatal startup configuration; refusing to start: ${c.fatal.join("; ")}`);
  }
  asserted = true;
}
