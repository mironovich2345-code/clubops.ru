# REM-07 — Security Events Baseline

Read-only assessment before any REM-07 change.

## Git / build baseline
| Aspect | Value |
|---|---|
| HEAD | `5658a53` |
| Branch | `main` |
| Working tree | clean |
| tsc | 0 errors |
| prisma dev / prod | valid |
| pilot:full | 4046/0 across 92 suites (REM-06 gauntlet) |
| build:prod | compiles |

## Current logging (as-is)
- One audit writer `recordAudit` (`access.ts`) → `AuditLog` for **successful** domain changes (294 call
  sites). Append-only in practice; tenant-tagged; no secrets/PII bodies. No retention.
- **No logger lib**; ad-hoc `console.error`. No request correlation id anywhere.

## Denied paths (as-is — the gap)
- `requirePageAccess` silently `redirect()`s on denial; `canAccessCompany/Club` return `false` silently;
  scoped loaders return `null`. **No record of a denied / cross-tenant / escalation attempt** (OPS-006,
  SEC-009). Cron/webhook 401/503 not logged.

## Auth / authz helpers
- `src/lib/auth.ts` (session, roles, page access), `src/lib/access.ts` (scope guards + `recordAudit`).
- Manual tenant isolation (ARCH-005) — application-level guards; observability of denials is therefore
  especially valuable.

## Middleware / proxy
- `src/middleware.ts` sets per-request CSP nonce + security headers. No request id. Caddy/Railway front
  the app; inbound `X-Forwarded-For` is not yet a trusted signal (SEC-002).

## AuditLog model
`AuditLog{ id, companyId?, clubId?, userId?, action, entityType, entityId?, metadataJson?, createdAt }`
— designed for successful changes; no `requestId`/`eventType`/`severity`/`outcome`.

## Findings in scope
- **OPS-006** — failed authorization not logged. **SEC-009** — audit strong for successes, not denials.
- **ARCH-005** (NOT closed by REM-07 — observability only). **SEC-002/008** (NOT closed — events only
  prepare evidence).

## Approach
Add a SEPARATE `SecurityEvent` table (denials + correlation) — `AuditLog` stays for successes. Mint a
server requestId in the middleware; log denials at CENTRAL guards (not 263 actions); redact everything;
a logging failure never changes an access decision. No PostgreSQL needed — logic proven on sqlite
(`test:rem-07-security-events` 19/19); the live cross-tenant + logger-outage proof is the staging gate.
