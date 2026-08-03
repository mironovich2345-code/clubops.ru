# FULL AUDIT 3/6 — Baseline (Accounting Model, Financial Flows, Formulas, Reconciliation)

Frozen state. **No formula, status, schema, data, or business logic was changed** — read-only
analysis, diagnostic SELECT-only scripts, and documentation only.

## Audited commit
- **HEAD:** `d161c1512ae740257c83f1144865ebe40ef49134`
- **Branch:** `main` · **vs origin/main:** 0 / 0 (in sync) · **tree:** clean.
- **Audit date:** 2026-08-03.

## Build / test baseline (at HEAD `d161c15`)
| Gate | Result |
|---|---|
| `tsc --noEmit` | clean (0 errors) |
| `prisma validate` dev (sqlite) | valid |
| `prisma validate` prod (postgres) | valid |
| `pilot:full` | **3704 passed / 0 failed across 82 suites** |
| `build:prod` | compiled at prior baseline; application code unchanged since (re-run at close of this audit) |

**ARCH-013 reminder:** `build:prod` regenerates the Prisma client for postgres; always
`prisma generate --schema=prisma/schema.prisma` afterward before running DB-backed pilots or the
reconciliation preflight.

## Open findings carried in (Audits 1–2) that this audit builds on
- **ARCH-001** divergent snapshot resolvers · **ARCH-002/003/004** payroll payment tx/idempotency · **ARCH-006** two cash contours · **ARCH-010** two invoice pay paths · **ARCH-022** false-green tests.
- **DATA-001** cash ООО/ИП competing figures · **DATA-002** expense/payroll double-write both contours · **DATA-003** PayrollPayment no idempotency · **DATA-005** ledgerless paid · **DATA-008** Company hard-delete · **DATA-010** obligation.employeeId · **DATA-016** obligation lags calc · **DATA-018/019** budget-fact/profit definitions · **DATA-025** scalar-only links.

This audit (#3) supplies the **accounting interpretation** under those: recognition rules, profit /
budget-fact / cash formulas, reconciliation equations, and the **business decisions** that code
cannot settle.

## Known live GATEs still open (carry-over)
Payroll-budget-payment-planning, invoice partial payments, owner cabinet, regional dashboard,
mobile/PWA — manual acceptance pending (see Audit-1 baseline).

## Scope of changes made by this audit (must remain true at completion)
- Added: read-only reconciliation tooling (`scripts/audit-financial-reconciliation.mjs` +
  `scripts/audit-formula-map.mjs`), an audit pilot, and docs under `docs/accounting/` + `docs/audits/`.
- **NOT** changed: any `src/**` formula/logic, `prisma/**`, statuses, RBAC, or production data. No
  backfill/repair/migration was run. A mathematically-convergent formula is **not** treated as
  accounting-correct without a confirmed business rule (see `business-decisions-required.md`).
