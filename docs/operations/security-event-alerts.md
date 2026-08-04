# Security Event Alerts (REM-07)

Alert on PATTERNS, not on every ordinary permission denial (spec §18).

| Signal | Threshold | Severity |
|---|---|---|
| Same actor → multiple `authz.denied_company_scope` / `authz.denied_object_scope` in a short window | e.g. ≥5 / 10 min | **pager** |
| `file.cross_tenant_key_detected` (any) | ≥1 | **pager** |
| Many `auth.login_failed` for one email marker / IP | e.g. ≥10 / 10 min | warning (aggregated) |
| `authz.denied_reversal_role` / `authz.denied_self_approval` | ≥3 / hour | warning |
| `finance.idempotency_conflict` | spike | warning |
| `integration.cron_denied` (401 invalid_secret) | ≥1 | warning |
| rate-limiter fail-open (`failOpen=true` metadata) | any | **pager** |
| `security_event_fallback` on stderr (logger DB write failing) | any sustained | **pager** |

- A single accidental scope denial → informational/warning, NOT a page.
- Mass unauthenticated probes → aggregated warning (dedupe by actor/IP marker).
- Alerts read from the `SecurityEvent` table (`eventType+createdAt`, `actorId+createdAt`,
  `severity+createdAt` indexes) + the stderr fallback stream. Never include event metadata that could
  carry a secret (the rows are already redacted).
