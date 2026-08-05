# Invoice Payment Reconciliation Runbook (REM-08)

The InvoicePayment ledger is the single source of payment fact. `Invoice.status` is a synced reflection.

## Read-only tools
- `npm run preflight:invoice-payment-ledger [--json]` — status/ledger inconsistencies + legacy ledgerless
  paid + amount impact + recommended action (IPL-01..18). S0 (duplicate key / cross-company) blocks.
- `npm run reconcile:invoice-payments [--company=ID] [--invoice=ID] [--month=YYYY-MM] [--mismatch-only]` —
  per invoice: total / confirmed paid / reversed / remaining / derived state vs stored status / legacy
  warning.

## Legacy ledgerless paid invoice (`legacy_ledger_missing`)
A paid/partially_paid invoice with no confirmed payment (retired binary pay). The FULL amount is still a
recognized expense (REM-05); only the "how much paid" is unknown. Resolve MANUALLY, per invoice:
1. **Historical payment confirmed** → record an explicit historical InvoicePayment (actor + date +
   evidence) via the post-factum flow — creates the ledger row; no duplicate expense; audited.
2. **Legacy `paid` was wrong** → correction workflow (never hard-delete).
3. **Unresolved** → the warning stays. Never fabricate a payment row without evidence.

## Status/ledger mismatch (IPL-18)
Stored status ≠ ledger-derived state. Investigate (a stuck status). The next payment/reversal re-syncs it;
if none is due, correct via the workflow. Do not hand-edit `Invoice.status`.

## Do NOT
- Do not mark an invoice paid outside the ledger (the binary pay is retired). Do not bulk-repair legacy
  rows. Do not delete payment rows (reversal is append-only).
