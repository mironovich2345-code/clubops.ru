# REM-05A — Profit Live-Reader Baseline

Read-only assessment before the reader migration. Money = kopeks.

## Git baseline
| Aspect | Value |
|---|---|
| HEAD | `a46234c` |
| tsc | 0 · prisma dev/prod valid · pilot:full 4076/0 (REM-07) · build:prod compiles |

## Live profit readers BEFORE (from REM-05 formula map)
| Reader | Path | Revenue | Expense | Basis |
|---|---|---|---|---|
| Analytics "Финансовый итог" card | `analytics/page.tsx` `FinancialSummaryCard` | `useOfd? OFD net : Sale+SalesReport` | `useOfd? expenseSummary : spend` | **competing (UX-005)** |
| Analytics "Результат (ОФД − расходы)" KPI | `analytics/page.tsx` | OFD net | `s.expensesKopeks` (summary) | legacy (no payroll/partially_paid) |
| Dashboard club-card "Результат" | `dashboard/_components/ClubCard.tsx` + `dashboard-cards.ts` | OFD net byClub | `s.expensesKopeks` byClub | legacy per club |
| `dashboard.ts` profit trio | `dashboard.ts` | Sale | Expense | **DEAD CODE (no importers)** |

## Canonical service (REM-05, unchanged)
`calculateProfit` = OFD net revenue − `loadRecognizedExpenses` (payroll accrual + partially_paid
invoices in FULL + refunds + taxes). Proven 31/31 + golden scenario (profit 330,000 ₽).

## Findings (partial before REM-05A)
- **FIN-001** — live analytics/dashboard cards used a legacy/competing profit basis.
- **UX-005** — the analytics card showed OFD-result vs Sale-profit as one figure depending on `useOfd`.

## Approach
Point every LIVE profit reader at `calculateProfit` (analytics) or its exact composition (club card =
OFD net byClub − recognized byClub, via ONE scoped `loadRecognizedExpenses` — no N+1). Deprecate the
dead `dashboard.ts` trio + `computeManagementResult` (0 live callers). No formula/RBAC/data change; the
`financials`/`showOfd` role gates (manager can't see profit) are untouched.
