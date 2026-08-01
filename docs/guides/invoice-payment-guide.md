# Invoice payment guide — partial, multiple, reversal, post-factum

The regular invoice approval route is unchanged. Payment now uses an **append-only ledger**
(`InvoicePayment`) that supports partial + multiple payments, reversal, and post-factum entry.

## Aggregates (integer kopeks, exact)
```
paidTotal      = Σ confirmed payments        (reversed payments leave the confirmed set)
remainingTotal = invoiceTotal − paidTotal
```
`paidTotal` never < 0 and never > invoiceTotal (overpayment is refused; a future scenario).
Aggregates are **derived** from the ledger (not a stored source of truth); the invoice status is
recomputed transactionally on every payment/reversal.

## Status (derived from paidTotal — the accountant never picks it)
- `0 paid` → the pre-payment approved state (`approved_by_regional/chief/owner`).
- `0 < paid < total` → **partially_paid** (still in the payment queue; the calendar shows the
  **remaining** as due).
- `paid = total` → **paid**.
On full reversal the exact **pre-payment** approved status is restored (captured on the first payment).

## «Отметить оплату» (accountant / chief)
On the invoice detail: **Оплачено полностью** (amount = remaining, read-only) or **Оплачено
частично** (amount required, `0 < amount ≤ remaining`). The form shows сумма счёта / ранее оплачено
/ текущий платёж / останется. Saving creates one `InvoicePayment (confirmed)`, recomputes the
status, and shows the payment in **История оплат** immediately. A partial payment keeps the invoice
in the queue; the final payment marks it paid. `idempotencyKey` blocks a double submit.

## Reversal — chief accountant ONLY (§7)
A plain accountant **cannot** reverse, delete, or edit a confirmed payment, nor cancel a paid
invoice, nor revert paid→approved by hand. The **chief accountant** «Сторнирует платёж»: picks the
specific paymentId, gives a **required reason**; the payment flips `confirmed → reversed` (author +
time + reason recorded) — it is **never deleted** — and `paidTotal` / `remaining` / status are
recomputed. owner/GD/accountant do **not** get this right automatically.

## Legacy cancel blocked for paid / partially_paid (§8)
`paid` and `partially_paid` are removed from the cancelable set. Such an invoice can only be adjusted
by **reversing a specific payment** (chief). Invoices are never hard-deleted; payment history is
preserved. A mistaken invoice is handled by reversing its payment(s), not by destroying money history.

## «Добавить уже оплаченный счёт» (post-factum, accountant / chief)
For invoices paid before entry (ЭДО, bank, historical). Short form: club, payer legal entity,
counterparty + INN, number, invoice date, total, **paid amount** (full or partial), payment date,
source (ЭДО/банк/другое), comment. On save it creates the `Invoice` **and** an `InvoicePayment`
(`enteredAfterPayment = true`) — no approval workflow runs; status is derived from the paid amount
(`paid` | `partially_paid`); the payment shows a **«после оплаты»** marker. If a document is uploaded,
AI prefills the fields for review.

## Duplicate guard (§11)
- **Exact** (same file hash OR EDO id) → **blocked**.
- **Probable** (same supplier INN + number + date + total) → the existing invoice is shown; adding
  requires an explicit confirm (`confirmDuplicate`); the override is **audited**.
- **Weak** (≥2 of INN/number/amount) → warning only.

## Financial-fact date & no double count (§12)
- The invoice reflects in **expenses / budgets / analytics by `expensePeriod` (accrual)** — unchanged.
  This is the accounting definition and it is **not** altered.
- The **cash-payment fact** is `InvoicePayment.paymentDate` (each partial payment on its own date).
  Analytics/budgets do **not** read `InvoicePayment`, so the amount never counts twice; payments are
  capped at the invoice total.
- The **payments calendar** obligation for a `partially_paid` invoice is the **remaining** amount
  (invoiceTotal − confirmed payments); a fully covered invoice drops off.

## Backfill (§13)
`npm run backfill:invoice-payments` (dry-run) / `--apply`: creates ONE `legacy_backfill` payment per
existing `paid` invoice (full amount, `paymentDate = paidAt`), idempotent (`idempotencyKey =
legacy:<id>`), non-destructive; unpaid invoices untouched; analytics unchanged → **no double count**.
