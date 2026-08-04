# REM-05 — Single Profit / Single Budget-Fact / Partially-Paid Consistency — Final Report

**1. Baseline commit:** `71ea1bb` (tsc 0 · pilot:full 3977/0 · dev+prod schemas valid · build:prod
compiles). Additive only; no OFD import / cash formula / payroll formula / InvoicePayment ledger /
refund AB-PT formula / RBAC / tenant / status change; no production data change; historical rows
reinterpreted, never rewritten; no tax rates hard-coded.

**2. Business decisions.** BD-03 (profit = OFD net revenue − recognized expenses), BD-04 (budget fact
= recognized expenses by period), BD-INVOICE (full invoice amount by expensePeriod; payments are cash
only; partially_paid included), BD-REFUND (separate single-effect expense, not a revenue reduction),
BD-TAX (no engine; VAT inside the total, never added; taxes only as real records). Encoded in
`docs/remediation/rem-05-accounting-decisions.md`.

**3. Previous profit definitions.** 9 computations — two live and competing on one card (Sale/
SalesReport vs OFD-net via `useOfd`), payroll accrual absent everywhere, partially_paid dropped, plus
a dead `dashboard.ts` trio (FIN-001, UX-005).

**4. Previous budget-fact definitions.** 3 functions that disagreed: `computeUsedKopeks` (conf+ver /
approved+paid), `computeBudgetOverruns` (confirmed-only), `computeBudgetFactReport` (confirmed +
paid-only) → v2 verified + partially_paid invisible (FIN-002/003, DATA-018/019).

**5. Canonical recognized-expense service.** `loadRecognizedExpenses` (`recognized-expense.ts`) with
pure predicates in `recognition.ts` — the single accrual aggregator (Expense conf/ver + Invoice FULL
by expensePeriod + approved payroll `netPayable` + Refund + tax records), deliberately blind to
payments/cash/transfers/collections/«Приход Иное»/forecast/obligations/budget.

**6. Canonical revenue.** OFD net (`loadOfdManagementOverview.totals.netKopeks`); Sale/SalesReport =
historical/diagnostic; refunds never subtracted from revenue.

**7. Final profit formula.** `calculateProfit` = OFD net − recognized expenses (kopeks, exact).

**8. Final budget-fact formula.** `calculateBudgetFact` = approvedBudget − recognizedFact (same
service, by category); committed shown separately; per-category sum invariant guarded.

**9–14. Handling.** Invoice: full amount by expensePeriod, recognized ∈ approved-unpaid +
partially_paid + paid; never scaled by paid %. Payments: cash-only ledger, never a 2nd expense.
Payroll: approved-period `netPayableKopeks` once; PayrollPayment/advance/obligation ignored. Refund:
`refundResultAmountKopeks ?? amountKopeks`, once, approved-or-paid, by business date; no parallel
Expense. Tax/VAT: no engine, no rates; invoice total used as-is; taxes only as real records.

**15. Period semantics.** Expense→`expenseDate` month; Invoice→`expensePeriod`; Payroll→period
year-month; Refund→`refundDate??paidAt??createdAt`; local month key (no UTC drift); missing period →
fallback + warning, never silent disappearance.

**16. Category mapping.** Shared; missing → `unassigned` bucket (still in total) + warning.

**17. Migrated readers.** `computeUsedKopeks`, `computeBudgetOverruns`, `computeBudgetFactReport`,
`getBudgetFactReportForScope` → recognized rules (v2 verified + partially_paid now counted). Dashboard/
analytics **profit** cards + budgets-page payroll row = documented adoption gate (G-FIN-1/7/8).

**18. UI changes.** None shipped in this pass (labels/breakdown adoption travels with the reader
migration gate); the services expose `expenseBreakdown`/`revenueBreakdown`/`formulaVersion` for the
"Выручка ОФД / Признанные расходы / Прибыль / Факт бюджета / Обязательства" labels.

**19. Golden scenario result.** EXACT via real DB rows: OFD 1,000,000 − recognized 670,000 (cash
100k + partially_paid invoice 200k FULL + payroll accrual 300k + refund 40k + tax 30k) = **profit
330,000**; budget 800k → fact 670k, available 130k. «Приход Иное»/collection/PayrollPayment provably
excluded.

**20. Dev preflight result.** `preflight:profit-budget-fact` runs clean (dev seed has no finance
rows; all checks 0). Real logic; production UNVERIFIED (run on a replica — G-FIN-11).

**21. Reconciliation result.** `reconcile:profit-budget-fact` (jiti, read-only) — canonical
budget-fact vs the migrated Plan/Fact reader agree per company·month on shared categories; canonical
profit reported. Dev has no company·month cells; production reconciliation is the gate.

**22. Production verification status.** NOT YET RUN on production/PostgreSQL — G-FIN-11/12 + the §27
PostgreSQL gate remain.

**23. Integration tests.** `test:rem-05-integration` **31/31** (real services, real rows, golden
scenario, partially_paid-full, payment-not-double, draft-payroll-out, refund-separate, v2-verified-in,
tax tag, unassigned-in-total, category reconcile, club/company/LE scope, month boundary, exact kopeks,
negative profit, tenant isolation).

**24. Pilot / full / build.** `pilot:rem-05-profit-budget-fact` **37/37** · pilot:full **4014/0 across
91 suites** · tsc 0 · build:prod **compiles (BUILD_EXIT=0)** · `test:rem-05-integration` **31/31** · dev
Prisma client restored after the prod build.

**25. Findings closure.** **FIN-002 CLOSED** (partially_paid in recognized + budget fact). **FIN-003 +
DATA-018/019 CLOSED** (single recognized service; verified included; Plan/Fact = overruns =
"Использовано"). **FIN-006 ADDRESSED** (ledgerless paid still recognized; preflight `PB-06` warns;
no auto payment row). **FIN-007 CLOSED-by-decision** (BD-TAX: no engine; VAT not added; taxes as
records). **FIN-001 + UX-005 PARTIALLY CLOSED** (canonical `calculateProfit` built + proven;
dashboard/analytics card adoption = G-FIN-1/7). Duplicated-formula ARCH findings PARTIAL (one service
now exists; per-reader adoption ongoing).

**26. Commit hashes.** baseline+services · integration tests+golden · reader migration · preflight+
reconcile · pilot+docs+report (on `main`).

**27. Open live gates.** G-FIN-1..12 — esp. G-FIN-1/7 (dashboard/analytics adopt canonical profit),
G-FIN-8 (budgets-page payroll row), G-FIN-11/12 (production reconciliation + golden on PostgreSQL).

**28. Remaining remediation.** Migrate the dashboard/analytics profit cards + budgets-page payroll row
to the canonical services; run the production reconciliation + PostgreSQL golden gate. Next candidate:
REM-06 (`/api/health/ready` DB readiness + `DATABASE_URL` startup validation — ARCH-015/OPS-003).

## Definition of Done
- one profit formula — ✅ service (`calculateProfit`); reader adoption = gate
- one budget fact — ✅ (`calculateBudgetFact`; Plan/Fact readers migrated)
- partially_paid fully included — ✅ (proven, golden)
- invoice payments don't double expense — ✅ (service never reads the ledger; proven)
- payroll accrual once — ✅ (approved-period netPayable; proven)
- refunds once — ✅ (separate expense; proven)
- «Приход Иное» + transfers excluded — ✅ (never queried; proven)
- dashboard/analytics/plan-vs-fact agree — ⚠ Plan/Fact ✅; dashboard/analytics profit = gate G-FIN-7
- accountant/owner can verify a breakdown — ✅ (expenseBreakdown/formulaVersion) + G-FIN-1
- no automatic production data change — ✅
- real DB tests + golden scenario green — ✅ (31/31, exact)
- build + pilot:full green — ✅ (gauntlet step)

The honest gap: the dashboard/analytics **profit cards** still read their legacy revenue basis — the
canonical service is built, proven and ready, but swapping those live cards (and ratifying the number
with the accountant) is **G-FIN-1/7**, plus the production/PostgreSQL reconciliation (G-FIN-11/12).
FIN-001/UX-005 stay PARTIALLY CLOSED until then.
