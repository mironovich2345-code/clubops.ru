# CLUB-OPS — Post-Deploy Checklist

Run immediately after every production deploy. Most items are read-only smoke checks.

## Version & readiness
- [ ] `GET /api/health/live` → 200; `commit`/`deploymentId` = the just-deployed version.
- [ ] `GET /api/health/ready` → 200 `ready` (REM-06 — DB + schema + provider + storage all OK). A 503 = do not accept traffic.
- [ ] `GET /api/health/dependencies` → review `checks[]` (SMTP/AI/OFD/backup degraded are acceptable; no secrets exposed).
- [ ] DB schema version = expected: latest row in `_prisma_migrations` matches the release's newest migration (`schema_migrations` check = ok, not `newer_schema`/`pending`).
- [ ] `/api/health/dependencies` `storage` = `s3` (not `local`) in production.

## Functional smoke (as a real user)
- [ ] Login (OTP delivered → SMTP working).
- [ ] Role access correct (owner vs regional vs manager land on the right pages).
- [ ] Open an invoice; upload flow reachable.
- [ ] Open a stored document (file storage read works).
- [ ] Open an expense; a cash balance renders.
- [ ] Payroll read (period/calc) renders.
- [ ] OFD freshness: last `ofdSyncRun` recent (or the timer configured).

## Integrity (read-only, on a replica if possible)
- [ ] `audit:data-integrity --json` → no new S0/S1 vs the pre-deploy run.
- [ ] `audit:financial-reconciliation --json` → no new violations (sample company/club/month).
- [ ] Spot-check one company's cash + one payroll period reconcile.

## Observability
- [ ] Logs flowing (container stdout); no crash-loop; no unexpected 5xx spike.
- [ ] No errors in the React error boundaries on the main flows.
- [ ] (recommended) error tracker shows the new release version.

## Sign-off
- [ ] Deploy owner confirms healthy.
- [ ] Acceptance owner confirms the smoke set.
- [ ] Previous image digest retained for rollback (kept 5).
