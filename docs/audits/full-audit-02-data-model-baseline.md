# FULL AUDIT 2/6 — Baseline (Data Model, Relationships, Status Sources, Integrity)

Frozen state of the audited system. **No schema, migration, data, or business logic was changed**
to produce this audit — only read-only diagnostic scripts and documentation.

## Audited commit
- **HEAD:** `66bc9e3ec7b354a9788fe31250391c09a8e3169d`
- **Branch:** `main` · **vs origin/main:** 0 ahead / 0 behind (in sync)
- **Working tree at start:** clean (two pre-existing untracked guide files only).
- **Audit date:** 2026-08-03.

## Build / test baseline (at HEAD `66bc9e3`)
| Gate | Result |
|---|---|
| `tsc --noEmit` | clean (0 errors) |
| `prisma validate` dev (sqlite) | valid |
| `prisma validate` prod (postgres) | valid |
| `pilot:full` | 3672 passed / 0 failed across 81 suites |
| `build:prod` | compiled (exit 0) at Audit-1 baseline; unchanged application code since |

### Prisma client provider before/after `build:prod` (ARCH-013, re-confirmed)
`build:prod` runs `prisma generate --schema=prisma/production/schema.prisma`, leaving the local
client generated for **postgres**. The 34 DB-backed pilots (and the new `audit:data-integrity`
script) then fail to run against the local **sqlite** dev DB until
`prisma generate --schema=prisma/schema.prisma` is re-run. **Always regenerate the dev client after
a `build:prod` before running DB-backed pilots or the data-integrity preflight.**

## Data-model size (read-only schema parse — `npm run audit:data-model-catalog`)
- **82 models** · 90 relations (56 `onDelete: Cascade`, 11 `SetNull`) · 0 Prisma enums.
- **97 money fields** across 39 models — **all `Int` kopeks, 0 non-integer, 0 unsuffixed** (money typing is clean).
- **40 models carry a `status`** field; **3 versioned** (`version`), **4 with `idempotencyKey`**.
- Tenant scoping: **66 models have `companyId`, 58 `clubId`, 31 `legalEntityId`** (heavily denormalized).
- Migrations: dev 75 / prod 72 (drift 3, per ARCH-014).

## Open P0/P1 carried over from Audit 1 (must be read alongside this audit)
- **ARCH-001** — divergent snapshot resolvers (dashboard shows a cancelled snapshot's balance).
- **ARCH-002 / ARCH-003 / ARCH-004** — payroll payments/advances: no transaction / no idempotency / money written on the global client.
- **ARCH-006** — two cash contours (legacy `CashWallet` ledger still written).
- **ARCH-010** — two invoice payment paths (ledgerless `paid` possible).
- **ARCH-022** — false-green test architecture (money engines not executed).
This audit (#2) supplies the DATA-### evidence underneath ARCH-001/002/006/010 and adds new
data-integrity findings.

## Read-only data-integrity preflight (run at baseline)
`npm run audit:data-integrity` — 21 SELECT-only checks executed against the **dev** sqlite DB:
**1 offending row** found (DATA-CHK-03: one club/legal-entity pair used without a `ClubLegalEntity`
association — seed/dev artifact), 0 checks errored. **A clean dev result does NOT prove production
is clean** — the same script must be run against a production read replica (§22 of the plan).

## Scope of changes made by this audit (must remain true at completion)
- Added: read-only scripts (`scripts/audit-data-model-catalog.mjs`, `scripts/audit-data-integrity.mjs`),
  an audit pilot (`scripts/pilot-full-audit-02-data-model.mjs`), and docs under `docs/data/` +
  `docs/audits/`.
- **NOT** changed: any `src/**` logic, `prisma/**` schema/migrations, statuses, RBAC, formulas,
  model names, or production data. No repair/backfill/migration was run.
