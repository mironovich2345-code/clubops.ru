# REM-07 — Security Event Contract

## Model (`SecurityEvent`, additive migration `20260805120000`)
`id, createdAt, requestId?, eventType, severity, outcome, reasonCode?, actorId?, companyId?, clubId?,
targetType?, targetId?, route?, source, metadataJson?, deploymentVersion?`. Scalar tenant ids (no
relations) → never affects domain models, survives actor/tenant deletion. Indexes: `createdAt`,
`eventType+createdAt`, `companyId+createdAt`, `actorId+createdAt`, `requestId`, `severity+createdAt`.
Separate from `AuditLog` (which records SUCCESSFUL changes).

## Catalog (`event-types.ts`)
Auth: `login_failed/rate_limited/session_invalid/session_expired/user_inactive/2fa_failed/invitation_
invalid/invitation_replayed`. Authz: `denied_role/capability/company_scope/club_scope/legal_entity_
scope/object_scope/state_transition/self_approval/reversal_role/page_access`. Finance: `idempotency_
conflict/replay_returned_existing/overpayment_blocked/closed_period_blocked/invalid_amount_blocked`.
Files/integrations: `file.download_denied/upload_denied/cross_tenant_key_detected`, `integration.cron_
denied/rate_limited/invalid_source_url`. One table + a string eventType — not a table/enum per event.

## Severity / retention
`defaultSeverity`: cross-tenant + finance-conflict + self-approval + reversal = `high`; replay = `info`;
else `warning`. `retentionClass`: high/critical + `finance.*` + `denied_company*` = `long`; login_failed
+ replay = `short`; else `standard`. Destructive retention is a separate approved job (spec §15).

## Logger (`recordSecurityEvent`, spec §6/§7)
Best-effort DB write + structured-stderr fallback. **Fail-safe invariant: a logging failure NEVER turns
a denial into an allow** — the function never throws upward (proven by failure injection). Redacts
metadata (allowlist), strips control chars, drops secrets/PII, and never surfaces a raw DB error.

## Privacy (spec §21)
Allowed metadata keys only (entityType/role/capability/page/action/reason/status/amountBand/…). Never:
passwords, 2FA codes, session tokens, bank details, documents, comments, full names, plain emails,
phones, signed URLs, AI text. `amountBand`/`emailMarker` give coarse, non-reversible signals.

## Object-existence privacy (spec §10)
The external response stays generic (`NOT_FOUND`/`FORBIDDEN` per the current anti-enumeration policy).
The SecurityEvent INTERNALLY distinguishes absent vs foreign-tenant vs role-insufficient (via reasonCode
+ targetId) — the foreign `targetId` is stored for investigation but NEVER echoed to the user.
