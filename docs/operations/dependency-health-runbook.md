# Dependency Health Runbook (REM-06)

`/api/health/dependencies` classifies each dependency as `ok | degraded | failed | unknown`. Only
**required** ones (DB, schema, provider, storage-in-prod) block readiness; the rest are `degraded`.

## Optional integrations (degraded, not an outage)
| Dependency | Degraded means | User impact |
|---|---|---|
| SMTP | email not configured/reachable | invitations/notifications fail with a specific error; login/dashboard fine |
| AI | mock mode / provider down | invoice upload + manual review work; no AI analysis |
| OFD | not configured / stale sync | dashboard shows stale revenue warning; app not "down" |
| backup | no `BACKUP_S3_BUCKET` / stale | release/no-go signal (REM-03); not per-request blocking |
| scheduler | stale | `unknown` here; freshness from the monitoring layer |

## Alert matrix (§23)
| Signal | Severity |
|---|---|
| readiness `not_ready` > N min | **pager** |
| DB failed / storage failed | **pager** |
| provider mismatch / migration mismatch | **pager** |
| backup stale/failed | warning (release-blocking) |
| OFD stale | warning |
| SMTP/AI degraded | informational |

## Log transitions only (§22)
Log ready→not_ready, not_ready→ready, and dependency ok→degraded / degraded→ok with `deploymentVersion`,
`environment`, and a safe `errorCode`. Do NOT log every successful probe. Never log hosts/credentials/
raw driver errors.
