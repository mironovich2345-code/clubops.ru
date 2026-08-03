# FULL AUDIT 1/6 — Code Architecture, Dependencies, Maintainability (Findings)

Commit `71f1cff`. Read-only audit; **no business logic, schema, or data was changed.** Evidence is
file:line. Severity S0(critical)→S3(low). Confidence: **proven** (read the code) / **likely** /
**needs-live-verification**. Release blocker: yes / no / conditional. Priorities (P0/P1/P2/DEFERRED)
are assigned in `docs/release/remediation-backlog-after-audit-01.md`.

Companion data: `docs/audits/data/*.json`, `system-map.md`, `state-machines.md`,
`codebase-metrics-2026-08.md`. This audit is **#1 of 6**; a dedicated security pass (#5) will do the
full IDOR/authz verdict — here tenant-scope items are flagged **architecturally**, not adjudicated.

## Severity roll-up
| Severity | Count | IDs |
|---|---|---|
| **S1 high** | 4 | ARCH-001, ARCH-002, ARCH-003, ARCH-022 |
| **S2 medium** | 12 | ARCH-004, 005, 006, 010, 012, 013, 015, 016, 017, 021, 024, 025 |
| **S3 low** | 9 | ARCH-007, 008, 009, 011, 014, 018, 019, 020, 023 |
| **S0 critical** | 0 | — (no confirmed cross-tenant breach or guaranteed money loss) |

Release blockers (conditional/yes): **ARCH-002, ARCH-003** (money-write consistency/idempotency),
**ARCH-001** (misleading financial figures), **ARCH-022** (test confidence). All others are
non-blocking hardening/maintainability.

---

## ARCH-001 — Snapshot "current balance" resolver diverges between contours
- **Category:** duplication / financial-consistency · **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional
- **Files:** canonical `src/lib/cash-collections.ts:37` (`status:"active"` + `snapshotDate ≤ now`); divergent `src/lib/balance-snapshots.ts:23` (`getLatestBalancesForScope`) and `:73` (`getLatestBalancesByClub`) — **no `status` filter**, and ForScope has **no date cutoff**, dedup by `createdAt` only, `version` ignored. Callers: `src/lib/dashboard-cards.ts:74`, `src/app/(app)/analytics/page.tsx:272`, `src/app/(app)/payments/page.tsx:138`. Cancellation writer: `src/app/(app)/collections/actions.ts:157`. A third variant tie-breaks on `version`: `src/lib/cash-transfers.ts:90`.
- **Affected modules:** dashboard, analytics, payments, cash.
- **Impact / corruption scenario:** after a control-point **cancellation** (active→cancelled, no replacement), the cash/collections page computes ИП/ООО fact from 0, but the **dashboard club card, analytics, and payments pages still return the cancelled snapshot's `actualBalanceKopeks`** as the current balance. A back-/future-dated point similarly shows on the dashboard but not in the cash contour. → the same "фактический остаток" reads two different numbers depending on the screen. No data corruption, but **misleading money on a financial dashboard**.
- **Remediation:** route all three resolvers through one `status:"active" + snapshotDate ≤ asOf + version desc` function; make `balance-snapshots.ts` reuse it. · **Effort:** M · **Deps:** none.

## ARCH-002 — Payroll final-salary payment: no transaction + no idempotency + money write on global client
- **Category:** transaction/consistency · **Severity:** S1 · **Confidence:** proven · **Blocker:** yes (conditional on go-live with real payouts)
- **Files:** `src/app/(app)/payroll/periods/actions.ts:735-768` (`recordPayment`): 3 sequential top-level writes — `payrollPayment.create` (status `confirmed`) → `createSalaryExpense` (`src/lib/payroll/salary-expense.ts:22`, creates Expense + `recordExpenseMovement` at `src/lib/cash-wallets.ts:132`) → `payrollPayment.update(expenseId)`. **No `$transaction`.** `createSalaryExpense`/`recordExpenseMovement` default to the **global `prisma` client**, so even a wrapping transaction would not include them.
- **Impact / corruption scenario:** (a) **Double-submit** (double click / retry) → 2 payments + 2 expenses + 2 cash movements = **double cash deduction** (no idempotency key, no dedupe). (b) Failure after step 1 → PayrollPayment `confirmed` but **no expense, no cash out** (phantom payment). (c) Failure at step 3 → cash deducted but `expenseId=null`, and `cancelPayment` reverses via `payment.expenseId` → the payout **can never be reversed** (orphan expense + permanent cash reduction).
- **Remediation:** inject `tx` into `createSalaryExpense`/`recordExpenseMovement`; wrap `recordPayment` in `$transaction`; add an `idempotencyKey` (or compare-and-set on a client token). · **Effort:** M · **Deps:** none (mirror the correct invoice-payment pattern, ARCH-ref below).
- **Positive contrast:** invoice payment (`invoices/actions.ts:666-688`) is the model — full `$transaction` + `idempotencyKey` + P2002-as-duplicate.

## ARCH-003 — Regional city payroll payment: no transaction, no idempotency, TOCTOU overpay guard
- **Category:** transaction/consistency · **Severity:** S1 · **Confidence:** proven · **Blocker:** yes (conditional)
- **Files:** `src/app/(app)/payroll/regional/actions.ts:143-160` — `regionalCityPayment.create` → `createSalaryExpense` → `update` → optional `employeeFinancialObligation.create`, **no transaction, no idempotency key**. Overpay guard at `:117-124` reads existing payments **non-atomically** → two parallel requests both pass (TOCTOU).
- **Impact:** double-submit → double deduction; partial failure orphans the expense or the overpayment-debt row.
- **Remediation:** wrap in `$transaction` with injected `tx`; add idempotency; move the overpay sum-check inside the transaction. · **Effort:** M · **Deps:** ARCH-002 (same fix pattern).

## ARCH-004 — Advance payout money writes commit outside their transaction
- **Category:** transaction/consistency · **Severity:** S2 · **Confidence:** proven · **Blocker:** no
- **Files:** `src/app/(app)/payroll/periods/actions.ts:877-910` (`recordAdvance`), `src/app/(app)/payroll/advance-actions.ts:52-71` (`payoutAdvance`), `:304-318` (`addAdvanceTranche` — **is** wrapped in `$transaction` but `createSalaryExpense` still uses the global client → Expense+CashMovement commit even if the tx rolls back).
- **Impact:** orphan expense + real cash deduction with no matching advance/tranche record on mid-op failure. Mitigated: in-period advance has a month dup-guard (`:857`); tranche has `idempotencyKey`.
- **Remediation:** same tx-injection fix as ARCH-002. · **Effort:** S · **Deps:** ARCH-002.

## ARCH-005 — No tenant middleware; ~92 id-keyed writes rely on manual scope discipline
- **Category:** data-access architecture · **Severity:** S2 · **Confidence:** proven (no confirmed IDOR) · **Blocker:** no (defer verdict to audit #5)
- **Files:** `src/lib/prisma.ts` (bare client, no `$extends`/`$use`). Evidence: `docs/audits/data/tenant-query-patterns.json` — 161 `.update({where:{id}})`, 178 `findUnique({where:{id}})`, 92 id-keyed writes without `companyId` in the same where. Fragile-by-convention helpers: `src/lib/cash-wallets.ts:277,386` (`confirmInternalTransfer`/`confirmOtherCashIncome` don't self-check actor scope — guarded only by the caller `cash-actions.ts:194-214`); `src/lib/payroll/salary-expense.ts:79-109` (`cancelSalaryExpense` trusts caller-supplied `expenseId`).
- **Impact:** correctness depends entirely on each action re-deriving scope. Sampled sites are correctly guarded (findUnique → companyId/allowedClubIds check → update), so **no confirmed IDOR**, but a new caller forgetting the guard would introduce one, and there is no defense-in-depth.
- **Remediation:** add a Prisma tenant-scope extension or at minimum scope-asserting helpers (`assertInScope(ctx,row)`); push scope into the query (`findFirst({where:{id,companyId}})`) at the fragile helpers. · **Effort:** L · **Deps:** none. (Full adjudication → audit #5.)

## ARCH-006 — Two cash contours coexist; legacy CashWallet/CashMovement ledger still written
- **Category:** legacy / consistency · **Severity:** S2 · **Confidence:** proven · **Blocker:** conditional
- **Files:** `src/lib/cash-wallets.ts`, `src/app/(app)/expenses/cash-actions.ts` (legacy wallet ledger, UI retired at `expenses/cash/page.tsx:10-15`) still written at expense verification + payroll payout; newer fact-balance contour = `CashCollection`/`CashWithdrawal`/`CashOtherIncome`/`CashRegionalTransfer`/`DailyCashReconciliation`+`BalanceSnapshot`. `src/lib/club-cash-cards.ts` still calls the wallet "single source of cash truth."
- **Impact:** two "truth" contours for cash, unreconciled. Risk of the wallet ledger and the fact-balance contour disagreeing on hand cash.
- **Remediation:** **data audit first** (reconcile the two against real balances), then converge on one. Do **not** delete the wallet ledger — it has live writes. · **Effort:** L · **Deps:** ARCH-001.

## ARCH-007 — Small amount of genuinely dead code
- **Category:** dead code · **Severity:** S3 · **Confidence:** proven · **Blocker:** no
- **Files:** `src/components/BarChart.tsx` (0 importers), `src/lib/exports.ts` (0 importers; only named in a route comment). Candidate list (verify): `src/components/UserBadge.tsx`, `src/lib/ai/document-verification.ts`, `src/lib/club-cash-cards.ts` — plus 4 `*.test.ts` files flagged by the scanner that are **run by node directly, not imported (false positives)**. `docs/audits/data/dead-code-candidates.json`.
- **Impact:** negligible; maintenance noise. · **Remediation:** remove `BarChart.tsx` + `exports.ts` after confirming no planned re-wire; verify the others. · **Effort:** XS. **Do not delete in this audit.**

## ARCH-008 — Invoice `partially_paid` is a reachable-but-undeclared status
- **Category:** status machine · **Severity:** S3 · **Confidence:** proven · **Blocker:** no
- **Files:** produced by `src/lib/invoice-payments.ts:31` (`derivedInvoiceStatus`) and accepted by the payable set in `src/app/(app)/invoices/actions.ts:640`, but **absent** from `INVOICE_STATUSES`, `INVOICE_STATUS_LABELS`, and `applyInvoiceAction` (`src/lib/invoices.ts:84-109,174`). No label, no workflow transitions.
- **Impact:** a real status with no UI label and no action-table entry — fragile for filters/labels/reporting. · **Remediation:** add `partially_paid` to the enum/labels (display-only). · **Effort:** XS.

## ARCH-009 — `cancelled` vs `canceled` spelling drift across models
- **Category:** status machine / normalization · **Severity:** S3 · **Confidence:** proven · **Blocker:** no
- **Files:** `src/lib/expense-status.ts:31` buckets both; Refund v2 uses `canceled` (`refund-workflow.ts:21`), Invoice `canceled`, CashRegionalTransfer/BalanceSnapshot/PayrollPayment/PayrollChangeRequest mix `cancelled`/`canceled`. Scan: 42 `"cancelled"` / 60 `"canceled"` (`status-transitions.json`).
- **Impact:** any cross-entity status query or future normalization must handle both spellings → latent filter bug. · **Remediation:** document the per-model spelling (do not migrate blindly — existing rows carry the current spelling). · **Effort:** S.

## ARCH-010 — Invoice dual pay-path (legacy `pay` action writes no InvoicePayment ledger row)
- **Category:** status machine / financial-consistency · **Severity:** S2 · **Confidence:** needs-live-verification · **Blocker:** conditional
- **Files:** `src/lib/invoices.ts:241-245` (`pay`: approved_* → paid) executed at `src/app/(app)/invoices/actions.ts:1278` writes **no** `InvoicePayment`; the ledger path is `recordInvoicePayment` (`:666-688`).
- **Impact:** if the legacy `pay` button is still UI-exposed, a `paid` invoice can exist with `paidTotalKopeks = 0` → payment reporting and remaining totals wrong.
- **Remediation:** confirm which path the UI wires; retire the ledgerless `pay` action or make it create a ledger row. · **Effort:** S · **Deps:** none. **Verify against the running UI.**

## ARCH-011 — Unreachable / non-resting statuses + ~1,118 magic status strings
- **Category:** status machine / maintainability · **Severity:** S3 · **Confidence:** proven · **Blocker:** no
- **Files:** `PayrollChangeRequest.under_review` (no writer), `BudgetChangeProposal.superseded` (no writer), `PayrollPayment.pending` (all created `confirmed`); `PayrollChangeRequest.approved` never rests (`change-request.ts`, `payment-obligation.ts`, `budget-linkage.ts`). ~1,118 hardcoded role/status literals (`codebase-metrics.json`).
- **Impact:** dead states mislead readers; magic strings are the maintainability tax. · **Remediation:** remove/annotate dead states; centralize status constants. · **Effort:** M.

## ARCH-012 — v1/v2 dual workflows on shared tables (Refund, Expense)
- **Category:** legacy / status machine · **Severity:** S2 · **Confidence:** proven · **Blocker:** no
- **Files:** Refund `src/lib/approval.ts` (v1) vs `src/lib/refund-workflow.ts` (v2), discriminated by `entryVersion` (guarded `refunds/actions.ts:285`, `refund-document-actions.ts:546`); Expense ad-hoc v1 (`expenses/actions.ts`) vs `EXP.*` v2 (`expense-simplified.ts`).
- **Impact:** two status vocabularies per table; every reader must branch on `entryVersion`. Correct today (guarded), but doubles the surface. · **Remediation:** plan a v1→v2 data migration post-launch; keep guards until then. · **Effort:** L.

## ARCH-013 — `build:prod` leaves the Prisma client generated for postgres (breaks dev DB pilots)
- **Category:** build/deploy · **Severity:** S2 · **Confidence:** proven · **Blocker:** no (dev-workflow footgun)
- **Files:** `package.json:16` `build:prod = prisma generate --schema=prisma/production/schema.prisma && next build`; no post-build restore. Reproduced in the baseline: after `build:prod`, `pilot:full` = 1299/0 with **34 DB-backed suites failing** until `prisma generate --schema=prisma/schema.prisma` is re-run.
- **Impact:** any dev/CI step that runs `build:prod` then a DB-backed pilot without regenerating the dev client gets false failures; conversely a green pilot run before a build masks this. **This is the concrete "green build ≠ prod-ready" evidence.**
- **Remediation:** add a `postbuild`/CI step to regenerate the dev client, or run pilots before build in CI. · **Effort:** XS.

## ARCH-014 — Dev/prod migration drift (75 vs 72)
- **Category:** build/deploy · **Severity:** S3 · **Confidence:** proven · **Blocker:** no
- **Files:** `prisma/migrations` (75) vs `prisma/production/migrations` (72); dev-only early migrations `20260602083538_sqlite_init`, `..._add_expenses`, `..._add_sales`, `..._multi_company_arch`.
- **Impact:** the two histories are intentionally different (sqlite dev vs consolidated postgres init), but the drift means dev migration count is not a prod signal and a naive comparison misleads. · **Remediation:** document the divergence explicitly in the deploy guide. · **Effort:** XS.

## ARCH-015 — Health endpoint is liveness-only (no DB check)
- **Category:** deploy/observability · **Severity:** S2 · **Confidence:** proven · **Blocker:** conditional
- **Files:** `src/app/api/health/route.ts` — returns 200 + version/readiness names; **intentionally does not touch the DB** ("does not flap during migrations"). Docker HEALTHCHECK + VM deploy gate both trust it.
- **Impact:** an orchestrator can route traffic to an app that **cannot reach the DB** (health still 200). · **Remediation:** add a separate `/api/health/ready` that pings the DB, used for traffic gating (keep liveness for migrations). · **Effort:** S.

## ARCH-016 — Not zero-downtime; app can run against a newer schema
- **Category:** deploy · **Severity:** S2 · **Confidence:** proven · **Blocker:** conditional
- **Files:** `deploy/deploy.sh:220` (migrate one-shot before app), `docker-entrypoint.sh` (migrate→exec). No expand/contract gating.
- **Impact:** during a deploy the **old app serves against an already-migrated DB**; a non-additive migration could break the old code mid-window. Mitigated because migrations are additive by policy, but not enforced. · **Remediation:** document/enforce expand-contract; add a brief drain. · **Effort:** M.

## ARCH-017 — `STORAGE_PROVIDER=local` in prod loses uploads on redeploy (not enforced in code)
- **Category:** deploy/config · **Severity:** S2 · **Confidence:** proven · **Blocker:** conditional
- **Files:** `src/lib/storage/index.ts:9` (default `local`); prod is expected to use S3 (`.env.production.example`), but nothing in code refuses `local` in production.
- **Impact:** a misconfigured prod (`local`) writes uploads to the container FS → **document loss on every redeploy**. · **Remediation:** throw at startup if `NODE_ENV=production && STORAGE_PROVIDER=local`. · **Effort:** XS.

## ARCH-018 — No structured logging; 59 raw `console.*`
- **Category:** observability · **Severity:** S3 · **Confidence:** proven · **Blocker:** no
- **Files:** 59 `console.*` across `src/` (`codebase-metrics.json`); no logger abstraction. · **Impact:** limited production diagnostics; no levels/correlation. · **Remediation:** a thin logger wrapper. · **Effort:** S.

## ARCH-019 — `xlsx` (SheetJS) is abandoned-on-npm
- **Category:** dependencies · **Severity:** S3 · **Confidence:** proven · **Blocker:** no
- **Files:** `package.json` `xlsx ^0.18.5`, used server-side only (`import.ts`, `excel-import.ts`, `imports/*`). Known prototype-pollution/ReDoS history on the npm build; operator-uploaded files only. · **Remediation:** move to the SheetJS CDN build or `exceljs`. · **Effort:** M.

## ARCH-020 — `CRON_SECRET` used but undocumented in `.env.production.example`
- **Category:** config · **Severity:** S3 · **Confidence:** proven · **Blocker:** no
- **Files:** `src/lib/ofd/daily.ts:16` reads `CRON_SECRET`; absent from `deploy/.env.production.example`. · **Impact:** a fresh deploy may leave the OFD cron unauthenticated/misconfigured. · **Remediation:** add it to the example + deploy doc. · **Effort:** XS.

## ARCH-021 — White-label reuse requires an i18n/branding pass (no per-tenant data hardcoded)
- **Category:** config / reusability · **Severity:** S2 · **Confidence:** proven · **Blocker:** no (for the current single tenant)
- **Files:** brand "CLUB-OPS" + Russian copy hardcoded inline (`email.ts` templates, `layout.tsx`); fitness-domain classification heuristics (`ofd/revenue.ts:80`, `cashier-normalize.ts`). **No hardcoded INN/legal-entity IDs/emails/Telegram IDs/absolute paths in logic** — only dev-only seed (`seed.ts`, prod-guarded).
- **Impact:** reselling under another brand/vertical needs an i18n/branding + heuristics pass; **no per-customer business data is baked in** (roles centralized, secrets externalized). · **Remediation:** extract copy to i18n; parameterize OFD/cashier heuristics per company. · **Effort:** L.

## ARCH-022 — Test suite is ~85–90% static-string + mirrored-logic; critical money engines not executed
- **Category:** test architecture / confidence · **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional
- **Files:** 79 pilot suites, ~3,589 assertions; `readFileSync` source-string style present in **73/80** files, real DB in **34**, deep DB in ~8 (`pilot-refunds.mjs` 277 — best; `pilot-financial.mjs`). Money engines validated against **re-implemented copies**: `pilot-payroll-periods.mjs` re-implements `computeScheme`; `pilot-invoice-partial-payment-postfactum.mjs` re-implements `paidTotal`/`validate`; `pilot-cash-transfer-backdated-snapshot.mjs` re-implements the balance/snapshot resolver; `pilot-payroll-budget-payment-planning.mjs` is ~half source-string greps. No test framework (jest/vitest) — hand-rolled `.mjs`.
- **Impact:** **false-green risk.** Source-string tests pass as long as a string exists (they never execute the guard, don't prove it runs before the write, and rot into tautologies). Mirrored-logic tests validate a copy, so production drift (a changed rate/rounding/status set) stays green. The headline "3641 passed" overstates real behavioral coverage; per-module confidence: Refunds HIGH, Invoices/Cash/RBAC MEDIUM, Payroll money-engine + Budgets LOW-MEDIUM.
- **Remediation:** add DB-backed behavior tests that **import and execute** `compute.ts`, `invoice-payments.ts`, `cash-balances.ts`, `payment-obligation.ts`, `budget-linkage.ts` against a sqlite fixture; treat source-string checks as lint, not proof. · **Effort:** L · **Deps:** none. **This is the most important confidence finding.**

## ARCH-023 — N+1 query loops in loaders
- **Category:** performance · **Severity:** S3 · **Confidence:** proven · **Blocker:** no
- **Files:** `src/lib/payroll/overview.ts:37-42` (one `getSchemesForEmployee` per employee), `src/lib/payroll/forecast.ts:169-173` (per-employee), `src/lib/account-container.ts:145-150` (session findUnique per stored session). · **Impact:** slows payroll dashboard/forecast at scale. · **Remediation:** batch with `findMany({where:{employeeId:{in:…}}})`. · **Effort:** S.

## ARCH-024 — Best-effort audit swallowed by ~30 `try/catch{}`; audit failures invisible
- **Category:** error handling · **Severity:** S2 · **Confidence:** proven · **Blocker:** no
- **Files:** ~30 `try { recordAudit(...) } catch { /* ignore */ }` in payroll actions (`periods/actions.ts`, etc.). · **Impact:** an audit-log write failure is silently dropped → gaps in the compliance trail with no signal. · **Remediation:** a `safeAudit()` wrapper that at least `console.error`s (or increments a metric). · **Effort:** S.

## ARCH-025 — 35 page.tsx + 3 components query Prisma directly (no repository layer)
- **Category:** module boundaries · **Severity:** S2 · **Confidence:** proven · **Blocker:** no
- **Files:** `docs/audits/data/direct-prisma-access.json` — e.g. `invoices/[id]/page.tsx:160`, `refunds/[id]/page.tsx:252`, `budgets/_components/SalaryBudgetPanel.tsx:45` (prisma in a component). All are scoped reads that call `getCurrentAccessContext` first, but scope enforcement is not centralized.
- **Impact:** coupling of RSC/UI to the DB; each page must self-scope; no single choke point for tenant safety (feeds ARCH-005). · **Remediation:** move page reads into `getXForScope` loaders; forbid prisma imports in `_components`. · **Effort:** M.

---

## God files / god functions (maintainability — mostly P2)
Detailed in `codebase-metrics-2026-08.md`. Worst: `invoices/actions.ts` (1490; `createAndSubmitInvoice` ~178, `transitionInvoice` ~157), `payroll/periods/actions.ts` (969; `transitionPeriod` embeds obligation loops), `analytics.ts` (`buildAnalyticsReport` ~274, pure). **P1 sub-item:** the security-critical **safe-file-swap ordering** (upload new → CAS → rollback → delete old) is duplicated 3× (`invoices/actions.ts replaceInvoiceFile`, `saveAndResubmitInvoice`, expenses equivalent) → extract one audited `swapFile()` helper. `access.ts` (692) and the `lib/*` decision tables are **long but well-factored** (not god functions).

## What is built well (explicitly)
- Money = integer kopeks; conversion only via `money.ts`; no floats.
- Strategic owner/GD read-only enforced by **capabilities**, not just page access.
- **Invoice payment** (tx + idempotency + P2002), **refund payment** (compare-and-set), **cash transfer confirm** (conditional updateMany), **payroll obligation** (idempotency upsert), **expense category / user-access / legal-entity** ops are all correctly transactional — the right patterns exist and are the template for ARCH-002/003.
- Secrets fail-closed in production (`env-secrets.ts` throws); no unsafe secret fallback; **no per-tenant business data hardcoded**.
- Client/server boundaries clean: 0 Prisma imports in `"use client"`, no secrets in client props, financial pages `force-dynamic` + `revalidatePath` after mutations (no stale-cache risk).
- Deploy has `pg_dump` backup before migrate + app rollback; 0 `ts-ignore`, 11 TODO, no commented-out code, 0 unused Prisma models.
