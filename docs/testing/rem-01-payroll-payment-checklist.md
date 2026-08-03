# REM-01 — Payroll Payment — Live Acceptance Checklist

Run on **staging** (disposable PostgreSQL), then a minimal-amount live GATE. Automated proof is done
(27/27 DB-backed integration + 39 structural + preflight); this covers PostgreSQL + real UI.

## Pre-conditions
- [ ] Migration `20260803120000_payroll_payment_idempotency` applied on staging (additive; verify row counts unchanged).
- [ ] `preflight:payroll-payments` on a **production read replica** → record offending rows (expect legacy nulls only).

## PostgreSQL concurrency gate (BLOCKER)
- [ ] `DATABASE_URL=<disposable-pg> node scripts/rem-01-payroll-payment-integration.mjs` → **27/27** on PostgreSQL (esp. checks 23/24 concurrency, 13–16 rollback).

## One-payment live GATE (minimal amount)
- [ ] Pick a test payroll obligation; record `payable / paid / remaining`.
- [ ] Record a cash salary payment (small amount) → succeeds; one PayrollPayment + one salary Expense + one CashMovement; `remaining` decreased **once**.
- [ ] **Double-click** the submit / resend the same request (same idempotencyKey) → **no second payment**; UI shows the existing result.
- [ ] Change the amount but reuse the key → **conflict** message (no write).
- [ ] Reverse the payment (allowed role) → payment `canceled`, Expense `cancelled`, compensating cash inflow, `remaining` restored to the original.
- [ ] Reverse again → idempotent no-op (no second effect).
- [ ] Overpay attempt (> remaining) → blocked with «превышает остаток».

## Advance + regional
- [ ] In-period advance: one advance + one Expense + one cash movement; a mid-flow interruption leaves nothing partial.
- [ ] Regional city payment: one payment + one Expense; double-submit with same key → one effect; overpay re-checked.

## Reconciliation
- [ ] After the GATE, `preflight:payroll-payments` on staging → 0 new offending rows.
- [ ] Cash fact balance moved by exactly the net paid amount.

**Sign-off:** accepted when the PostgreSQL concurrency gate is 27/27 and the one-payment GATE shows exactly
one effect per logical payment, reversal fully restores, and preflight is clean.
