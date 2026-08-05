# REM-05A — Profit Live-Reader Checklist

Automated proof done (`test:rem-05a-profit-readers` 12/12; `pilot:rem-05a-profit-live-readers`). Live gates:

- [ ] **G-FIN-1** Owner + accountant ratify the official profit for a REAL month (revenue + recognized breakdown).
- [ ] **G-FIN-7** Dashboard club-card "Результат" = analytics "Прибыль" = any export, for the same scope + month.
- [ ] **G-FIN-11** Production read-only `reconcile:profit-budget-fact` on a replica — 0 unexplained diffs; no live legacy reader.
- [ ] **G-FIN-12** (carried) Golden scenario reproduced exactly on staging PostgreSQL (330,000 ₽).

**Closed by REM-05A:** every LIVE profit reader now uses `calculateProfit` (analytics) or its exact
composition (club card = OFD net byClub − recognized byClub). No live `computeManagementResult` /
Sale-profit caller remains; the dead `dashboard.ts` trio is deprecated. Manager still cannot see profit
(the `financials`/`showOfd` gate is unchanged). **FIN-001 + UX-005 CLOSED** on code + tests;
G-FIN-1/7/11 are the on-instance confirmations.
