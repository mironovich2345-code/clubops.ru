# REM-05 — Profit / Budget-Fact Live Acceptance Checklist

Automated proof is done (`test:rem-05-integration` 31/31 incl. the golden scenario;
`pilot:rem-05-profit-budget-fact`). These are the live gates on real data.

- [ ] **G-FIN-1** Accountant/owner ratifies canonical profit on a REAL month (revenue − recognized breakdown).
- [ ] **G-FIN-2** A `partially_paid` invoice is in the full recognized expense (not scaled by paid %).
- [ ] **G-FIN-3** Two `InvoicePayment` rows do NOT change the recognized invoice amount.
- [ ] **G-FIN-4** Approved payroll accrual is included exactly once (no salary-Expense double count).
- [ ] **G-FIN-5** A refund is one recognized expense; OFD revenue is unchanged.
- [ ] **G-FIN-6** «Приход Иное» / collections / transfers are excluded from profit.
- [ ] **G-FIN-7** Dashboard = analytics = export for the same scope + month (reader migration complete).
- [ ] **G-FIN-8** Budget fact = Plan-vs-Fact = "Использовано" (incl. v2 verified + partially_paid + payroll).
- [ ] **G-FIN-9** A v2 `verified` expense appears in Plan/Fact and overrun alerts.
- [ ] **G-FIN-10** A VAT-bearing invoice + a tax expense sample are not double-counted; VAT not added on top.
- [ ] **G-FIN-11** Production read-only `reconcile:profit-budget-fact` reviewed on a replica (0 unexplained diffs).
- [ ] **G-FIN-12** Golden scenario reproduced exactly on staging PostgreSQL (330,000 ₽).

**Sign-off:** FIN-002/003 + DATA-018/019 close on the reader migration + tests (done for Plan/Fact,
overruns, "Использовано"). FIN-001/UX-005 close when the dashboard/analytics profit cards adopt
`calculateProfit` (G-FIN-1/7). Until then they are PARTIALLY CLOSED.

## PostgreSQL gate (§27)
Apply migrations (none required for REM-05), run `test:rem-05-integration` + `preflight:profit-
budget-fact` + `reconcile:profit-budget-fact` on restored/test PostgreSQL, and compare dashboard /
analytics / budget. SQLite success alone is not the production proof.
