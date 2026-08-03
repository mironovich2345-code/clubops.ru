# FULL AUDIT 4/6 — Baseline (Deployment, Infrastructure, Backup, Restore, Operations)

Frozen state. **Nothing was deployed, no production was touched, no migration was run against any
real database, no schema/logic changed** — read-only analysis, disposable-only rehearsal runbooks,
and documentation.

## Audited commit
- **HEAD:** `dc14d1077e9a877528444446abf1210d03180b67`
- **Branch:** `main` · **vs origin/main:** 5 ahead / 0 behind (audits 3 committed locally, **not pushed**) · **tree:** clean.
- **Audit date:** 2026-08-03.

## Build / test baseline (at HEAD `dc14d10`)
| Gate | Result |
|---|---|
| `tsc --noEmit` | clean (0 errors) |
| `prisma validate` dev (sqlite) | valid |
| `prisma validate` prod (postgres) | valid |
| `pilot:full` | **3733 passed / 0 failed across 83 suites** |
| `build:prod` | compiled (exit 0) at Audit-3 close; application code unchanged since (re-run at this audit's close) |

## How the production `deploymentVersion` is resolved (not fetched here)
`src/lib/deployment-version.ts` resolves, in order: `APP_GIT_SHA` / `APP_DEPLOYMENT_ID` / `APP_ENVIRONMENT`
(Yandex/self-hosted, baked at build via Docker `ARG`), then `RAILWAY_*`, else `"local"`. It is exposed
(names only) by `GET /api/health`. **This audit runs in a sandbox with no access to the live host, so
the running production version is NOT fetched** — the documented method is: `curl https://<domain>/api/health`
→ read `commit`/`deploymentId`/`environment`. Recorded as method, not a value.

## Deploy commands / flow (from the repo)
- **Build:** `build:prod` = `prisma generate --schema=prisma/production/schema.prisma && next build` (standalone output).
- **Start:** `node server.js` (standalone). VM: compose `app` service. Railway/plain: `docker-entrypoint.sh` (migrate then `exec node server.js`).
- **Migrations:** `prisma migrate deploy --schema=prisma/production/schema.prisma`. VM: a dedicated one-shot `migrate` compose service **before** the app (`deploy/deploy.sh:220`). Railway: `docker-entrypoint.sh` auto-migrate on start.
- **Prisma generate flow:** one un-pathed generator slot shared by dev(sqlite)/prod(postgres) — they overwrite each other (ARCH-013).
- **Storage provider:** `STORAGE_PROVIDER` (default **`local`**; prod expected `s3`, not code-enforced — ARCH-017).
- **Environment mode:** `NODE_ENV=production`; secrets fail-closed via `env-secrets.ts`.
- **Deploy trigger:** systemd timer polls the registry **every minute**; deploys when the `:main` image digest changes (`deploy/systemd/club-ops-deploy.timer`). CI (`.github/workflows/deploy-yandex.yml`) builds + pushes `:sha`/`:main`.

## Open P0/P1 carried in (Audits 1–3) relevant to ops
- **ARCH-013** build:prod leaves postgres client (breaks dev pilots; reverse hazard) · **ARCH-015** health liveness-only (no DB readiness) · **ARCH-017** local storage lost on redeploy.
- **ARCH-002/003/004** payroll money write-path tx/idempotency · **DATA-008** Company hard-delete cascade+orphan · **FIN-004** cash contours diverge · **FIN-005** double-submit payroll payment.
These shape the incident/rollback/DR runbooks (money-incident containment, tenant deletion, restore).

## Scope of changes made by this audit (must remain true at completion)
- Added: read-only tooling (`scripts/audit-deploy-ops.mjs`), an audit pilot, and docs under
  `docs/operations/`, `docs/testing/`, `docs/audits/`, `docs/release/`.
- **NOT** done: any deploy, any production mutation, any migration on a real DB, any schema/logic
  change. Rehearsal docs that were **not executed** are labeled **NOT EXECUTED** — a runbook is never
  presented as a completed check, and a backup file is never presented as a proven restore.
