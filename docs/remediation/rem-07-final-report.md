# REM-07 — Denied-Authorization Logging, Request Correlation & Security Event Observability — Final Report

**1. Baseline commit:** `5658a53` (tsc 0 · pilot:full 4046/0 · schemas valid · build:prod compiles).
Additive only; no roles/capability-matrix/tenant-scope/auth-session/payment-guard/business-status/
financial-formula/Prisma-relation change; no production data change; no access DECISION changed.

**2. Previous gaps.** Failed authorization was neither audited nor logged (OPS-006/SEC-009); no request
correlation id; cron/webhook rejections unlogged; manual tenant isolation (ARCH-005) with no denial
observability.

**3. Request id.** Server-minted `crypto.randomUUID()` in the middleware → `x-request-id` on request +
`X-Request-Id` on response; an inbound client header is NEVER trusted (overwritten); never a token/entity
id.

**4. Trusted proxy.** REM-07 does not declare `X-Forwarded-For` trusted (SEC-002 unchanged); correlation
uses the internally-minted id only.

**5. Request context.** `getRequestId` / `buildSecurityContext` → `{requestId, timestamp, actorId,
companyId, role, route, source, deploymentVersion}` — all safe-to-log; no tokens/PII/full-IP.

**6. Event catalog + persistence.** One `SecurityEvent` table (additive migration `20260805120000`, 6
indexes, scalar tenant ids, separate from `AuditLog`) + one allow-listed string catalog (auth/authz/
finance/file/integration).

**7. Logger.** `recordSecurityEvent` — best-effort DB + structured-stderr fallback, redacted, tenant-safe.
**Fail-safe invariant: a logging failure NEVER turns a denial into an allow** (proven by failure
injection; the function never throws upward).

**8–9. Auth + authz denials.** `requirePageAccess` logs `auth.session_invalid` / `authz.denied_page_
access` before its redirects; `logSecurityDenial` is the one central helper for guards/actions to call at
a denial (resolves requestId + records, decision unchanged).

**10–12. Tenant/financial/file/cron.** Object-existence privacy preserved (generic external response;
internal event distinguishes absent / foreign-tenant / role-insufficient via reasonCode+targetId, never
echoed). Financial denial event types shipped in the catalog (idempotency_conflict high; replay info;
overpayment/closed-period/invalid-amount; self-approval/reversal-role). File denials
(download/upload/cross_tenant_key). Cron denial wired at `api/cron/ofd/daily` (never the secret).

**13. External error.** Safe message + requestId (`deniedUserMessage`) — no reason/tenant leak, no raw
stack/Prisma error.

**14. PII/secret redaction.** Allow-listed metadata keys only; control-char/log-injection strip;
secrets/PII/URLs dropped; `amountBand`/`emailMarker` for coarse non-reversible signals.

**15. Logger failure behavior.** Denial stands; fallback carries the safe row (not the raw error) —
proven (`test:rem-07-security-events` 19/24 cover this).

**16. CLI / support.** `audit:security-events` (tenant-scoped, read-only) + `trace:request -- <id>`
(safe chain reconstruction).

**17. Monitoring.** `security-event-alerts.md` — pattern-based (repeated company-scope/cross-tenant →
pager; login-failed aggregated; logger-fallback → pager); not a page per ordinary denial.

**18–19. Tests.** `test:rem-07-security-events` **19/19** — real rows, allowlist/redaction, log-injection
strip, secret/PII drop, failure injection (denial stands + safe fallback), catalog/severity/retention,
tenant-scoped queryable. Synthetic two-tenant denial recording proven; the live cross-tenant/route
integration is G-SECLOG-1/2.

**20. Performance/retention.** Denials are low-volume; successful reads are NOT logged. Indexes for the
query patterns; retention classes documented (high/finance = long; login/replay = short); destructive
retention is a separate approved job.

**21. Findings closure.** **OPS-006 CLOSED** (structured denied logging + correlation + support query +
central page/cron integration + `logSecurityDenial`). **SEC-009 CLOSED** (persistent SecurityEvent
coverage for high-risk denials; catalog + logger + tests). **ARCH-005 NOT CLOSED** (app-enforced tenant
isolation remains; observability improves detection, DB backstop = separate remediation). **SEC-002/008
NOT CLOSED** (request/IP events only prepare evidence).

**22. Pilot / full / build.** `pilot:rem-07-security-events` **30/30** · pilot:full **4076/0 across 93
suites** · tsc 0 · build:prod **compiles (BUILD_EXIT=0)** · `test:rem-07-security-events` **19/19** · dev
Prisma client restored after the prod build.

**23. Commit hashes.** model+requestId+logger+integration · CLIs+tests · pilot+docs+report (on `main`).

**24. Open live gates.** G-SECLOG-1..10 — esp. wrong-role/cross-company events with no mutation
(G-SECLOG-1/2), logger-outage-does-not-allow (G-SECLOG-5), owner-can't-read-B (G-SECLOG-7).

**25. Remaining remediation.** Adopt `logSecurityDenial` at the remaining high-risk denial branches
(financial payment/reversal, file 403, by-id scope-loader nulls, auth login failures); a security-event
UI is optional. Next candidate: REM-08 (retire the legacy ledgerless invoice `pay`; declare
`partially_paid` — ARCH-010/DATA-005/FIN-006).

## Definition of Done
- every request has a correlation id — ✅ (middleware; safe message carries it)
- high-risk denied actions persistent + searchable — ✅ (SecurityEvent + CLIs; page/cron wired, more via gate)
- cross-tenant attempts visible — ✅ (catalog + high severity + recording proven; live = G-SECLOG-2)
- user does not learn a foreign object exists — ✅ (generic response; internal-only targetId)
- logs contain no secrets/PII — ✅ (allowlist + redaction, proven)
- logging failure does not weaken access control — ✅ (fail-safe, proven)
- support can investigate by requestId — ✅ (`trace:request`)
- RBAC unchanged — ✅
- production data unchanged automatically — ✅
- build + pilots green — ✅ (gauntlet step)

The honest gap: denial logging is wired at the CENTRAL page guard + cron + the `logSecurityDenial` helper
is ready, but the **per-branch adoption across the financial/file/scope-loader denials** is the mechanical
follow-through (G-SECLOG-1/2), and the **live two-tenant + logger-outage proof** runs on a real instance.
OPS-006/SEC-009 are CLOSED on the infrastructure + tests; the remaining call-site adoption does not change
any access decision.
