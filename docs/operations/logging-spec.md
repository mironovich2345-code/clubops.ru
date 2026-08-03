# CLUB-OPS — Logging Spec (OPS-005 / OPS-006)

Read-only assessment at `dc14d10`.

## Current state
- **No structured-logger library and no request-id propagation.** Logging is ad-hoc `console.warn/error`; a few hot paths emit local structured JSON (`logYandex` in `invoice-analyzer.ts:270`, `notifLog` in `notifications/events.ts:51`, `logDeliveryError` in `email.ts:88` with its own `requestId`). OFD emits `[ofd] key=value` lines.
- **Audit trail is solid.** `recordAudit` (`access.ts:672`) writes `AuditLog{action, entityType, companyId, clubId, userId, entityId, metadataJson}` — all fields present, **294 call sites / 63 files**, strong on money ops (invoices 23, cash 16, OFD 22, payroll 11) and auth (OTP lifecycle fully recorded).
- **Retention:** only Docker `json-file` rotation (`max-size:10m, max-file:5`) in `docker-compose.prod.yml`. No app-level retention/scrubbing/shipping.

## What is correctly NOT logged (redaction is deliberate)
No secret / token / password / session / OTP value in any production path. OFD logs "ids + counts only";
notifications "no chatId/PII/text"; Yandex AI "never base64/OCR text/requisites/names"; email logs
`recipientDomain` only. Money amounts are **not** written to stdout (only found/imported/skipped counts).
Dev-only OTP/email plaintext logs (`email.ts:140,168`) are **prod-gated** (`NODE_ENV!=="production"`).

## Violations / risks
- **A few catch sites log the raw error object (full stack) to stdout:** `regional-tasks.ts:139`, `login-challenge.ts:258/283`, and the React error boundaries (`app/error.tsx`, `global-error.tsx`). No secret in them, but stacks reach stdout (operational noise, not a leak).

## Gaps — what SHOULD be logged but is not (OPS-006)
1. **Failed authorization is neither audited nor logged.** `requirePageAccess` (`access.ts:351`) silently `redirect()`s; `canAccessCompany`/`canAccessClub` return `false` silently. **There is no record of a denied / cross-tenant access attempt anywhere** — the biggest incident-trail gap (feeds Audit-5 security + incident runbooks).
2. **No correlation/request id** threads server actions or audit rows → multi-step money flows can't be traced end-to-end.
3. **Cron/drain/webhook 401/403/503 rejections are not logged** → no visibility into probing/misconfig.

## Spec (recommendation — NOT implemented here)
- **Must log** (structured, tenant-tagged: companyId/clubId/userId/action/result/durationMs): every money side-effect (payment/reversal/cash/payroll), login success+failure, **failed authorization**, invitations, OFD sync result, storage errors, migration runs.
- **Must NOT log:** secrets/tokens/session/OTP/passwords, full card/requisite/PII bodies, document contents, raw stacks in production (message + code only).
- **Add:** a request/correlation id propagated into `recordAudit` and logs; a structured logger; a retention + shipping target; alert on repeated failed-authz (Audit-5).
