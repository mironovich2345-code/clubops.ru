# Remediation Backlog — after FULL AUDIT 1/6 (Code Architecture)

Derived from `docs/audits/full-audit-01-code-architecture.md` (findings ARCH-###). Target
implementation window: **before 2026-08-18**. Nothing here was fixed during the audit. Priorities:
**P0** blocks внедрение · **P1** fix before 18 Aug · **P2** after launch · **DEFERRED** not launch-affecting.

Effort: XS(<½d) · S(½–1d) · M(1–3d) · L(3–7d) · XL(>7d).

## P0 — release blockers (money distortion / inconsistent write)
| ID | Task | Modules | Deps | Migration | Live gate | Effort | Target |
|---|---|---|---|---|---|---|---|
| ARCH-002 | Wrap `recordPayment` in `$transaction`, inject `tx` into `createSalaryExpense`/`recordExpenseMovement`, add idempotency key/CAS | payroll, cash | — | no | **yes** (staging: double-submit + mid-op kill) | M | 08-08 |
| ARCH-003 | Same fix for `payRegionalCityPayment` + move overpay sum-check inside the tx (close TOCTOU) | payroll | ARCH-002 | no | yes | M | 08-09 |
| ARCH-001 | One snapshot resolver (`status:active + snapshotDate ≤ asOf + version desc`); make `balance-snapshots.ts` reuse it so dashboard/analytics/payments match the cash contour after cancellation | cash, dashboard, analytics, payments | — | no | yes (cancel a snapshot, compare all screens) | M | 08-08 |

**Suggested P0 order:** ARCH-002 → ARCH-003 (shared pattern) → ARCH-001 (independent). Each needs a
DB-backed test that **executes** the real module (ties into ARCH-022) plus a staging double-submit/
kill-between-steps check before sign-off.

## P1 — fix before 18 Aug (high risk / confidence)
| ID | Task | Modules | Deps | Migration | Live gate | Effort | Target |
|---|---|---|---|---|---|---|---|
| ARCH-022 | Add DB-backed behavior tests that import+execute `compute.ts`, `invoice-payments.ts`, `cash-balances.ts`, `payment-obligation.ts`, `budget-linkage.ts` on a sqlite fixture; keep source-string checks as lint only | tests | — | no | no | L | 08-14 |
| ARCH-004 | Inject `tx` into advance payout money writes (`recordAdvance`/`payoutAdvance`/`addAdvanceTranche`) | payroll | ARCH-002 | no | yes | S | 08-10 |
| ARCH-010 | Verify invoice `pay` UI wiring; retire the ledgerless `pay` action or make it write an InvoicePayment row | invoices | — | no | **yes** (verify running UI) | S | 08-08 |
| ARCH-006 | Data audit: reconcile legacy `CashWallet`/`CashMovement` ledger vs fact-balance contour on real balances; decide convergence (do NOT delete) | cash | ARCH-001 | no | yes | L | 08-15 |
| ARCH-005 | Scope-asserting helpers (`assertInScope`) + push scope into query at fragile helpers (`cash-wallets.confirm*`, `cancelSalaryExpense`) — partial; full verdict in audit #5 | data-access | — | no | no | M | 08-13 |
| ARCH-013 | CI/`postbuild`: regenerate dev Prisma client after `build:prod` (or run pilots before build) | build | — | no | no | XS | 08-05 |
| ARCH-015 | Add `/api/health/ready` that pings the DB, used for traffic gating (keep liveness for migrations) | deploy | — | no | yes | S | 08-11 |
| ARCH-017 | Throw at startup if `NODE_ENV=production && STORAGE_PROVIDER=local` | storage/config | — | no | no | XS | 08-05 |
| ARCH-024 | `safeAudit()` wrapper that logs on audit-write failure instead of silent swallow | audit | — | no | no | S | 08-11 |

## P2 — after launch (maintainability / no current functional risk)
| ID | Task | Effort |
|---|---|---|
| ARCH-008 | Declare `partially_paid` in `INVOICE_STATUSES` + labels | XS |
| ARCH-009 | Document per-model `cancelled`/`canceled` spelling; add a normalization helper for cross-entity queries | S |
| ARCH-011 | Remove/annotate unreachable statuses; centralize status constants (reduce ~1,118 magic strings) | M |
| ARCH-016 | Document/enforce expand-contract migrations; add deploy drain | M |
| ARCH-018 | Structured logger wrapper (replace 59 `console.*`) | S |
| ARCH-020 | Add `CRON_SECRET` to `.env.production.example` + deploy doc | XS |
| ARCH-023 | Batch the N+1 loops in `payroll/overview.ts`, `forecast.ts`, `account-container.ts` | S |
| ARCH-025 | Move page.tsx reads into `getXForScope` loaders; forbid prisma in `_components` | M |
| ARCH-014 | Document dev/prod migration-history divergence in the deploy guide | XS |
| God files | Extract one audited `swapFile()` helper (dedupe 3× safe-file-swap); split god actions | M |

## DEFERRED — architectural, not launch-affecting
| ID | Task | Effort |
|---|---|---|
| ARCH-007 | Delete `BarChart.tsx` + `exports.ts` (after confirming no re-wire) | XS |
| ARCH-012 | Plan v1→v2 data migration for Refund/Expense (retire dual workflows) | XL |
| ARCH-019 | Replace `xlsx` with SheetJS-CDN build / `exceljs` | M |
| ARCH-021 | i18n/branding extraction + parameterize OFD/cashier heuristics per company (white-label) | XL |
| God funcs | `buildAnalyticsReport` block split; god-action decomposition | L |

## Test requirements (apply to every P0/P1 code change)
1. A **DB-backed** pilot that imports and executes the real module (not a mirror) — no more
   source-string-only coverage for money paths (ARCH-022).
2. A double-submit / mid-op-failure case for every money write touched (ARCH-002/003/004).
3. `tsc` clean · `prisma validate` dev+prod · `pilot:full` green · `build:prod` compiled — and the
   dev client regenerated afterward (ARCH-013).

## Live GATEs still open (carry-over, not created by this audit)
Payroll-budget-payment-planning, invoice partial payments, owner cabinet, regional dashboard,
mobile/PWA — see baseline doc. These need real-instance acceptance independent of the code fixes above.
