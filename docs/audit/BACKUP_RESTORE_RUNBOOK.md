# CLUB-OPS — Backup & Restore Runbook

> STATUS: **NOT FULLY VERIFIED.** No real restore has been executed in this audit. This block remains a pilot release **condition**, not a completed item. Do not claim backups are usable until the isolated restore test below passes.

## What exists today

- Production data: PostgreSQL on Railway. Uploaded documents: local FS or S3-compatible bucket (`STORAGE_PROVIDER`).
- Migrations: `prisma migrate deploy` (production schema) is the forward path; no `prisma db push` in production.
- No automated backup job, retention policy, or tested restore is wired in the repository. Railway managed Postgres may provide platform snapshots — this must be confirmed in the Railway project settings (out of repo scope).

## Backup checklist (to establish before pilot)

- [ ] PostgreSQL automated backup enabled (Railway managed backup OR scheduled `pg_dump`).
- [ ] Backup frequency defined (recommend ≥ daily for a pilot).
- [ ] Retention defined (recommend ≥ 7 daily + 4 weekly).
- [ ] Backups stored in a location separate from the live DB (and, for future customers, isolated per deployment).
- [ ] Document storage (S3 bucket / FS) backup or versioning enabled.
- [ ] Backups encrypted at rest; access restricted.
- [ ] Named responsible operator + contact.
- [ ] RPO and RTO documented (recommend RPO ≤ 24h, RTO ≤ 4h for pilot).
- [ ] Secrets (`SESSION_SECRET`, `OTP_SECRET`, SMTP, DB) backed up out-of-band; rotation impact understood (rotating `SESSION_SECRET`/`OTP_SECRET` invalidates all sessions/OTP challenges — by design).

## Restore runbook (manual)

1. Provision a SEPARATE empty Postgres instance (NEVER restore over production).
2. Restore the latest dump:  `pg_restore --clean --if-exists -d "$TEST_DATABASE_URL" latest.dump`  (or `psql < dump.sql`).
3. Point a throwaway app instance at `TEST_DATABASE_URL` (a non-production env). Do NOT use the production `DATABASE_URL`.
4. Run `prisma migrate deploy --schema=prisma/production/schema.prisma` to confirm the schema head matches the code.
5. Restore document storage to a test bucket/path; point `STORAGE_PROVIDER` at it.

## Post-restore verification checklist

- [ ] `prisma migrate status` shows no pending/failed migrations.
- [ ] Row counts for `User`, `Company`, `Club`, `Invoice`, `Expense`, `Refund`, `Sale`, `AuditLog` are within expected range vs source.
- [ ] One known invoice/expense opens with its document (storage restore works).
- [ ] Login works end-to-end (password + OTP) against the restored DB on the test instance.
- [ ] A spot-checked financial total (dashboard debt, a club budget) matches the pre-backup value.
- [ ] No production secrets were used and the test instance is destroyed afterward.

## Isolated restore-test plan

Run the restore runbook against a disposable Postgres + disposable storage bucket in a non-production environment, complete the verification checklist, record the date/operator/result here, then flip STATUS to "VERIFIED (date)". Until then this block blocks any claim of disaster-recovery readiness.
