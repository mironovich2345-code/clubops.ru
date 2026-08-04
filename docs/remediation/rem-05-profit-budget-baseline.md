# REM-05 — Profit / Budget-Fact Baseline

Read-only assessment before any REM-05 change. Money = integer kopeks.

## Git / build baseline
| Aspect | Value |
|---|---|
| HEAD | `71ea1bb` |
| Branch | `main` |
| Origin divergence | 24 commits ahead of `origin/main` |
| Working tree | clean |
| tsc | 0 errors |
| prisma dev / prod | valid |
| pilot:full | 3977/0 across 90 suites (REM-04 gauntlet) |
| build:prod | compiles |

## Current profit readers (from Audit 3 `profit-formulas.md`)
| # | Location | Formula | Wired? |
|---|---|---|---|
| 1 | `analytics.ts` `summary.profitKopeks` | Sale+SalesReport − spend | **live (analytics)** |
| 2 | `analytics/page.tsx` `useOfd?` | OFD-net − expenses | **live (card, competes with #1)** |
| 3 | `ofd-management.ts` `computeManagementResult` | OFD-net − confirmed costs | live |
| 4 | multi-company card | OFD income − expenses | live |
| 5–9 | `dashboard.ts` profit trio | Sale − expenses | **DEAD CODE** |

**Divergences:** two live profit definitions on the same card (Sale/SalesReport vs OFD-net, chosen by
`useOfd`); **payroll accrual absent** from every reader; **partially_paid invoices dropped** (analytics
counts `status:paid` only); refunds added to spend (single-effect). → FIN-001, FIN-002, UX-005.

## Current budget-fact readers (from `budget-fact-model.md`)
| Function | Expenses | Invoices | Refunds | Reader |
|---|---|---|---|---|
| `computeUsedKopeks` (`budgets.ts:76`) | confirmed+verified | approved-unpaid + paid | approved+paid | "Использовано" + gate |
| `computeBudgetOverruns` (`budgets.ts:162`) | **confirmed ONLY** | approved-unpaid + paid | approved+paid | overrun alerts |
| `computeBudgetFactReport` (`budgets.ts:280`) | **confirmed ONLY** | **paid ONLY** | **paid ONLY** | Plan/Fact tab + analytics |

**Divergences:** v2 `verified` expenses dropped by Plan/Fact + overruns (DATA-018/019); `partially_paid`
invoices in **none** (not approved-unpaid, not paid) — FIN-002; refund period source differs. → FIN-003.

## Recognized-expense inputs today (no single service)
- Realized expense set: `EXPENSE_REALIZED_STATUSES = ["confirmed","verified"]` (`budgets.ts:42`) — the
  one shared constant, but the three fact functions apply it inconsistently.
- Invoice recognized amount: full `amountKopeks` by `invoiceExpensePeriod` (`invoices.ts:43`).
- Approved payroll accrual: `PayrollCalculation.netPayableKopeks` (`aggregate.ts`) — **not read by any
  profit/budget reader**.
- Refund recognized amount: `refundResultAmountKopeks ?? amountKopeks`; recognized states differ v1/v2.
- OFD revenue: `loadOfdManagementOverview` → `totals.netKopeks` (income − OFD returns).

## Status / period / date filters (as-is)
- Expenses by `expenseDate`; invoices by `expensePeriod` (accrual); refunds by `refundDate??paidAt??
  createdAt` (used) vs `paidAt??refundDate??createdAt` (fact-report) — inconsistent.
- No reader includes approved payroll accrual; several use `createdAt` as a silent fallback.

## Known dev divergences
- One payroll calc `net ≠ paid + remaining` (Audit 3 dev reconciliation); production UNVERIFIED.

## Scope of REM-05
Build ONE recognized-expense service + ONE profit service + ONE budget-fact service, migrate the
critical readers, close FIN-001/002/003/006/007 + DATA-018/019 + UX-005, prove with real DB tests +
a golden scenario, and add preflight + reconciliation. No production data change; no formula/RBAC/
status/tenant change; historical rows reinterpreted, never rewritten.
