# Security Event Runbook (REM-07)

## What is logged
Denied auth/authz, financial-guard blocks, file/cron denials — in `SecurityEvent` (separate from the
`AuditLog` success trail). Every row is redacted (allow-listed metadata, no secrets/PII).

## Query (read-only)
`npm run audit:security-events [--company=ID] [--actor=ID] [--event-type=authz.denied_club_scope]
[--severity=high] [--request-id=UUID] [--since=ISO] [--until=ISO] [--json]`. Always tenant-scope by
`--company` for a tenant investigation.

## Investigate a report
1. User gives the **Код обращения** (requestId). Run `npm run trace:request -- <requestId>`.
2. Read the chain: eventType, reasonCode, actor, company/club, route, deploymentVersion.
3. `authz.denied_*` → a legitimate permission boundary (usually). Repeated `denied_company_scope` /
   `file.cross_tenant_key_detected` by one actor → escalate (possible probing).
4. `finance.idempotency_conflict` → a retry with a changed amount; check the payment flow.
   `finance.replay_returned_existing` → benign retry/timeout.
5. `integration.cron_denied` (401) → someone hit the cron with a wrong secret; rotate if unexpected.

## Access to the events
Owner/GD → their own company only. A security/support admin is a separate INTERNAL capability, not a
public role. Never grant global cross-tenant access. (REM-07 ships the read-only CLI; a UI is optional.)

## Do NOT
Do not add PII/filenames/secrets to metadata. Do not delete events ad-hoc (retention is a separate
approved job). Do not echo the internal reasonCode or a foreign `targetId` to the user.
