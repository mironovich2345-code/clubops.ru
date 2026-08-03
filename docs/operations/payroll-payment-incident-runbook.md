# Payroll Payment — Incident Runbook (post-REM-01)

Detect → Contain → Diagnose (read-only) → Recover → Preserve. All diagnostics are SELECT-only.

## Detection signals
- Finance reports a double salary payment / double cash deduction.
- `preflight:payroll-payments` (scheduled on a read replica) flags PP-01 (duplicate), PP-02/09 (phantom), PP-04 (amount mismatch), PP-07 (overpaid), PP-08 (obligation lag).

## Suspected double payment
1. **Contain:** restrict payroll access if active (no in-app write-freeze yet — OPS-018).
2. **Diagnose (read-only):** `npm run preflight:payroll-payments -- --json` → inspect PP-01/PP-06. With REM-01, two confirmed PayrollPayments with the **same `idempotencyKey`** are impossible (DB unique). A true duplicate would be **two different keys** for the same logical payment (e.g. a user submitting twice with a fresh key each time) — check same (calc, amount, minute).
3. **Recover:** reverse the extra payment via the normal reversal (atomic; cancels its Expense + posts the compensating inflow; recomputes remaining). Never delete rows.
4. **Preserve:** the two payment ids, expense ids, movement ids, audit rows.
5. **Follow-up:** if duplicates came from the UI not sending a stable key, verify the form's `idempotencyKey` hidden field per attempt.

## Phantom payment (confirmed, no expense) — should be impossible post-REM-01
The service links the expense inside the tx, so a confirmed payment without an expense cannot be created.
If PP-02 flags one, it is a **legacy** (pre-REM-01) row. Diagnose its era (createdAt), then reverse/correct
manually with finance sign-off.

## Obligation shows the wrong «к выплате»
Post-REM-01 the obligation is refreshed inside the payment/reversal tx (not swallowed), so a lag should
not appear for new payments. PP-08 flags legacy lag. Recover by re-running the period's obligation
generation (idempotent) — read the period, regenerate.

## Replay / retry confusion
A user retrying after a timeout with the **same key** always returns the existing payment (no new effect).
If a user reports "it said error but the money went out", confirm via the audit log
(`payroll.payment_recorded` vs `payroll.payment_replayed`) — the after-commit case is safe by design
(integration test 17).

## Escalation
Money discrepancy that reversal cannot resolve → finance + owner; preserve evidence; consider a staging
restore + reconciliation (see `disaster-recovery-plan.md`). Do not run destructive commands.
