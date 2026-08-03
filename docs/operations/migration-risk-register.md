# CLUB-OPS — Migration Risk Register

Read-only analysis of the production migration history at `dc14d10` (72 migrations,
`prisma migrate deploy`). Machine data: `docs/audits/data/migration-risks.json`
(`npm run audit:migration-risk`). **No migration was run against any real DB.**

## Headline
- **All of the last 15 migrations are purely additive and structurally rollback-safe** — only `CREATE TABLE`, `ADD COLUMN`, `CREATE INDEX`, and one FK. **No `DROP`, no `ALTER COLUMN … TYPE`, no `ALTER COLUMN SET NOT NULL`, no volatile/computed DEFAULT, no `ADD COLUMN NOT NULL` without a default.** None would fail on a populated table; none forces a full-table rewrite.
- **Rewrite risk: zero.** Every `NOT NULL` column added to an existing table carries a **constant** default (`false`/`0`/`1`/`'active'`/`'manual'`/`'suggested'`/`'legacy_v1'`). On Postgres 11+ (the prod target) a constant default is a metadata-only catalog update — no heap rewrite. (Pre-PG11 would rewrite; target is modern.)
- **The one real operational risk: plain (non-`CONCURRENTLY`) index builds on populated tables.** `CREATE INDEX CONCURRENTLY` is used **nowhere** (grep: 0). Every index build takes a `SHARE` lock that **blocks writes (not reads)** to that table for the build duration.

## Last-15 severity (S0 metadata-only · S1 brief write-lock · S2 rewrite/backfill · S3 destructive)
| Migration | Ops | Risk | Sev |
|---|---|---|---|
| payroll_payment_obligation | new table + idx | none (new) | S0 |
| salary_budget_change_proposal | ALTER Company +6 (constant defaults) + new table | metadata | S0 |
| invoice_prepayment_status | ADD nullable col | metadata | S0 |
| invoice_payment | new table + **FK→Invoice** | brief metadata lock on Invoice (no scan) | S1 |
| balance_snapshot_cancellation | ADD 3 nullable | metadata | S0 |
| cash_regional_transfer_and_snapshot_versioning | ALTER +constant defaults + new table + **plain idx on BalanceSnapshot** | write-lock on populated BalanceSnapshot | **S1** |
| add_multi_account_container | 2 new tables | none | S0 |
| ofd_cash_register_history | ALTER +constant default + **plain idx on OfdCashRegisterMapping** + new tables | write-lock | **S1** |
| ofd_cashier_payroll_attribution | ALTER +constant defaults + new tables | metadata | S0 |
| payroll_scheme_versions | ALTER +constant defaults + **UNIQUE + plain idx on EmployeePayScheme** | 2 write-locks (unique safe: new col all-NULL) | **S1** |
| payroll_change_requests | ADD nullable + new table | metadata | S0 |
| payroll_advance_tranches | ADD 3 nullable + new table | metadata | S0 |
| payroll_engine_version | ADD col constant default | metadata | S0 |
| astral_ofd_external_ids | ALTER +constant defaults + **plain idx on OfdCashRegisterMapping** | write-lock | **S1** |
| regional_city_payroll | 2 new tables | none | S0 |

## Plain index builds on populated tables (the pattern to flag) — OPS-MIG
1. `BalanceSnapshot_clubId_legalEntityId_status_snapshotDate_idx` on `BalanceSnapshot`.
2. `OfdCashRegisterMapping_status_idx` + `..._provider_externalKktId_idx` on `OfdCashRegisterMapping`.
3. `EmployeePayScheme_sourceChangeRequestId_key` (UNIQUE) + `EmployeePayScheme_status_idx` on `EmployeePayScheme`.
- The UNIQUE index on `EmployeePayScheme` is **not** a collision risk (the source column is newly added, all-NULL; Postgres allows multiple NULLs).
- The `InvoicePayment→Invoice` FK briefly locks `Invoice` to attach the constraint but runs no validation scan (child table empty).

**Impact:** at current beta scale these locks are milliseconds. On a large table (`OfdReceiptImport`,
`OfdReceiptItem`, `AuditLog` will grow fastest) a plain `CREATE INDEX` would stall **writes** for the
build. Because `CONCURRENTLY` is used nowhere, this is the standing risk for any **future** large-table
index — and any future non-additive change (`DROP`, type change, `SET NOT NULL`, unique on populated
data) would be a genuine S2/S3 that this history has so far avoided.

## Reversibility
All additive → a "rollback" = drop the new tables/columns/indexes; no data transformation to undo.
Prisma has **no down-migrations**, so "reversible" means structurally non-destructive, not scripted
reversal. A bad migration is recovered by restoring the pre-deploy `pg_dump` (see `rollback-runbook.md`).

## Rule for future migrations (recommendation, not enforced here)
Additive-only + constant defaults + **`CREATE INDEX CONCURRENTLY` on any populated table** +
expand/contract for any column removal or type change + never `ADD COLUMN NOT NULL` without a default.
Gate every migration through `staging-migration-rehearsal.md` before production.
