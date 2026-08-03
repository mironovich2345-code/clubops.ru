# REM-01 — Payroll Payment Safety — Baseline

First remediation task after the 6-audit program. Closes (target): **ARCH-002, ARCH-003, ARCH-004,
DATA-003, FIN-005, SEC-001**, partially **DATA-016**. Additive only — **no salary formula, netPayable,
scheme, budget, forecast, closed-period, RBAC, invoice/refund, or cash-formula change; no automatic
production backfill.**

## Audited baseline
- **HEAD:** `aefeb4f` · **branch:** `main` · **vs origin/main:** in sync · **tree:** clean.
- **tsc:** clean (0). **prisma validate:** dev + prod valid. **pilot:full:** **3849 passed / 0 across 86 suites.** **build:prod:** compiles (audit-6 close; app code unchanged since).
- Date: 2026-08-03.

## Exact functions & paths in scope
| Concern | File:function |
|---|---|
| Ordinary + final salary payment | `src/app/(app)/payroll/periods/actions.ts` → `recordPayment` (~735), `cancelPayment` (~791) |
| In-period advance | `src/app/(app)/payroll/periods/actions.ts` → `recordAdvance` (~829), `cancelAdvance` (~931) |
| Pre-period advance + tranches | `src/app/(app)/payroll/advance-actions.ts` → `payoutAdvance` (~52), `addAdvanceTranche` (~273), `reverseAdvanceTranche` (~335) |
| Regional city payment | `src/app/(app)/payroll/regional/actions.ts` → `payRegionalCityPayment` / `recordRegionalCityPayment` (~91), `cancelRegionalCityPayment` (~169) |
| PayrollPayment row | `prisma/schema.prisma` model `PayrollPayment` — **no `idempotencyKey`** |
| RegionalCityPayment row | `prisma/schema.prisma` model `RegionalCityPayment` — **no `idempotencyKey`** |
| Salary Expense (the ONE money record) | `src/lib/payroll/salary-expense.ts` → `createSalaryExpense` (37), `cancelSalaryExpense` (79) — **uses global `prisma`** |
| Cash movement | `src/lib/cash-wallets.ts` → `recordExpenseMovement` (132, already `db: Db = prisma`), `reverseCashOutflow` in `src/lib/payroll/payments.ts` (**global prisma**) |
| Calc totals cache | `src/lib/payroll/aggregate.ts` → `recomputeCalculationTotals` (10) — **global prisma** |
| Obligation refresh | `src/lib/payroll/payment-obligation.ts` → `generateObligationsForPeriod` (70) — **global prisma**; `refreshPeriodObligations` (`periods/actions.ts:42`) **swallows errors** (DATA-016) |
| Reversal cash | `src/lib/payroll/payments.ts` → `reverseCashOutflow` (**global prisma**) |

## Root cause (why the findings exist)
The infra pattern `Db = typeof prisma | Prisma.TransactionClient` already exists in `cash-wallets.ts`
and `recordExpenseMovement`/`ensure*Wallet`/`walletBalanceKopeks` already accept `db: Db = prisma`. But
**`createSalaryExpense`, `cancelSalaryExpense`, `reverseCashOutflow`, `recomputeCalculationTotals`, and
`generateObligationsForPeriod` still use the imported global `prisma`.** So a payout's three writes
(PayrollPayment + salary Expense + CashMovement) commit **independently** — a `$transaction` around them
would not include the Expense/CashMovement. Combined with **no `idempotencyKey`** on PayrollPayment, a
double-submit / retry / concurrent request produces duplicate payment + duplicate expense + duplicate
cash deduction (FIN-005), and a mid-flow failure orphans records (ARCH-002/004).

## Definition of done (this task)
One logical payout = exactly one financial effect; all related writes atomic (all-or-nothing); retry &
double-click & concurrent requests safe; advance + regional share the same guarantee; reversal atomic &
idempotent & chief-only; **real DB-backed integration tests** prove rollback + replay (not source-string
mirrors); salary formulas unchanged; production data untouched; build + pilot:full green.
