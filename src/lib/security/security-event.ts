// REM-07 — the SINGLE security-event logger (spec §6/§7). Records DENIALS (never
// successful reads) to the SecurityEvent table, with a structured-stderr fallback.
//
// CRITICAL invariant: a logging failure NEVER turns a denial into an allow. This
// function is best-effort and NEVER throws upward — the caller has already decided to
// deny; recording must not change that. Metadata is redacted + allow-listed; no raw
// DB errors, secrets or PII ever appear.

import { prisma } from "@/lib/prisma";
import type { DbClient } from "@/lib/db-client";
import { deploymentVersion } from "@/lib/deployment-version";
import { redactMetadata } from "./redaction";
import { defaultSeverity, type SecuritySeverity, type SecurityOutcome, type SecuritySource } from "./event-types";

export type SecurityEventInput = {
  eventType: string;
  severity?: SecuritySeverity;
  outcome?: SecurityOutcome;
  reasonCode?: string | null;
  actorId?: string | null;
  companyId?: string | null;
  clubId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  route?: string | null;
  source?: SecuritySource;
  requestId?: string | null;
  metadata?: Record<string, unknown> | null;
};

function safeStr(v: string | null | undefined, max = 120): string | null {
  if (!v) return null;
  let out = "";
  for (let i = 0; i < v.length && out.length < max; i++) {
    const c = v.charCodeAt(i);
    out += c < 0x20 || c === 0x7f ? " " : v[i];
  }
  return out.trim() || null;
}

/**
 * Record a denied/blocked security event. Best-effort, fail-safe, redacted. Returns
 * void and NEVER throws — the denial stands regardless of the logging outcome.
 */
export async function recordSecurityEvent(input: SecurityEventInput, db: DbClient = prisma): Promise<void> {
  const eventType = safeStr(input.eventType) ?? "unknown";
  const severity = input.severity ?? defaultSeverity(eventType);
  const metadata = redactMetadata(input.metadata);
  const row = {
    requestId: safeStr(input.requestId, 64),
    eventType,
    severity,
    outcome: input.outcome ?? "denied",
    reasonCode: safeStr(input.reasonCode, 80),
    actorId: safeStr(input.actorId, 64),
    companyId: safeStr(input.companyId, 64),
    clubId: safeStr(input.clubId, 64),
    targetType: safeStr(input.targetType, 60),
    targetId: safeStr(input.targetId, 64),
    route: safeStr(input.route, 120),
    source: input.source ?? "web",
    metadataJson: Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    deploymentVersion: deploymentVersion().commit,
  };

  try {
    await db.securityEvent.create({ data: row });
  } catch {
    // Fallback: structured stderr so the denial is still observable if the DB write
    // fails. NEVER the raw DB error; NEVER a secret. This line is intentionally the
    // ONLY place a failure surfaces — the caller keeps denying.
    try {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ tag: "security_event_fallback", ...row }));
    } catch {
      /* even the fallback must not throw */
    }
  }
}

/**
 * Convenience: record then return the safe user-facing message that carries the
 * requestId so support can find the event — WITHOUT leaking the reason/tenant.
 */
export function deniedUserMessage(requestId: string | null): string {
  return requestId
    ? `Недостаточно прав для выполнения действия. Код обращения: ${requestId}`
    : "Недостаточно прав для выполнения действия.";
}
