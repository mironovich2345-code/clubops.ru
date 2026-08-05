# REM-08 — Legacy Ledgerless Paid Invoices — Controlled Plan

Existing `paid`/`partially_paid` invoices with **no confirmed InvoicePayment** (created by the retired
binary pay). They stay VISIBLE and are **never auto-repaired**.

## Rules
- **No synthetic payment rows.** REM-08 never fabricates a payment without evidence.
- The FULL invoice amount stays recognized as EXPENSE (REM-05) — a missing ledger does NOT drop the expense.
- `paidTotal` by ledger stays `0`; the UI must NOT silently show "оплачено 100%". A warning
  `legacy_ledger_missing` is surfaced by `preflight:invoice-payment-ledger` (IPL-01) and
  `reconcile:invoice-payments`.

## Read-only report (spec §15)
`npm run reconcile:invoice-payments [--company=ID] [--mismatch-only]` lists, per invoice: total, confirmed
paid, reversed, remaining, derived state vs stored status, `legacy_ledger_missing`, payment-row count.
`preflight:invoice-payment-ledger` gives counts + amount impact + a recommended manual action.

## Accountant decisions (manual, per invoice — NOT bulk/automatic)
- **A. Confirm the historical payment** — record an explicit historical InvoicePayment
  (`enteredAfterPayment`/`legacyBackfill`) with actor + date + evidence via `saveHistoricalInvoice`
  (creates the ledger row atomically; no duplicate expense; audited).
- **B. The legacy `paid` was wrong** — use the correction workflow (no hard delete).
- **C. Leave unresolved** — the `legacy_ledger_missing` warning remains until reviewed.

## Findings closure implication
- **DATA-005 / FIN-006** are CLOSED for all NEW writes (status=paid requires a ledger row) but stay
  **PARTIALLY CLOSED** for historical rows until an accountant reviews this report on production
  (G-INVLEDGER-8/9). REM-08 does not consider historical data reconciled without that manual review.
