# CLUB-OPS — Security Events Spec (audit-log security)

Read-only at `eb8a8f6`. The audit trail is **strong for successful actions** but has a critical
detection gap: **failed authorization is not recorded** (OPS-006 → SEC-009).

## Current audit trail
- **Writer:** one helper `recordAudit` (`access.ts:672`) → `AuditLog{action, entityType, companyId, clubId, userId, entityId, metadataJson}`. **294 call sites / 63 files.** Strong money-op coverage (invoices 23, cash 16, OFD 22, payroll 11) and full auth-OTP lifecycle (`auth.otp_*`).
- **Integrity:** append-only in practice (no code path updates/deletes `AuditLog`); tenant-tagged; actor + entity captured; metadata carries reasons/counts, **no secrets/PII bodies**.
- **Retention:** none app-level (only Docker json-file rotation on stdout, not on the DB table).

## Gaps (feed SEC-009 / OPS-006)
1. **Failed authorization is neither audited nor logged.** `requirePageAccess` (`access.ts:351`) silently `redirect()`s; `canAccessCompany`/`canAccessClub` return `false` silently; scoped loaders return `null`. → **no record of a denied / cross-tenant / privilege-escalation attempt.** An attacker probing IDs, a former employee's stale-session attempt, or a role trying a forbidden action leaves **no trail**. This is the single biggest security-observability gap.
2. **No correlation/request id** in audit rows → multi-step money flows and an attacker's session can't be reconstructed end-to-end.
3. **No IP / user-agent** captured in `AuditLog` → limited forensic context for an incident.
4. **Cron/webhook auth rejections (401/403/503) are not logged** → no visibility into probing/misconfig.
5. **No retention policy** on the `AuditLog` table (grows unbounded; also a compliance question).

## Required security events (recommendation — NOT implemented here)
Log (structured, tenant-tagged, no secrets) at minimum:
- **auth:** login success/failure, OTP failure/lockout, password/email change, session revoke, account restore.
- **authorization DENIED:** page-access denial, `canAccessCompany/Club` false, scoped-loader null on a by-id request, capability denial (`can(...)` false) — with actor, target tenant, and the object id attempted. **(the missing class)**
- **money side-effects:** payment/reversal/cash/payroll/obligation — actor, amount, tenant, idempotency key.
- **admin:** role change, invite create/accept, user deactivate/restore, company/club/legal-entity create/archive.
- **integration:** OFD sync trigger, credential change, cron/webhook auth rejection.
- **file:** document upload/download (actor, entity, storageKey), download of a foreign-attempt (403).

Each event: `timestamp, requestId, actor(userId), companyId, clubId, action, result(success/denied/error),
entityType, entityId, ip, userAgent, reason`. Add a retention + tamper-evidence policy (append-only +
periodic export). **Failed-authz logging (SEC-009/P1) is the priority** — without it, a cross-tenant
probing or escalation attempt is invisible.

## Update (REM-07) — IMPLEMENTED
The `SecurityEvent` table (separate from `AuditLog`) + one allow-listed catalog now record DENIED
auth/authz/finance/file/cron events with a server-minted `requestId` (middleware `crypto.randomUUID`,
inbound header never trusted; `X-Request-Id` on the response). `recordSecurityEvent` is best-effort +
redacted + **fail-safe (a logging failure never turns a denial into an allow)**. Central integration:
`requirePageAccess` (auth.session_invalid / authz.denied_page_access) + `logSecurityDenial` helper +
`api/cron/ofd/daily` (integration.cron_denied). Read-only CLIs: `audit:security-events`,
`trace:request`. Redaction drops secrets/PII/URLs/filenames; `amountBand`/`emailMarker` give coarse
non-reversible signals; object-existence privacy preserved (generic external response, internal-only
targetId). Proven by `test:rem-07-security-events` (19/19). **OPS-006 + SEC-009 CLOSED**; **ARCH-005 NOT
CLOSED** (observability only); **SEC-002/008 NOT CLOSED** (evidence only). Remaining per-branch adoption
(financial/file/scope-loader denials) = live gates G-SECLOG-1/2. See `docs/remediation/rem-07-final-report.md`.
