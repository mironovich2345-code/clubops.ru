// REM-06 — operational diagnostics (spec §2C/§10). Extends readiness with the
// OPTIONAL integrations (SMTP/AI/OFD/backup/scheduler) as `degraded`, never blocking
// readiness. Sanitized: NO hosts, credentials, bucket/DB names, paths or stack traces.

import { emailConfigured } from "@/lib/email";
import { selectedAiProvider } from "@/lib/ai/openai-client";
import { ofdHealth } from "@/lib/ofd/config";
import { storageConfigDiagnostic } from "@/lib/storage";
import type { DependenciesReport, DependencyCheckResult } from "./types";
import { worstStatus } from "./types";
import { computeReadiness } from "./readiness";
import { createProbeCache } from "./cache";

function iso(): string {
  return new Date().toISOString();
}

/** Full dependency diagnostics — readiness checks + optional integrations. */
export async function computeDependencies(): Promise<DependenciesReport> {
  const readiness = await computeReadiness();
  const checks: DependencyCheckResult[] = [...readiness.checks];

  // Storage config-level diagnostic (safe summary; probe lives in readiness).
  const storageCfg = storageConfigDiagnostic();
  checks.push({ name: "storage_config", status: storageCfg.ok ? "ok" : "degraded", requiredForReadiness: false, latencyMs: 0, checkedAt: iso(), metadata: { provider: storageCfg.provider, s3Configured: storageCfg.s3Configured, sse: storageCfg.serverSideEncryption } });

  // Optional integrations — degraded, never blocking.
  checks.push({ name: "smtp", status: emailConfigured() ? "ok" : "degraded", requiredForReadiness: false, latencyMs: null, checkedAt: iso(), safeMessage: emailConfigured() ? undefined : "Email is not configured — invitations/notifications are unavailable." });

  const ai = selectedAiProvider();
  checks.push({ name: "ai", status: ai === "mock" ? "degraded" : "ok", requiredForReadiness: false, latencyMs: null, checkedAt: iso(), metadata: { effective: ai }, safeMessage: ai === "mock" ? "AI analysis is running in mock mode." : undefined });

  const ofd = ofdHealth();
  checks.push({ name: "ofd", status: ofd.configured ? "ok" : "degraded", requiredForReadiness: false, latencyMs: null, checkedAt: iso(), metadata: { enabled: ofd.enabled, configured: ofd.configured } });

  // Backup + scheduler freshness are operational signals (config presence only here;
  // real freshness comes from the monitoring layer / backup catalog). Never blocking.
  const backupConfigured = Boolean(process.env.BACKUP_S3_BUCKET);
  checks.push({ name: "backup", status: backupConfigured ? "ok" : "degraded", requiredForReadiness: false, latencyMs: null, checkedAt: iso(), safeMessage: backupConfigured ? undefined : "Off-site backup bucket is not configured." });
  checks.push({ name: "scheduler", status: "unknown", requiredForReadiness: false, latencyMs: null, checkedAt: iso(), safeMessage: "Scheduler freshness is reported by the monitoring layer." });

  return { overall: worstStatus(checks), checks };
}

const cachedDependencies = createProbeCache(5000, () => computeDependencies());
export function getDependencies(): Promise<DependenciesReport> {
  return cachedDependencies();
}
