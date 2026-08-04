// REM-07 — the single security-event catalog (spec §2). PURE constants (client-safe)
// so route handlers, guards, the CLI and tests all use the same allow-listed names.
// One table (SecurityEvent) + a string eventType — NOT a table/enum per event.

export const SECURITY_EVENT_TYPES = [
  // authentication
  "auth.login_failed",
  "auth.login_rate_limited",
  "auth.session_invalid",
  "auth.session_expired",
  "auth.user_inactive",
  "auth.2fa_failed",
  "auth.invitation_invalid",
  "auth.invitation_replayed",
  // authorization
  "authz.denied_role",
  "authz.denied_capability",
  "authz.denied_company_scope",
  "authz.denied_club_scope",
  "authz.denied_legal_entity_scope",
  "authz.denied_object_scope",
  "authz.denied_state_transition",
  "authz.denied_self_approval",
  "authz.denied_reversal_role",
  "authz.denied_page_access",
  // financial protection
  "finance.idempotency_conflict",
  "finance.replay_returned_existing",
  "finance.overpayment_blocked",
  "finance.closed_period_blocked",
  "finance.invalid_amount_blocked",
  // files / integrations
  "file.download_denied",
  "file.upload_denied",
  "file.cross_tenant_key_detected",
  "integration.cron_denied",
  "integration.rate_limited",
  "integration.invalid_source_url",
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export function isKnownSecurityEventType(t: string): t is SecurityEventType {
  return (SECURITY_EVENT_TYPES as readonly string[]).includes(t);
}

export type SecuritySeverity = "info" | "warning" | "high" | "critical";
export type SecurityOutcome = "denied" | "blocked" | "replayed" | "error";
export type SecuritySource = "web" | "server_action" | "api" | "cron" | "internal";

/** Default severity per event family (callers may override for frequency). */
export function defaultSeverity(eventType: string): SecuritySeverity {
  if (eventType.startsWith("file.cross_tenant") || eventType === "authz.denied_company_scope" || eventType === "authz.denied_object_scope") return "high";
  if (eventType === "finance.idempotency_conflict" || eventType === "authz.denied_self_approval" || eventType === "authz.denied_reversal_role") return "high";
  if (eventType === "finance.replay_returned_existing") return "info";
  return "warning";
}

// Retention hint (documented policy; enforcement is a separate approved job):
// high/critical + all finance.* / authz.denied_company_scope kept longest.
export function retentionClass(eventType: string, severity: SecuritySeverity): "long" | "standard" | "short" {
  if (severity === "critical" || severity === "high") return "long";
  if (eventType.startsWith("finance.") || eventType.startsWith("authz.denied_company")) return "long";
  if (eventType === "auth.login_failed" || eventType === "finance.replay_returned_existing") return "short";
  return "standard";
}
