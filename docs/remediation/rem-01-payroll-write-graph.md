# REM-01 — Payroll Write Graph (current, pre-change)

Exact record chains today (`aefeb4f`). "GLOBAL" = the step runs on the imported global `prisma`, so it
commits independently even inside a surrounding `$transaction`. This is the graph the fix must make
atomic + idempotent. Read before changing anything.

## A. Ordinary / final salary payment — `recordPayment` (periods/actions.ts)
1. guards: role (cash→operational, bank→accounting), period in `PAYABLE_STATUSES`, `amountKopeks>0` — **no remaining guard**.
2. `payrollPayment.create` status `confirmed`, `expenseId=null` — **no idempotency**.
3. `createSalaryExpense` → `expense.create` (**GLOBAL**) + for cash `recordExpenseMovement` → `cashMovement.create` (**GLOBAL**).
4. `payrollPayment.update` sets `expenseId` (2nd write).
5. `recomputeCalculationTotals(calc.id)` (**GLOBAL**) → recompute `paidKopeks/remainingKopeks`.
6. `refreshPeriodObligations` — **best-effort, errors swallowed** (DATA-016).
7. audit (best-effort try/catch).
**No `$transaction`.** Partial-success + retry both unsafe. Double-submit → 2 payments + 2 expenses + 2 cash movements.

## B. In-period advance — `recordAdvance` (periods/actions.ts)
1. month dup guard (`payrollAdvance.findFirst` status in paid/approved/requested).
2. remaining guard `advanceWithinEarned(amount, netPayable)`.
3. `payrollAdvance.create` status `paid`, `expenseId=null`.
4. `createSalaryExpense(kind:"advance")` (**GLOBAL** expense + cash).
5. `payrollAdvance.update` expenseId; `recomputeCalculationTotals` (**GLOBAL**).
**No `$transaction`.** Month dup-guard blocks most double-submits; mid-flow failure still orphans.

## C. Regional city payment — `recordRegionalCityPayment` (regional/actions.ts)
1. overpay guard: read `regionalTotals`; `excess = newPaid − accrued`; refuse if `>0 && !allowOverpayment` — **non-atomic TOCTOU** (ARCH-003).
2. `regionalCityPayment.create` status `confirmed`, `expenseId=null` — **no idempotency**.
3. `createSalaryExpense` (**GLOBAL**) + cash.
4. `regionalCityPayment.update` expenseId.
5. if overpay allowed: `employeeFinancialObligation.create` — **`employeeId = regionalEmployeeId ?? payrollId`** (DATA-010: a `RegionalCityPayroll.id` can land in `employeeId`).
**No `$transaction`, no idempotency.** `cancelRegionalCityPayment` reverses the expense but **not** the overpay obligation (DATA-011).

## D. Advance tranche — `addAdvanceTranche` (advance-actions.ts) — the only one with `$transaction`
- pre-check `payrollAdvancePayment.findUnique({idempotencyKey})`; DB `@@unique(idempotencyKey)`.
- **inside** `$transaction`: re-read `activePaidKopeks(tx)` → `trancheExceedsApproved` → `createSalaryExpense` (**GLOBAL — commits outside the tx!**) → `tx.cashMovement.findFirst` → `tx.payrollAdvancePayment.create` → `tx.payrollAdvance.update`.
- **Atomicity gap:** the Expense + CashMovement (GLOBAL) commit even if the tranche rows roll back → orphan Expense + orphan CashMovement (ARCH-004). Overpay read `activePaidKopeks` is not row-locked → concurrent tranches can both pass.

## E. Reversal — `cancelPayment` (periods/actions.ts) + `cancelSalaryExpense`
1. guard `status==="confirmed"` (compare-then-flip, not CAS on the row).
2. `cancelSalaryExpense(expenseId)` (**GLOBAL**): `cashMovement.findFirst` → `reverseCashOutflow` (**GLOBAL** compensating inflow) → `expense.update` status `cancelled`.
3. `payrollPayment.update` status `canceled`.
4. `recomputeCalculationTotals` (**GLOBAL**).
- **Orphan:** if `expenseId` is null (a step-3 failure in A), `cancelSalaryExpense(null)` no-ops → money left the wallet but is never restored, yet the payment flips to canceled. Multi-step, non-atomic.

## Shared fix (what REM-01 introduces)
- Thread `db: Db = prisma` (`typeof prisma | Prisma.TransactionClient`) through `createSalaryExpense`, `cancelSalaryExpense`, `reverseCashOutflow`, `recomputeCalculationTotals`, `generateObligationsForPeriod` (default preserves every existing caller).
- One `executePayrollPayment(...)` service: inside `$transaction` → reserve idempotencyKey (DB unique) → re-read source + remaining → create PayrollPayment → createSalaryExpense(tx) → recordExpenseMovement(tx) → recompute(tx) → obligation refresh(tx) → audit. Replay (same key+fingerprint) returns the existing payment with **no** new writes; key+different-fingerprint → conflict.
- `executePayrollReversal(...)`: one `$transaction` for the expense cancel + cash reverse + status flip + recompute; idempotent; chief-only.
- All of A–E route through these two services; advance + regional get the same guarantee.
