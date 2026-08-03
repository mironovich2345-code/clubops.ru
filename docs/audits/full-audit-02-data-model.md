# FULL AUDIT 2/6 — Data Model, Relationships, Status Sources, Integrity (Findings)

Commit `66bc9e3`. Read-only; **no schema, migration, data, or logic changed.** Evidence is
file:line / schema-line. Severity S0→S3; confidence proven / likely / needs-live-verification;
release blocker yes/no/conditional. Priorities assigned in
`docs/release/remediation-backlog-after-audit-02.md`. Supporting docs: `docs/data/*`,
`docs/audits/data/*.json`. This is audit **#2 of 6** — it supplies the data-layer evidence under
Audit-1's ARCH-001/002/006/010 and adds new integrity findings.

## Severity roll-up
| Severity | Count | IDs |
|---|---|---|
| **S1 high** | 8 | DATA-001, 002, 003, 005, 007, 008, 010, 016 |
| **S2 medium** | 12 | DATA-004, 006, 009, 011, 012, 013, 015, 018, 019, 024, 025, 026 |
| **S3 low** | 6 | DATA-014, 017, 020, 021, 022, 023 |
| **S0 critical** | 0 | — (no confirmed live corruption in dev; several are conditional on production data) |

**Financial numbers with >1 source of truth: 8** (cash ООО ×3, cash ИП ×2, «Иное» ×2, profit ×2,
budget-fact ×2, debt ×3, payroll-remaining 2 caches, refund-amount 2 notions).
**Dev-DB integrity scan:** 1 offending row (orphan club/legal-entity link); **production unverified.**

---

## DATA-001 — Cash ООО/ИП have 2–3 competing sources shown side-by-side
- **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional · **ARCH:** ARCH-001/006
- **Models/fields:** `BalanceSnapshot.actualBalanceKopeks` vs `calculateCashBalances().cashOooFactBalance`/`cashIpFactBalance` vs `analytics.ts:536` report-derived remainder. Dashboard renders snapshot **and** fact on one card: `dashboard-cards.ts:95` (`oooKopeks`) + `:116` (`oooFactKopeks`).
- **Consequence:** the same "фактический остаток" reads different numbers per screen; a manager reconciling cash sees contradictory ООО/ИП figures. **Corruption scenario:** none (display), but decision-affecting.
- **Existing rows (dev):** not divergent (sparse data). **Prod verification:** compute the 2–3 figures per club/LE and list disagreements.
- **Remediation:** one balance resolver; dashboard shows one labelled number per contour. Depends on DATA-002/012.

## DATA-002 — Cash expense & payroll payout double-write both cash contours
- **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional · **ARCH:** ARCH-006
- **Evidence:** cash expense verify writes `Expense` (contour B fact, `cash-balances.ts:141`) **and** `CashMovement.expense` (contour A wallet, `cash-wallets.ts:132`); payroll cash payout writes salary `Expense` **and** `CashMovement.payroll_payout` (`salary-expense.ts:64`, `payroll/payments.ts:40`).
- **Consequence:** the ИП **wallet** balance and the ИП **fact** balance are structurally guaranteed to diverge (different inputs + status semantics + OFD). Both are surfaced (`/expenses/cash` vs dashboard/collections). See `cash-contours-reconciliation.md`.
- **Remediation (gated, later):** source the cash effect from the `Expense` row only; make contour-A `CashMovement` audit-only or drop. Requires data audit + migration — **not done here.** Depends on DATA-006-cash.

## DATA-003 — `PayrollPayment` has NO idempotency key → double-pay produces duplicate money records
- **Severity:** S1 · **Confidence:** proven · **Blocker:** yes (conditional on real payouts) · **ARCH:** ARCH-002
- **Evidence:** `PayrollPayment` has no `idempotencyKey`/`@unique` (schema ~1666), created `confirmed` at `periods/actions.ts:735` with no dedupe. Each retry makes a **new** `Expense` (distinct id → distinct `CashMovement.sourceId`, so the `@@unique(sourceType,sourceId)` does **not** dedupe). Contrast siblings that DO have keys (`PayrollAdvancePayment` `:1596`, `PayrollPaymentObligation` `:634`).
- **Corruption scenario:** a double-click on "record salary payment" = **2 payments + 2 salary expenses + 2 cash movements = double cash deduction**, and `paidKopeks` counts both.
- **Prod verification:** DATA-CHK-14 (duplicate keys — n/a here) + look for two confirmed PayrollPayments with equal (calc, amount, minute).
- **Remediation:** add `idempotencyKey` + `$transaction` (ties ARCH-002). **P0.**

## DATA-004 — Two "Приход Иное" features on two tables
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no
- **Evidence:** `CashOtherIncome` table (contour B, `collections/actions.ts:345`) vs `CashMovement.other_cash_income` (contour A, `cash-wallets.ts:367`). Two pages, two stores, never reconciled.
- **Remediation:** converge on `CashOtherIncome` (contour B) as canonical. Depends on DATA-002.

## DATA-005 — Ledgerless `paid` invoice is producible (legacy pay path)
- **Severity:** S1 · **Confidence:** needs-live-verification · **Blocker:** conditional · **ARCH:** ARCH-010
- **Evidence:** legacy `pay` action sets `status:"paid"` with no `InvoicePayment` (`invoices/actions.ts:1278`); ledger path is `recordInvoicePayment` (`:679`). Both present on the detail page. See `invoice-payment-paths.md`.
- **Consequence:** `status="paid"` with `paidTotalKopeks=0`; `Invoice.status` contradicts the ledger; payment calendar vs ledger disagree.
- **Prod verification:** DATA-CHK-11. **Remediation:** verify UI; retire/convert the legacy pay. **P1.**

## DATA-006 — `partially_paid` undeclared + counted inconsistently across surfaces
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no · **ARCH:** ARCH-008
- **Evidence:** produced by `derivedInvoiceStatus` (`invoice-payments.ts:31`); absent from `INVOICE_STATUSES`/labels/action table; **excluded** from analytics spend/debt (`analytics.ts:205,210`) and budget "used" (`budgets.ts:310`); **included** in the payment calendar (`payments.ts:9`).
- **Remediation:** declare the status; reconcile treatment. **P1/P2.**

## DATA-007 — No composite FK; every denormalized tenant scalar can mismatch
- **Severity:** S1 · **Confidence:** proven (mismatch DB-possible) / needs-live-verification (actual rows) · **Blocker:** conditional
- **Evidence:** SQLite/PG with no composite FK; a `@relation` proves existence only, never same-tenant. Payroll, current-cash, OFD, AuditLog are **scalar-only, no relations at all** (`schema:1362` comment). 92 id-keyed writes (Audit-1 ARCH-005) rely on manual guards.
- **Consequence:** `club.companyId ≠ row.companyId`, LE-of-another-company, etc. are all DB-possible; a single missed app guard → cross-tenant row. **No confirmed breach in dev** (DATA-CHK-01/02/04 = 0).
- **Prod verification:** DATA-CHK-01…07 on a read replica. **Remediation:** tenant-scope Prisma extension / scope-asserting helpers (ties ARCH-005; full verdict → Audit #5). **P1.**

## DATA-008 — `Company` has no soft-delete; hard-delete cascades financial history AND orphans scalar rows
- **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional
- **Evidence:** Company→Club/Invoice/Expense/Refund/Budget/BalanceSnapshot/CashWallet/… = **Cascade** (`relation-risks.json`), and Company has no `isActive`/`archivedAt`. The scalar-only payroll/cash-B/OFD/audit rows have **no FK to Company** → survive as orphans.
- **Corruption scenario:** deleting a Company **destroys** the relational financial history **and leaves** dangling payroll/cash/OFD ledgers pointing at a dead company — a partial, inconsistent wipe with no recovery path.
- **Remediation:** add Company soft-delete; never hard-delete a tenant; block the path. **P1.**

## DATA-009 — `SetNull` on LegalEntity delete orphans ИП/ООО attribution
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no
- **Evidence:** LegalEntity ← Invoice/Expense/Sale/MandatoryPayment = **SetNull** (`schema:881,1035,1267,677`). Deleting an LE silently blanks historical attribution; BalanceSnapshot is protected by Restrict.
- **Remediation:** soft-delete LegalEntity (an `isActive` flag already exists — enforce non-deletion). **P1.**

## DATA-010 — `EmployeeFinancialObligation.employeeId` can hold a payroll-row id (orphan-by-construction)
- **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional
- **Evidence:** `regional/actions.ts:152,158` — when `regionalEmployeeId` is null, `RegionalCityPayroll.id` is written into the `employeeId` of the salary Expense notes **and** the `EmployeeFinancialObligation` → an obligation not joinable to any real `ClubEmployee`.
- **Consequence:** employee debt reports reference a non-employee id; DATA-CHK-06 would flag it in production.
- **Remediation:** require a real employee id or a distinct nullable column. **P1.**

## DATA-011 — Regional payment cancel leaves a dangling overpayment debt
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no
- **Evidence:** `cancelRegionalCityPayment` (`regional/actions.ts:169-185`) reverses the salary Expense but **never** the `EmployeeFinancialObligation` created at `:156-159` → the employee-owes-company debt persists after the payment is canceled.
- **Remediation:** cancel the obligation in the same flow. **P1.**

## DATA-012 — Active `BalanceSnapshot` per (club, LE, date) not DB-unique (race → two active)
- **Severity:** S2 · **Confidence:** proven · **Blocker:** conditional · **ARCH:** ARCH-001
- **Evidence:** only `@@index`, no `@@unique(clubId,legalEntityId,snapshotDate)` (`schema:723-727`). Insert is check-then-create with no tx (`collections/actions.ts:93-98`); correction/cancel ARE compare-and-set. On Postgres, two concurrent opening-balance inserts on one date both pass → two active rows; the resolver then picks by `createdAt` and correcting one leaves the other active.
- **Prod verification:** DATA-CHK-09. **Remediation:** add the partial-unique (or tx guard). **P1.**

## DATA-013 — Active scheme version / club_cash wallet / one-active-ИП-ООО rely on the SQLite single-writer lock
- **Severity:** S2 · **Confidence:** proven · **Blocker:** conditional
- **Evidence:** EmployeePayScheme active version = read-then-write in a tx, not CAS, no unique (`scheme-service.ts:45-85`); club_cash wallet unique includes a nullable holder → not enforced (`schema:1165`); one-active ООО/ИП per club is a tx conflict-check (`legal-entity-actions.ts:188`). All safe on SQLite's global write lock; **open race windows on Postgres.**
- **Remediation:** add proper unique constraints / CAS before the Postgres cutover. **P1.**

## DATA-014 — `LegalEntity.inn` not unique within a company
- **Severity:** S3 · **Confidence:** proven · **Blocker:** no
- **Evidence:** no `@@unique` on `(companyId, inn)`; create writes `inn` with no dup check (`legal-entity-actions.ts:68`). Duplicate INNs are freely creatable. **Remediation:** app + DB uniqueness. **P2.**

## DATA-015 — Cache-vs-ledger drift points (recompute/generation-gated)
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no
- **Evidence:** `PayrollCalculation.paid/remaining` (recompute-gated), `PayrollPaymentObligation.*` (generation-gated), `OfdDailySalesSummary` (recompute-gated), `Invoice.status/paidAt` (payment-action-gated), `DailyCashReconciliation` frozen. Each drifts if its recompute is skipped.
- **Remediation:** prefer derivation at read for the cheap ones; add reconcile checks. **P1/P2.**

## DATA-016 — Payroll obligation totals silently lag the calc (swallowed refresh)
- **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional · **ARCH:** ARCH-002
- **Evidence:** `PayrollPaymentObligation.{paid,remaining}` refreshed only via best-effort `refreshPeriodObligations`, whose errors are swallowed (`periods/actions.ts:42-48,771,807`). A failed refresh leaves the obligation ("Зарплата к выплате") showing a stale remaining vs the true calc.
- **Consequence:** payment calendar "к выплате" can be wrong after a payment/cancel. **Remediation:** make the refresh part of the payment transaction (ties ARCH-002). **P1.**

## DATA-017 — Paid invoice with null `expensePeriod` (accrual month unknown)
- **Severity:** S3 · **Confidence:** proven · **Blocker:** no · **Evidence:** DATA-CHK-17; fallback exists (`invoices.ts:49`) but a null leaves analytics bucketing on `createdAt`. **Remediation:** backfill `expensePeriod`. **P2.**

## DATA-018 — Two "budget fact" and two "profit" definitions; two payroll bp-rounding engines
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no
- **Evidence:** budget fact = `computeUsedKopeks` (approved+paid) vs `computeBudgetFactReport` (paid-only) (`budgets.ts:76`/`:305`); profit = `analytics.ts:557` vs `dashboard.ts:23`; payroll bp rounding = `ceilToRubleKopeks(round())` (`calc.ts:17`) vs `round()` per-component (`formulas.ts:34,247`).
- **Consequence:** same period → different numbers per screen; ±kopeck/±ruble payroll differences by engine. **Remediation:** one budget-fact + one profit definition; unify rounding. **P1/P2.**

## DATA-019 — v2 `verified` expenses excluded from Plan-vs-Fact/overruns
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no
- **Evidence:** overrun/fact report count only `confirmed` (v1) (`budgets.ts:182,305`) while totals/used count `confirmed+verified` (`analytics.ts:204`, `budgets.ts:98`). A v2 verified expense is in the totals but missing from overruns. **Remediation:** include `verified` in the fact/overrun paths. **P1.**

## DATA-020 — Approved-unpaid v2 refunds absent from debt/budget-used until paid
- **Severity:** S3 · **Confidence:** proven · **Blocker:** no · **Evidence:** `APPROVED_UNPAID_STATUSES` = `approved_by_*` excludes v2 `accounting_in_progress` (`analytics.ts:211`, `budgets.ts:104`). **Remediation:** add the v2 approved-unpaid status. **P2.**

## DATA-021 — Refund month bucketing differs between aggregators
- **Severity:** S3 · **Confidence:** proven · **Blocker:** no · **Evidence:** `refundDate ?? createdAt` (`budgets.ts:108`) vs `paidAt ?? refundDate ?? createdAt` (`:315`, `analytics.ts:269`); v2 refunds never set `refundDate`. Same refund → different months. **Remediation:** one refund date basis. **P2.**

## DATA-022 — UTC day-truncation drift on local-midnight dates
- **Severity:** S3 · **Confidence:** proven · **Blocker:** no
- **Evidence:** `snapshotDate.toISOString().slice(0,10)` on a local-midnight value reports the previous day on a positive-offset server (`collections/actions.ts:99,103`); `excel-import` writes `Date.UTC` midnight which can miss a local `monthRange` while string-based invoice matching is immune (month-boundary drift between the two paths).
- **Remediation:** format with local components; normalize import dates. **P2.**

## DATA-023 — Dead denormalized link fields never written
- **Severity:** S3 · **Confidence:** proven · **Blocker:** no · **Evidence:** `PayrollPayment.cashMovementId`/`sourceId`, `PayrollPaymentObligation.sourceCalculationId`/`employeeId` exist in schema but are never populated → a reader can't tell "no source" from "not set." **Remediation:** populate or remove. **P2.**

## DATA-024 — Non-atomic period close (per-calc obligation + status flip, no transaction)
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no · **ARCH:** ARCH-002 · **Evidence:** close loop `periods/actions.ts:456-480` creates one `EmployeeFinancialObligation` per calc and flips each calc status in separate writes; mid-loop failure leaves some closed + obliged and others not. **Remediation:** wrap in `$transaction`. **P1.**

## DATA-025 — No FK on payroll/cash/OFD scalar links → orphans not DB-preventable
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no · **Evidence:** all payroll cross-model links are bare `String?` with no `@relation` (`schema:1362`); reviewer/approver/paidBy on scalar models unenforced; `PayrollPayment.expenseId` can be null (phantom) or point to a deleted Expense (unreversible). See payroll relationship map. **Remediation:** add relations or app-level integrity checks + the data-integrity preflight in CI. **P1.**

## DATA-026 — `DailyCashReconciliation` frozen expected value can mismatch recomputed fact
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no · **Evidence:** `expectedCashBalanceKopeks` pulled live at submit then frozen (`reconciliation-actions.ts`); the live fact keeps moving, so a historical reconciliation's expected can differ from a re-derivation. **Remediation:** document as an attestation snapshot (intended) or recompute on read. **P2.**

## What is sound (explicitly)
- **Money typing is clean:** 97 money fields, all `Int` kopeks, 0 float/decimal/string, one conversion helper; no float ever persisted without `Math.round`/BigInt ceil.
- **No double-count** invoice↔analytics (accrual by `expensePeriod`, never reads the payment ledger).
- **Strong exactly-once** where it exists: InvoicePayment (`idempotencyKey`+P2002), PayrollChangeRequest (`appliedToken @unique`), CashRegionalTransfer confirm (CAS), scheme materialize (`sourceChangeRequestId @unique`).
- **Append-only integrity** genuine for BalanceSnapshot / InvoicePayment / PayrollAdvancePayment (amounts never edited; reversal = status flip).
- **createdBy = Restrict + User tombstone** → relational creators never orphan.
- **Effective vs recorded dates separated** on every model; backdated points allowed, future blocked (snapshots/expenses).
