# Backup / Restore Rehearsal

Two parts: (A) a **production-parity** Postgres rehearsal — **NOT EXECUTED** (no Postgres/Docker in
the sandbox); (B) a **disposable sqlite** restore-mechanics rehearsal that **WAS executed** and
surfaced a real backup gotcha. A restore is proven only when part A passes on production-shaped data.

## Part A — Production Postgres restore (status: NOT EXECUTED)
Runbook to execute on a disposable host (never production):
1. Take/obtain a `pg_dump -Fc` from `/opt/club-ops/backups/clubops_<ts>.dump` (record its timestamp = RPO point).
2. Fresh disposable Postgres; `pg_restore --clean --if-exists -d "$URL" clubops_<ts>.dump` (time it = RTO).
3. Restore uploaded files (S3 bucket copy, or the `club_ops_uploads` volume) — **if local storage was used, there is no file backup (OPS-002).**
4. Start the app against the restored DB + files.
5. Verify: login; role access; list invoices/expenses/refunds; open a document (file restore); cash balances render; payroll reads; audit logs present.
6. Read-only reconciliation on the restored DB: `audit:data-integrity` + `audit:financial-reconciliation`.
7. Record: backup timestamp, restore duration (RTO), missing objects, row counts, broken links, PASS/FAIL.

**Result: NOT EXECUTED** — RPO/RTO **unknown**; restore **unproven**. This is the single most
important open operational gate (OPS-001).

## Part B — Disposable sqlite restore-mechanics (status: EXECUTED, illustrative only)
Executed against a throwaway copy of the **dev** sqlite DB (NOT production; a different engine):
1. Source row counts (dev): `company=11, club=8, expense=1, payrollCalculation=1`, others 0.
2. "Backup" = `cp prisma/dev.db → scratch/restore-rehearsal.db` (2,154,496 bytes).
3. "Restore" = point a throwaway `DATABASE_URL` at the copy; query counts.
4. Ran `audit:financial-reconciliation` against the copy → **connected and ran without error**.
5. Disposable copy deleted.

**Observed gotcha (valuable):** the copied file returned **`n/a` for every table** — a bare `cp` of a
**WAL-mode** sqlite DB without a checkpoint (or the `-wal`/`-shm` sidecar files) yields an
inconsistent/empty view. This concretely demonstrates the audit rule: **a naive file copy is NOT a
valid backup.** Production correctly uses `pg_dump -Fc` (a consistent logical dump), which does not
have this failure mode — but it reinforces that only a **verified restore** counts.

**What Part B proves:** the reconciliation tooling runs against a restored datasource via
`DATABASE_URL` override (the restore-verification step works). **What it does NOT prove:** anything
about production Postgres restore correctness, RPO, or RTO — that requires Part A.

## Overall result
| | Status |
|---|---|
| Production Postgres restore | **NOT EXECUTED** — unproven |
| RPO | **unknown** (backups only on deploy; see `backup-policy.md`) |
| RTO | **unknown** (never timed) |
| Restore-verification tooling | works (Part B) |
| Blocker | **OPS-001 — no proven restore; execute Part A on staging before launch** |
