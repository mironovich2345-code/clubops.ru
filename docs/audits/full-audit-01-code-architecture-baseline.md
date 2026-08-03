# FULL AUDIT 1/6 — Baseline (Code Architecture, Dependencies, Maintainability)

Frozen snapshot of the audited state. **No business logic, schema, or production data was
changed to produce this audit** — only read-only scripts, docs, and an audit-verification pilot.

## Audited commit
- **HEAD:** `71f1cff357100bb5e7e72b6f105341ecb5113f8d`
- **Branch:** `main`
- **origin/main:** `0e729d014af872bfafc3e1c360272b2e5ccba697` — local `main` is **8 commits ahead, 0 behind** (the payroll-budget-payment-planning epic is committed locally but **not pushed**).
- **Working tree at audit start:** clean (only two untracked pre-existing guide files: `docs/guides/cash-movements-guide.md`, `docs/guides/control-balance-snapshots-guide.md`).
- **Audit date:** 2026-08-02 → 2026-08-03.

## Last 30 commits (most recent first)
`71f1cff` docs payroll-budget final · `0f651c2` pilot payroll-budget (68) · `58c6e9c` WAVE 5 preflight/backfill · `40a96b5` WAVE 4 obligation cancel · `5fb3211` WAVE 3 obligation+calendar · `2767381` WAVE 2 budget linkage · `02ac7ac` WAVE 1 forecast · `495b103` WAVE 0 audit · `0e729d0` regional-dashboard guide · `c22d1ab` regional pilot · `512c349` regional list filter · `e5dcf90` regional cards · `d035af5` regional predicates · `6d91a2c` regional audit · `0b3a23f` invoice payment guide · `67f0511` invoice pilot (45) · `d44daef` invoice partial=remaining · `b746dab` invoice backfill/dedupe · `a6702f5` invoice payment UI · `9c562f7` invoice payments actions · `6b2a90b` InvoicePayment model · `e1117a8` invoice audit · `0e7ed9a` collections guides · `bc67c61` collections pilot · `a82983d` collections UI reorder · `063bf9f` snapshot cancellation · `f4b73d6` collections audit · `ad41c05` release baseline 2026-08-01 · `b755603` cash guides · `5414a39` cash pilot.

## Build / test baseline (re-run at HEAD `71f1cff`)
| Gate | Result | Notes |
|---|---|---|
| `tsc --noEmit` | **clean** (0 errors) | full project |
| `prisma validate` (dev, sqlite) | **valid** | `prisma/schema.prisma` |
| `prisma validate` (prod, postgres) | **valid** | `prisma/production/schema.prisma` (dummy `DATABASE_URL`) |
| `pilot:full` | **3641 passed / 0 failed across 80 suites** | after the dev Prisma client is generated (see caveat) |
| `build:prod` | **compiled (exit 0)** | `prisma generate --schema=prisma/production/schema.prisma && next build` |

### ⚠️ Baseline caveat that proves "green build ≠ production-ready"
`build:prod` runs `prisma generate` against the **production (postgres)** schema and leaves the
local Prisma client generated for postgres. Immediately after a `build:prod`, `pilot:full`
reports **1299/0 with 34 suites failing** because the 34 DB-backed pilots import a client that no
longer matches the local sqlite dev DB. Running `prisma generate --schema=prisma/schema.prisma`
restores the dev client and `pilot:full` returns to **3641/0**. This is recorded as finding
**ARCH-013** (build side-effect on the dev client / no post-build client-restore step) and is the
concrete reason this audit does **not** treat a green build as production readiness.

## Codebase size (read-only static scan — `npm run audit:codebase-metrics`)
- **TS/TSX files:** 481 · **total LOC:** 71,860 (tsx 28,346)
- **Prisma models:** 82 · **enums:** 0 (statuses are string constants in lib)
- **Migrations:** dev 75 / prod 72 → **drift of 3** (early dev-only sqlite migrations; see ARCH-014)
- **Pilot suites:** 80 (79 real + runner) · **~3,589 `check()` assertions**
- **Server actions:** ~263 across 59 `"use server"` files · **API routes:** 17 · **use client:** 112
- **Files > 500 LOC:** 17 · **functions > 100 LOC:** 55
- **TODO/FIXME/HACK:** 11 (all TODO) · **`any`:** 7 · **`@ts-ignore`:** 0 · **eslint-disable:** 7 · **console.*:** 59 · **raw SQL:** 2 (parameterized advisory locks) · **`$transaction`:** 46 uses in 27 files
- **hardcoded role/status string literals:** ~1,118 (magic strings, not centralized enums — ARCH-011)

## Known OPEN live GATEs (manual acceptance not yet done — from prior epics)
These are documented "green in code, pending live acceptance" items and remain open at this HEAD:
- **Payroll → budget → payment planning** — manual GATE checklist pending (`docs/testing/payroll-budget-payment-planning-checklist.md`); obligations never exercised against a live approved period with a real pay schedule.
- **Invoice partial payments** — GATE-pending live acceptance (per memory).
- **Owner cabinet** — viewer scroll + invitation flow need real-iPhone acceptance.
- **Regional dashboard review tasks** — manual GATE checklist pending.
- **Mobile/PWA** — WAVE 3–5 + device QA remain.

## Production areas NOT verified by this audit (require live/staging)
- **Postgres runtime behavior** — all pilots run on **sqlite**; no test executes against postgres. Prod-only constraints, `FOR UPDATE` locking, and concurrency behave differently on postgres.
- **Migration apply on a populated prod DB** — only `prisma validate` + `migrate diff` were run; no apply against real data.
- **External integrations live** — OFD (Taxcom live / Astral BLOCKED / Saby dormant), AI providers, S3 storage, SMTP, Telegram: exercised only via mocks/scaffolds.
- **Deploy/rollback** — the Yandex VM deploy path, `pg_dump` backup, and app-rollback (DB **not** rolled back) were read, not executed.
- **Zero-downtime** — not guaranteed; the app can transiently run against a newer schema (ARCH-016).
- **Real financial data reconciliation** — the legacy `CashWallet`/`CashMovement` ledger vs the newer fact-balance contour has not been reconciled against production data (ARCH-006).

## Scope of changes made by this audit (must stay true at completion)
- Added: read-only audit scripts (`scripts/audit-*.mjs`), an audit-verification pilot
  (`scripts/pilot-full-audit-01-code-architecture.mjs`), and documentation under `docs/`.
- **NOT** changed: any `src/**` business logic, `prisma/**` schema or migrations, RBAC, financial
  formulas, statuses, model names, UI behavior. No production data was touched. No deploy was run.
