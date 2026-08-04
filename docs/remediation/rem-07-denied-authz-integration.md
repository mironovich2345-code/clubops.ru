# REM-07 — Denied-Authorization Integration

## Central-guard strategy (spec §9)
Logging is placed where a denial is DECIDED, at shared choke points — NOT sprinkled across 263 actions:
- **`requirePageAccess`** (`access.ts`) — the page guard. Logs `auth.session_invalid` (unauthenticated)
  and `authz.denied_page_access` (role can't access the page) BEFORE its redirects. The access decision
  is unchanged.
- **`logSecurityDenial(...)`** (exported from `access.ts`) — the one helper every guard/action calls at a
  denial: resolves the requestId + records the event (best-effort, redacted). It never changes the
  decision.
- **Cron** — `api/cron/ofd/daily` logs `integration.cron_denied` on 401/503 (never the secret).

## Adoption status
Shipped: the infrastructure + central page guard + cron + the `logSecurityDenial` helper + real tests.
The remaining per-guard adoption (financial payment/reversal denials, file download 403, scope loaders
returning null on a by-id request, auth login failures) is a mechanical follow-through — each site adds
one `logSecurityDenial({eventType, reasonCode, targetType, targetId, ...})` call at its existing denial
branch. It is tracked as live gates G-SECLOG-1/2 and does not change any RBAC rule.

## What each denial event carries
`actor, requested action (route), reasonCode, targetType, safe targetId, actor company scope, requestId`
— enough to investigate, nothing to leak.

## Financial denials (spec §11)
`finance.idempotency_conflict` (fingerprint conflict — high), `finance.replay_returned_existing` (same
fingerprint returned the existing result — info, not an attack), `overpayment_blocked`, `closed_period_
blocked`, `invalid_amount_blocked`, plus `authz.denied_self_approval` / `denied_reversal_role`. The
REM-01 payout service already computes these conditions; adopting `logSecurityDenial` at those branches
is the follow-through.

## File denials (spec §12)
`file.download_denied` / `upload_denied` / `cross_tenant_key_detected` — the REM-04 storage-key guards
already detect an unsafe/cross-tenant key; log there. Never store the filename/signed-URL/bytes.

## External response (spec §16)
The user sees a safe message + the requestId (`deniedUserMessage`): «Недостаточно прав для выполнения
действия. Код обращения: …». No internal reasonCode, no "belongs to another company".
