# CLUB-OPS — Invoice Payment Paths (ARCH-010 / DATA-005 deep dive)

Read-only analysis at `66bc9e3`. An invoice can reach `paid`/`partially_paid` by more than one
path; one of them writes **no** `InvoicePayment` ledger row.

## The four writers of a paid/partially_paid invoice
| # | Writer | Path | Ledger row? |
|---|---|---|---|
| 1 | `transitionInvoice` action `pay` (`invoices/actions.ts:1278`, table `invoices.ts:241`) | **legacy binary pay** approved_* → paid | **NO** |
| 2 | `recordInvoicePayment` (`invoices/actions.ts:679`) | ledger — creates confirmed `InvoicePayment` in a `$transaction` + `idempotencyKey` | yes |
| 3 | `reverseInvoicePayment` (`invoices/actions.ts:717`) | ledger — flips a payment to `reversed`, re-derives status | yes |
| 4 | `saveHistoricalInvoice` (`invoices/actions.ts:578` + ledger `:582`) | post-factum historical | yes (writes a ledger row) |

## Can a ledgerless `paid` exist? — YES
- The legacy `pay` action (#1) sets `status:"paid"` directly and writes **no** `InvoicePayment`, so `paidTotalKopeks = Σ confirmed InvoicePayment = 0` while `status = "paid"`.
- The legacy `pay` button and the ledger payment form **coexist on the same invoice detail page** for an approved invoice → a user can produce a `paid` invoice with an empty ledger.
- **Consequence:** `Invoice.status` (a cache) can contradict its ledger; `remaining = amount − 0 = amount` even though the invoice reads "paid". Any reader trusting `status` (payment calendar `payments.ts:9`) disagrees with any reader trusting the ledger (`invoice-payments.ts`).

## `partially_paid` cross-surface inconsistency (DATA-006)
`partially_paid` is produced by `derivedInvoiceStatus` (`invoice-payments.ts:31`) and accepted by
the payable set (`invoices/actions.ts:640`), but:
- **absent** from `INVOICE_STATUSES`, labels, and `applyInvoiceAction` (no workflow transitions);
- **excluded** from analytics spend and network debt (`analytics.ts:205,210`) and from budget "used" (`budgets.ts:310`);
- **included** in the payment calendar (`payments.ts:9`).
So a partially-paid invoice is simultaneously "not spend / not debt" (analytics & budget) and "a
pending obligation" (calendar) — an intra-report split.

## How `paidTotal`/`remaining`/`status` are derived (the correct path)
Pure, append-only (`invoice-payments.ts:15-33`): `paidTotal = Σ confirmed InvoicePayment`;
`remaining = total − paidTotal`; `derivedInvoiceStatus`: `paid≥total→paid`, `paid>0→partially_paid`,
else restore `prePaymentStatus`. Reversal is a status flip (chief-accountant only), never an edit.
**No double count:** analytics/budgets read `prisma.invoice` by `expensePeriod` and never read
`InvoicePayment` (`invoice-payments.ts:1-3`). Double **payment** is blocked by `idempotencyKey`
(P2002 = duplicate-success) — but only on the ledger path; the legacy `pay` has no such guard.

## Backfill treatment
`scripts/backfill-invoice-payments.mjs` creates a deterministic `"legacy:<invoiceId>"` ledger row
for historical paid invoices (idempotent). So legacy paid rows **can** be reconciled — but the
legacy `pay` action is still live and can create new ledgerless paids after a backfill.

## Conclusion (for remediation — NOT done here)
- **Verify against the running UI** whether the legacy `pay` button is still exposed on the invoice
  detail page (code shows both present). If exposed, retire it or make it write an `InvoicePayment`
  row (DATA-005 / ARCH-010, P1).
- Declare `partially_paid` in `INVOICE_STATUSES` + labels and reconcile its treatment across
  analytics/budget/calendar (DATA-006, P1/P2).
- Production preflight: `DATA-CHK-11` (paid/partially_paid with no confirmed payment) and
  `DATA-CHK-12` (payments exceeding total) — run against a production read replica.
