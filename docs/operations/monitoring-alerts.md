# CLUB-OPS — Monitoring & Alerts (OPS-007)

Read-only assessment at `dc14d10`. **Current state: essentially none.** No metrics endpoint, no
uptime monitor, no error tracker (no Sentry/Bugsnag/Rollbar in `package.json`), no alerting. The only
signals are Docker container health (liveness) + container stdout logs (Docker json-file rotation). No
backup-failure, migration-failure, OFD-stale, or reconciliation-anomaly alert exists.

## Error tracking (§14) — GAP
No centralized error tracker; no source maps upload; no release-version tagging; no tenant-safe user
context; no PII scrubbing config. Frontend errors surface only in the React error boundaries; server
errors only in stdout. **Recommendation (not implemented): add an error tracker with release =
`APP_GIT_SHA`, tenant-safe context (companyId/clubId/userId, never PII/secrets), PII scrubbing.**

## Minimal alert matrix (recommendation — NOT implemented)
| Signal | Threshold | Severity | Recipient | Runbook | Silence |
|---|---|---|---|---|---|
| Uptime / liveness | 2 consecutive fails | S0 | on-call | incident #1 | during planned deploy |
| **Readiness / DB unreachable** | any (once `/health/ready` exists) | S0 | on-call | incident #2 | — |
| Error rate (5xx) | >2% over 5m | S1 | on-call | — | — |
| Latency p95 | >2s over 10m | S2 | on-call | — | — |
| **Backup failure / no backup in 24h** | any | **S0** | ops | incident #12 | — |
| **Migration failure** | any | S0 | on-call | rollback-runbook | — |
| DB connections | >80% pool | S1 | ops | — | — |
| Disk / storage free | <15% (VM `MIN_FREE_KB` is 2GB in deploy) | S1 | ops | — | — |
| **OFD stale sync** | no successful `ofdSyncRun` in 26h | S1 | ops | incident #8 | — |
| Job failure (drain/OFD) | any error batch | S2 | ops | — | — |
| SMTP failure | OTP delivery failures spike | S1 | ops | incident #9 | — |
| AI failure | provider effective=mock in prod, or error spike | S2 | ops | — | — |
| **Repeated payment attempt** | same calc/invoice paid twice in <1m | **S0** | ops+finance | incident #4 | — |
| **Reconciliation anomaly** | `audit:financial-reconciliation` violations >0 on schedule | **S1** | finance | incident #6 | — |
| **Repeated failed-authz** | spike per user/IP | S1 | security | incident #11 | — |

## How to bootstrap cheaply (recommendation)
- Uptime: external HTTP monitor on `/api/health` (and `/api/health/ready` once added).
- Backup: a wrapper that alerts if the newest `/opt/club-ops/backups/*.dump` is older than 24h or empty.
- Reconciliation: schedule `audit:financial-reconciliation --json` on a read replica; alert if `totalViolations>0`.
- Error tracker: any hosted service; tag release `APP_GIT_SHA`; scrub PII.
