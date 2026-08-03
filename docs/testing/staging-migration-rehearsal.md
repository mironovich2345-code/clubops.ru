# Staging Migration Rehearsal — RUNBOOK (status: NOT EXECUTED)

**Status: NOT EXECUTED.** This audit ran in a sandbox with **no PostgreSQL server and no Docker**
(`pg_dump`/`psql`/`pg_restore` absent, `docker` unavailable). A production-parity migration rehearsal
requires a disposable Postgres and was therefore **not performed**. This is a precise runbook to
execute on a disposable Postgres before the next production migration — it is **not** evidence of a
passed check.

## Preconditions
- A **disposable** PostgreSQL (matching the prod major version) — never the production DB.
- A recent production `pg_dump -Fc` (from `deploy.sh` backups) OR an anonymized copy.
- The repo at the release commit; `prisma/production/schema.prisma` + `prisma/production/migrations/`.

## Steps
1. **Restore a near-production copy**
   `pg_restore --clean --if-exists -d "$STAGING_URL" clubops_<ts>.dump`
2. **Baseline row counts + checksums of critical tables**
   For `Company, Club, LegalEntity, Invoice, InvoicePayment, Expense, Refund, PayrollCalculation,
   PayrollPayment, BalanceSnapshot, CashCollection, CashWithdrawal, CashRegionalTransfer,
   OfdReceiptImport, AuditLog`: `SELECT count(*)` and a money checksum
   `SELECT coalesce(sum("amountKopeks"),0)` where present. Save to `before.json`.
3. **Apply pending migrations**
   `DATABASE_URL="$STAGING_URL" npx prisma migrate deploy --schema=prisma/production/schema.prisma`
   — record wall-clock duration and watch `pg_stat_activity` / `pg_locks` for lock waits (esp. the
   5 plain index builds flagged in `migration-risk-register.md`).
4. **Validate schema:** `DATABASE_URL="$STAGING_URL" npx prisma validate --schema=prisma/production/schema.prisma`.
5. **Production build against staging** (optional): `npm run build:prod` (note ARCH-013 — regenerate the dev client afterwards).
6. **Smoke:** start the app against `$STAGING_URL`; log in; open an invoice, a document, a cash balance, a payroll period.
7. **Read-only integrity + reconciliation against staging:**
   `DATABASE_URL="$STAGING_URL" node scripts/audit-data-integrity.mjs --json`
   `DATABASE_URL="$STAGING_URL" node scripts/audit-financial-reconciliation.mjs --json`
8. **Compare row counts** `after.json` vs `before.json` — **counts must be unchanged** by a pure schema migration (no backfill was run).
9. **Assert financial sums unchanged** — every money checksum must equal `before.json` (a migration must not silently alter money).
10. **Record** duration, peak locks, any blocked-writes window, and PASS/FAIL.

## Pass criteria
- `migrate deploy` succeeds; `prisma validate` passes; build compiles.
- Row counts and money checksums **identical** before/after (additive migration = no data change).
- No unexpected long write-lock (flag any plain-index build that stalls writes on a large table).
- `audit:data-integrity` and `audit:financial-reconciliation` show **no new** violations vs the pre-migration run.

## What this proves / does not
Proves the pending migrations apply cleanly and change no data on a production-shaped DB. Does **not**
replace the production `deploy.sh` backup-before-migrate. **Until executed on real staging, migration
safety is asserted from the SQL only (see `migration-risk-register.md`: last-15 additive), not proven.**
