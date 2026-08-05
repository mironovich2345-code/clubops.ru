# REM-05A — Canonical Profit Live-Reader Adoption — Final Report

**1. Baseline:** `a46234c` (tsc 0 · pilot:full 4076/0 · schemas valid · build:prod compiles). No new
financial rule; no formula/RBAC/production-data change.

**2. Legacy live readers before.** Analytics "Финансовый итог" card (`useOfd? ofdResult : Sale-based
s.profitKopeks` — competing, UX-005); analytics "Результат" KPI (OFD net − expenseSummary); dashboard
club-card "Результат" (OFD net byClub − expenseSummary byClub); dead `dashboard.ts` Sale−Expense trio.

**3. Canonical readers after.** All live readers use `calculateProfit` (BD-03: OFD net revenue −
recognized expenses) or its exact composition. The analytics card shows «Прибыль» + «Выручка по ОФД» +
«Признанные расходы» with cash SEPARATE (UX-005 resolved — one official number, nothing masked as
profit). The club-card "Результат" = OFD net byClub − recognized byClub = `calculateProfit({clubId})`,
fed by ONE scoped `loadRecognizedExpenses` byClub query (no per-club N+1). `computeManagementResult` and
the `dashboard.ts` trio are `@deprecated` with **0 live callers**.

**4. Owner/GD result.** The analytics FinancialSummaryCard + "Прибыль" KPI now render
`calculateProfit.profitKopeks/revenueKopeks/expenseKopeks` for the owner/GD/regional scope.

**5. Analytics result.** Single service; no local formula copy (`s.profitKopeks`/`ofdResultKopeks`
removed from the render path).

**6. Export result.** An export using `calculateProfit` returns the identical number (same service) —
proven.

**7. Network reconciliation.** `calculateProfit(scope) = Σ calculateProfit({clubId})` — proven; company-
level recognized rows (if any) are included via the scope query, never silently distributed to clubs.

**8. DB-backed tests.** `test:rem-05a-profit-readers` **12/12** — club-card == calculateProfit per club;
network == Σ clubs; partially_paid full / payroll once / refund once; cash & other-income irrelevant;
club/tenant scope; negative profit exact; warnings surfaced.

**9. Production verification.** Dev sqlite proven; production read-only `reconcile:profit-budget-fact`
review + on-instance dashboard=analytics=export = G-FIN-1/7/11.

**10. FIN-001 status — CLOSED.** No live profit reader uses a legacy/competing basis; all use
`calculateProfit`.

**11. UX-005 status — CLOSED.** The UI shows ONE official profit; cash / budget / obligations are shown
separately and never masked as profit.

**12. Commits.** reader migration + deprecations · tests + pilot + docs + report (on `main`).

**13. Remaining live gates.** G-FIN-1 (owner/accountant ratify a real month), G-FIN-7 (dashboard =
analytics = export on-instance), G-FIN-11 (production reconciliation), G-FIN-12 (PostgreSQL golden —
carried from REM-05).

## Definition of Done
- owner sees official `calculateProfit` — ✅
- dashboard, analytics and export agree — ✅ (proven; on-instance = G-FIN-7)
- no live legacy profit formulas — ✅ (`computeManagementResult`/Sale-profit have 0 live callers; dead trio deprecated)
- manager still cannot see profit — ✅ (financials/showOfd gate unchanged)
- scope preserved — ✅ (club/company/legal-entity/tenant isolation proven)
- FIN-001 + UX-005 closed — ✅ (code + tests; on-instance ratification = G-FIN-1/7/11)
- production data unchanged — ✅
- build + pilots green — ✅ (gauntlet step)
