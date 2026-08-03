# CLUB-OPS — Incident Runbooks

Read-only, at `dc14d10`. Each: **Detect → Contain → Diagnose (read-only) → Decide → Recover →
Preserve evidence → Follow-up.** Diagnostics are the SELECT-only audit scripts (never mutate). All
money incidents tie to Audit-3 (FIN) / Audit-2 (DATA). **Do not run destructive commands.**

### 1. App does not start
Detect: `/api/health` non-200; container crash-loops. Contain: keep the previous image running (don't
let the timer replace it). Diagnose: container logs; is it a missing required env (fails fast via
`env-secrets`) or a DB/schema issue? Decide: ops. Recover: fix env / roll app back (`rollback-runbook`).
Preserve: logs, image digest, `.env` diff. Follow-up: add the missing var to the env register.

### 2. Database unreachable
Detect: 500s; (once added) `/health/ready` fails; `pg_isready` false. Contain: nothing to write — app
returns errors. Diagnose: is Postgres up? disk full? bad `DATABASE_URL` (OPS-013 — a malformed URL is
silently sqlite, so also check the URL scheme). Decide: ops. Recover: restart Postgres / fix URL /
restore if the volume is corrupt. Preserve: pg logs, disk stats. Follow-up: add DB readiness (OPS-003)
+ URL validation (OPS-013).

### 3. Migration hung
Detect: `compose run --rm migrate` does not return; writes stalled. Contain: **do not kill mid-DDL**;
check `pg_stat_activity`/`pg_locks` for the blocking query (likely a plain index build on a large table,
`migration-risk-register`). Diagnose: which statement, which lock. Decide: ops — wait it out (index
builds finish) vs. cancel the *statement* (`pg_cancel_backend`, not the DB). Recover: on failure the
app was not updated (migrate runs before app); restore from the pre-migrate backup if the DB is
inconsistent. Preserve: the migration name, lock snapshot. Follow-up: switch large-table indexes to `CONCURRENTLY`.

### 4. Double payment (salary) — **FIN-005 / ARCH-002 / DATA-003**
Detect: two confirmed `PayrollPayment` for one calc; `audit:financial-reconciliation` REC-ORPH/REC-PR;
finance report. Contain: **stop the app** (no in-app freeze exists — OPS-018) or restrict payroll access.
Diagnose (read-only): `node scripts/audit-financial-reconciliation.mjs --company=<id> --json` → REC-PR-1/
REC-ORPH-1; find the duplicate PayrollPayment + duplicate salary Expense + duplicate CashMovement. Decide:
chief accountant. Recover: use the existing **chief-only reversal** (cancel the duplicate payment → it
cancels the salary Expense + posts a compensating cash inflow) — **do not delete rows**. Preserve: the
two payment ids, expense ids, movement ids, audit log. Follow-up: add PayrollPayment idempotency (FIN-005).

### 5. Expense / invoice double-counted
Detect: budget/analytics overstated; `audit:data-integrity` DATA-CHK-11/12. Contain: none needed (read).
Diagnose: ledgerless paid invoice (REC-INV-1) or partially_paid inconsistency (FIN-002); v1/v2 double
(DATA). Decide: accountant. Recover: correct via the append-only workflow (reverse the erroneous
payment); never edit analytics. Preserve: the invoice id + ledger. Follow-up: FIN-002/006.

### 6. Cash balance diverges — **FIN-004 / DATA-001/002**
Detect: dashboard vs collections vs analytics show different cash; manager report. Contain: none (read).
Diagnose: compute contour A (wallet) vs contour B (fact) per club/LE; identify the double-write /
snapshot-resolver split (`cash-dual-contour-impact.md`). Decide: accountant + owner (which contour is
authoritative — BD-09). Recover: no code change here — reconcile manually; a control-snapshot correction
sets the fact baseline. Preserve: the club/LE + both figures. Follow-up: FIN-004.

### 7. Files inaccessible — **ARCH-017 / OPS-002**
Detect: document 404/500 on view. Contain: none. Diagnose: `GET /api/health` → `storage` field; if
`local` and a redeploy happened, files are **gone** (not in any backup). Decide: ops. Recover: restore
from S3 if used; if `local` with no volume → **unrecoverable**. Preserve: the storageKeys. Follow-up:
enforce S3 in prod + back up uploads.

### 8. OFD not syncing — **OPS-008/010**
Detect: revenue stale; no recent `ofdSyncRun`; dashboard freshness. Diagnose: is the external timer even
configured? (no in-repo scheduler — OFD import runs only if an operator set a timer). Check `CRON_SECRET`
set (else 503). Check container TZ (day drift). Decide: ops. Recover: run the cron manually (idempotent
via dedupeKey — safe to re-run). Preserve: `ofdSyncError` rows. Follow-up: ship a scheduler; document `CRON_SECRET`.

### 9. Email not sending
Detect: OTP not delivered; login blocked. Diagnose: SMTP_* set? `email.ts` falls back to dev console
transport if absent (prod → no delivery). Decide: ops. Recover: fix SMTP creds. Preserve: `otp.delivery_failed`
audit rows (recipientDomain only). Follow-up: SMTP-failure alert.

### 10. Credential leak
Detect: secret exposed in logs/repo/screenshot. Contain: **rotate immediately** (SESSION_SECRET, OTP_SECRET,
DB password, S3 keys, OFD_SECRET, Telegram token). Note: rotating `SESSION_SECRET` invalidates sessions;
`OFD_SECRET` re-encrypts stored OFD creds. Diagnose: scope of exposure. Decide: owner. Recover: rotate +
redeploy; force re-login. Preserve: where it leaked. Follow-up: document a rotation procedure (currently
missing — OPS-017); confirm no secret is logged (logging-spec).

### 11. Suspected cross-tenant access — **Audit-5 territory**
Detect: a user seeing another company's data; a foreign `clubId`/`companyId` in a request. Contain:
restrict the suspect account. Diagnose: **note that failed authorization is NOT logged (OPS-006)** — pull
`AuditLog` for the actor + the object's companyId; run `audit:data-integrity` tenant checks (DATA-CHK-01..07).
Decide: security + owner. Recover: none in code (read audit); this is a security finding for Audit-5.
Preserve: the request, the actor, the object ids. Follow-up: OPS-006 (log failed authz); full IDOR verdict = Audit-5.

### 12. Backup failed — **OPS-001**
Detect: `deploy.sh` aborts ("backup failed/empty"); or (recommended) a backup-age alert. Contain: **do not
deploy** (deploy already aborts on backup failure — good). Diagnose: disk full? Postgres down? pg_dump
error? Decide: ops. Recover: fix the cause; take a manual `pg_dump -Fc`; **verify it restores** on a
disposable instance (a dump is not a backup until restored). Preserve: the failure log. Follow-up: off-site
copy + scheduled backups + restore rehearsal (OPS-001).

## Cross-cutting containment gap
There is **no in-app maintenance / read-only / stop-writes mode**. The only containment for a money
incident is stopping the container (also stops reads). Adding a lightweight write-freeze is recommended
(OPS-018).
