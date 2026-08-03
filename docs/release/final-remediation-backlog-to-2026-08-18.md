# CLUB-OPS — Final Remediation Backlog (to 2026-08-18)

The single deduplicated backlog across all six audits. Source: `docs/audits/data/final-remediation.json`
(`npm run audit:final-consolidation`) — **102 findings → 22 clusters**, 0 orphaned. Nothing here was
fixed during the audits. A cluster with `businessDecision` set **cannot ship until that decision is
ratified** (`docs/accounting/business-decisions-required.md`). Effort XS/S/M/L.

## P0 — release blockers (money distortion / data loss)
| ID | Task | Merges | BD | Migration | Test / Live gate | Effort |
|---|---|---|---|---|---|---|
| **REM-01 ✅ DONE** | Payroll payout: atomic + idempotent via shared `executePayrollPayment`/`executePayrollReversal` (all payout paths). **CLOSED:** ARCH-002/003/004, DATA-003, FIN-005, SEC-001; DATA-016 (payout paths). 27/27 real DB-backed tests; pilot:full 3888/0. **Remaining:** PostgreSQL concurrency gate on staging (`docs/testing/rem-01-payroll-payment-checklist.md`). DATA-010 + dual-contour deferred to REM-02. See `docs/remediation/rem-01-payroll-payment-report.md`. | ARCH-002/003/004, DATA-003, FIN-005, SEC-001 | — | additive (idempotencyKey) — applied | ✅ 27 DB tests; staging pg gate pending | M |
| **REM-02 ✅ CORE DONE** | Cash source unified: shared `activeSnapshotWhere` resolver + single `resolveCashBalance` + cutover guard (`cashCanonicalCutoverAt` → legacy CashMovement double-write stops). **CLOSED:** ARCH-001, DATA-001, DATA-002 (cutover-gated), FIN-004 (formula). **PARTIAL:** ARCH-006, UX-005, DATA-012/013 (active-uniqueness DB constraint + `/expenses/cash` relabel + company-wide cutover = continuation). 13/13 real DB tests; reconcile:cash-contours + preflight:cash-cutover; pilot:full 3913/0. **Remaining:** PostgreSQL concurrency gate + production reconciliation on a replica. See `docs/remediation/rem-02-final-report.md`. | ARCH-001/006, DATA-001/002, FIN-004 | **BD-09** (ratified: contour B official) | additive (cashCanonicalCutoverAt) — applied | ✅ 13 DB tests; staging pg gate + prod reconcile pending | L |
| **REM-03** | Backup: scheduled off-site encrypted `pg_dump` + a **rehearsed** restore with recorded RPO/RTO | OPS-001 | — | none | restore rehearsal (G10) | M |
| **REM-04** | File durability: enforce `STORAGE_PROVIDER=s3` in prod at startup + include uploads in backup | OPS-002, ARCH-017 | — | none | redeploy file-survival (G12) | S |

## P1 — before 18 Aug
| ID | Task | Merges | BD | Effort |
|---|---|---|---|---|
| REM-05 | One profit + one budget-fact definition; include v2 `verified` in fact/overruns | FIN-001/003, DATA-018/019 | **BD-03, BD-04** | M |
| REM-06 | `/api/health/ready` (DB `SELECT 1`) for traffic gating + validate `DATABASE_URL` at startup | ARCH-015, OPS-003, OPS-013 | — | S |
| REM-07 | Log denied authorization (page/company/club/capability) + request id | OPS-006, SEC-009 | — | M |
| REM-08 | Retire/convert the legacy ledgerless invoice `pay`; declare `partially_paid` | ARCH-010, DATA-005, FIN-006 | — | S |
| REM-09 | `Company` soft-delete + tenant-scoped export/restore | DATA-008, OPS-016 | — | L |
| REM-10 | Fold obligation refresh into the payment transaction (no stale «к выплате») | DATA-016, FIN-012 | — | S |
| REM-11 | Rate-limit hardening: trusted-proxy IP source, AI cost caps (refund/payroll), fail-closed on auth | SEC-002/003/008 | — | S |
| REM-12 | Host allowlist for OFD `serverBaseUrl` (Taxcom + Astral) | SEC-004 | — | S |
| REM-13 | CI/`postbuild`: regenerate the dev Prisma client after `build:prod`; assert provider at start | ARCH-013, OPS-004 | — | XS |
| REM-14 | DB-backed behavior tests that execute the real money engines (compute/invoice-payments/cash-balances/obligation/budget-linkage) | ARCH-022 | — | L |
| REM-15 | **Business decision** on tax/VAT model (no invented rates) | FIN-007 | **BD-13/05** | S (decision) |
| REM-16 | Fix `EmployeeFinancialObligation.employeeId` type confusion; ratify LE attribution | DATA-010, FIN-014 | **BD-06/07/11** | M |
| REM-17 | Ship an OFD/notification scheduler + pin timezone + minimal monitoring/alerts (backup/migration/OFD-stale/reconciliation/repeated-payment) | OPS-007/008/010 | — | M |
| REM-18 | In-app write-freeze / maintenance mode for money-incident containment | OPS-018 | — | M |

## P2 — after launch (or before if time permits)
| ID | Task | Merges | Effort |
|---|---|---|---|
| REM-19 | Medium batch: storageKey token, CSV escape, confidence clamp, obligation replay, cache-drift checks, refund treatment (BD-02), ООО cash-expense term, rounding unify, revenue double-count check (BD-14), dead fields | SEC-005/006/007/010/011, DATA-004/011/012/013/015/024, FIN-002/008/009/010/013/016/017 | M |
| REM-20 | Prisma tenant-scope extension (DB backstop for the manual isolation) | ARCH-005, DATA-007/025 | L |

## P3 — low / consistency
| ID | Task | Effort |
|---|---|---|
| REM-21 | `cancelled`/`canceled` + terminology consistency, `partially_paid` label, enumeration/timing, archived-club invite, client idempotencyKey, removeClubAssignment scope, structured logging, magic-strings, N+1, audit-swallow, page.tsx→loader, INN unique, expensePeriod backfill, refund date basis, UTC drift, LE SetNull, + ratify BD-12 | M |

## DEFERRED — not launch-affecting
| ID | Task |
|---|---|
| REM-22 | v1/v2 workflow migration; `xlsx` replacement; white-label i18n; expand-contract migrations + `CONCURRENTLY` indexes; god-file refactors; dead-code removal; CRON_SECRET doc |

## The 5 business decisions that unblock the most work (ratify FIRST)
BD-03 (profit) · BD-04 (budget fact) · BD-09 (official cash contour) · BD-13 (tax model) · BD-02
(refund treatment). Without these, REM-02/05/15/19 cannot be implemented correctly.

## Sequencing note
Fix each **write-path once**: REM-01 closes six findings; REM-02 closes five; REM-05 closes four;
REM-07 closes two. Do the ARCH/DATA write-path fix **before** the FIN accounting-definition change in
each pair, and run `audit:data-integrity` + `audit:financial-reconciliation` on a prod replica before
and after any data-affecting task.
