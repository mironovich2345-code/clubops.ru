# Remediation Backlog — after FULL AUDIT 2/6 (Data Model)

From `docs/audits/full-audit-02-data-model.md` (DATA-###) + linked ARCH-### from Audit 1. Target:
before **2026-08-18**. Nothing here was fixed during the audit. Effort XS/S/M/L/XL. **Data fixes are
never bundled** — each migration/backfill is its own gated task with a production preflight and
rollback.

## Ordering principle
Audit-1 code fixes (ARCH-002/003 transactions) and Audit-2 data fixes are **coupled**: fix the
write path (transaction + idempotency) **before** any backfill, or a backfill runs against a still-
racy writer. Run `audit:data-integrity` on a **production read replica** before AND after every
data task.

## P0 — release blockers
| ID | Task | Modules | Deps | Schema? | Data migration? | Preflight | Live gate | Effort |
|---|---|---|---|---|---|---|---|---|
| DATA-003 | Add `PayrollPayment.idempotencyKey @unique` + wrap `recordPayment` in `$transaction` (with ARCH-002) | payroll | ARCH-002 | **yes (additive unique)** | no | DATA-CHK-14 + dup-payment scan | **yes** (double-click on staging) | M |
| DATA-001 / DATA-002 | One cash resolver; stop double-writing expense/payroll into contour A (make `CashMovement` audit-only or source cash effect from `Expense` only) | cash, payroll | ARCH-001/006 | maybe | **yes (reconcile A vs B first)** | contour A-vs-B divergence report | yes (compare all cash screens) | L |
| DATA-008 | Add `Company.isActive`/`archivedAt`; block hard-delete; archive instead | tenancy | — | **yes (additive)** | no | cascade-exposure (DATA-CHK-25) | yes | M |

## P1 — before 18 Aug
| ID | Task | Deps | Schema? | Data migration? | Effort |
|---|---|---|---|---|---|
| DATA-005 | Verify invoice `pay` UI; retire/convert the ledgerless legacy pay (ARCH-010) | — | no | maybe backfill legacy paids | S |
| DATA-007 | Tenant-scope Prisma extension / `assertInScope` helpers; run DATA-CHK-01…07 on prod (full verdict → Audit #5) | ARCH-005 | no | no | L |
| DATA-009 | Enforce LegalEntity non-deletion (soft `isActive` already exists); block SetNull attribution loss | — | maybe | no | S |
| DATA-010 | Stop writing a payroll-row id into `EmployeeFinancialObligation.employeeId`; use a real employee id or a distinct column | — | maybe | backfill mislabeled rows | M |
| DATA-011 | Cancel the overpayment obligation when a regional payment is canceled | DATA-010 | no | no | S |
| DATA-012 | Add partial-unique (or tx guard) for active `BalanceSnapshot` per (club,LE,date) | ARCH-001 | **yes** | dedupe existing actives | M |
| DATA-013 | Add unique constraints / CAS for active scheme version, club_cash wallet, one-active ИП/ООО (before Postgres cutover) | — | **yes** | verify no existing dups | M |
| DATA-016 | Fold `refreshPeriodObligations` into the payment transaction (no swallowed refresh) | ARCH-002 | no | no | S |
| DATA-018 | One "budget fact" + one "profit" definition; unify payroll bp-rounding across engines | — | no | no | M |
| DATA-019 | Include v2 `verified` expenses in Plan-vs-Fact / overruns | — | no | no | S |
| DATA-024 | Wrap the period-close obligation loop in `$transaction` | ARCH-002 | no | no | S |
| DATA-025 | Add relations or app integrity checks for payroll/cash/OFD scalar links; put `audit:data-integrity` in CI | — | maybe | no | M |
| DATA-015 | Add reconcile checks for the cache-vs-ledger drift points (or derive-at-read the cheap ones) | — | no | no | M |

## P2 — after launch
| ID | Task | Effort |
|---|---|---|
| DATA-004 | Converge the two "Приход Иное" stores on `CashOtherIncome` | M |
| DATA-006 | Declare `partially_paid`; reconcile across analytics/budget/calendar | S |
| DATA-014 | `(companyId, inn)` uniqueness on LegalEntity | S |
| DATA-017 | Backfill null `expensePeriod` on paid invoices | XS |
| DATA-020 | Count v2 approved-unpaid refunds as debt/budget-used | S |
| DATA-021 | One refund date basis across aggregators | S |
| DATA-022 | Local-component date formatting; normalize import dates (UTC drift) | S |
| DATA-023 | Populate or remove dead link fields (`sourceCalculationId`, `cashMovementId`, `sourceId`) | XS |
| DATA-026 | Document `DailyCashReconciliation` frozen value as an attestation (or recompute on read) | XS |

## Production verification checklist (run BEFORE any fix)
`npm run audit:data-integrity` against a **production read replica**, focusing on: DATA-CHK-01/02/04
(tenant mismatch), 08 (payroll orphans / phantom payments), 09 (duplicate active snapshots), 11
(ledgerless paid), 12 (overpayment), 14 (duplicate idempotency), 06 (obligation employeeId not an
employee → DATA-010). **A clean dev result proves nothing about production.**

## Coupling to Audit 1
DATA-003/016/024 ride on **ARCH-002** (payroll transaction); DATA-001/002 on **ARCH-001/006** (cash
resolver/contours); DATA-005 on **ARCH-010**; DATA-007 on **ARCH-005** (full IDOR verdict deferred
to Audit #5). Sequence the write-path (ARCH) fix before the data (DATA) backfill in each pair.
