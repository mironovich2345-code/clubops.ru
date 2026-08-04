# Readiness Runbook (REM-06)

## Endpoints
- `/api/health/live` — process up (orchestrator restart signal). Never touches dependencies.
- `/api/health/ready` — traffic gate: 200 = accept traffic, 503 = stop. Required = DB + schema +
  provider + storage (prod).
- `/api/health/dependencies` — diagnostics (DB/storage/SMTP/AI/OFD/backup/scheduler), sanitized.

## "App is up but users get errors"
1. `GET /api/health/ready`. If 503, read `checks[]` for the failed `name` + `errorCode`.
2. `database` failed → DB down/unreachable → check the DB; readiness clears automatically on recovery.
3. `schema_migrations` failed → `pending_migration` (apply migrations) or `failed_migration` (a rolled-
   back/half-applied migration — use the migration/rollback runbook).
4. `prisma_provider` failed → the running client speaks a different DB than expected — regenerate the
   correct client for the environment and redeploy (ARCH-013).
5. `storage` failed (prod) → S3 unreachable/misconfigured — see `file-storage-runbook.md`.
6. `database_url` failed → mis-shaped/sqlite/localhost URL — fix the env; the app should have failed
   fast at startup.

## CLI
`npm run audit:readiness [--json] [--production]` — same contract, read-only, secrets redacted. Use on
a replica before go-live.

## Do NOT
- Do not force traffic to a `not_ready` app. Do not apply migrations from the health endpoint. Do not
  log the full `DATABASE_URL`.
