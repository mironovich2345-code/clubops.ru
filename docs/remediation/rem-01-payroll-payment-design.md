# REM-01 — Payroll Payment Design

The atomic + idempotent design that replaces the previous multi-step, global-client payout writes.

## The shared service (`src/lib/payroll/payment-service.ts`)
`executePayrollPayment(input, db = prisma)` — the single entry point for every PayrollPayment payout
(regular/final/advance). Server actions parse + authorize + resolve scope/wallet, then call it. The
service owns the transactional core:

```
retry loop (≤5) {
  db.$transaction(Serializable, timeout 15s) {
    1. findUnique(companyId, idempotencyKey)
         → exists + same fingerprint  → return existing (replayed, NO writes)
         → exists + diff fingerprint  → IDEMPOTENCY_CONFLICT
    2. remaining guard (re-read calc.remainingKopeks INSIDE the tx) → PAYMENT_EXCEEDS_REMAINING
    3. tx.payrollPayment.create (idempotencyKey + requestFingerprint + paymentType)
    4. createSalaryExpense(..., tx)         // one Expense (+ cash movement for cash)
    5. tx.payrollPayment.update(expenseId)  // link
    6. recomputeCalculationTotals(calc, tx) // cached totals
    7. generateObligationsForPeriod(period, tx)  // obligation refresh — NOT swallowed
  }
} catch unique-violation | serialization → retry (next loop finds the committed row → replay)
```

Everything uses the **tx client** — the root-cause fix. Helpers (`createSalaryExpense`,
`recordExpenseMovement`, `recomputeCalculationTotals`, `generateObligationsForPeriod`, `reverseCashOutflow`,
`recordAudit`) accept `db: DbClient = prisma`; the default keeps every non-payout caller unchanged.

## Idempotency
- **Key:** `companyId + idempotencyKey`, a DB **`@@unique`** — not a `findFirst→create` race. The client
  sends a stable UUID per attempt; the server generates one if absent (a form must send it for true
  double-click safety).
- **Fingerprint:** sha256 of the params that *define* the payment (company, type, source, calc, employee,
  legalEntity, amount, method). Excludes the server-generated `paymentDate` and the free-text comment so a
  legitimate replay matches. Same key + same fingerprint → replay; same key + different fingerprint →
  conflict.

## Concurrency (exactly-once)
Serializable transaction + the unique constraint + a retry loop. Two parallel same-key requests: one
commits, the other hits the unique violation, retries, finds the committed row → replay (one effect). Two
different-key requests can't jointly overpay because each re-reads the live remaining inside its tx. On
sqlite the single-writer lock serializes; on **PostgreSQL** the unique constraint + Serializable + retry
provide the guarantee — see the report's PostgreSQL concurrency gate.

## Reversal (`executePayrollReversal`)
One Serializable transaction: compare-and-set `status confirmed→canceled` (idempotent — a second reversal
flips 0 rows and returns a no-op success), `cancelSalaryExpense(tx)` (cancels the Expense + posts the
compensating cash inflow), recompute, obligation refresh. Authorization is unchanged (RBAC not modified).

## Error contract (§17)
`INVALID_AMOUNT`, `PAYMENT_EXCEEDS_REMAINING`, `IDEMPOTENCY_CONFLICT`, `SERIALIZATION_RETRY_EXHAUSTED`.
`payoutErrorMessage()` maps each to a safe Russian message; raw Prisma errors never reach the UI.

## Advance + regional
- **In-period advance** (`recordAdvance`) keeps its `PayrollAdvance` record (month-unique guard already
  prevents duplicates) but wraps advance + Expense + cash + recompute in one `$transaction`.
- **Advance tranche** (`addAdvanceTranche`) already had a `$transaction` + `idempotencyKey`; REM-01 passes
  `tx` into `createSalaryExpense` so the Expense/CashMovement no longer commit outside it.
- **Regional** (`recordRegionalCityPayment`) — its own `RegionalCityPayment` model gains
  `idempotencyKey`/`requestFingerprint`; the payout runs in one `$transaction` with the overpay check
  re-evaluated inside (TOCTOU closed) and same-key replay via the unique constraint.

## Failure injection (test-only, §20)
`input._failAt` throws at `after_payment_create | after_expense_create | after_cash_movement |
before_obligation_refresh | before_commit | after_commit` — never wired to production input; used by the
integration test to prove full rollback and after-commit replay safety.
