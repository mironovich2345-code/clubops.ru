# Invoice partial payment / post-factum / AI quality — report

Only payment, post-factum entry, and AI quality were extended. The approval route, manager/regional
rights outside invoices, tenant isolation, multi-account, expenses, refunds, payroll, cash formulas,
budgets, and analytics formulas outside invoice payment are unchanged.

1. **Model before:** payment was binary — `transitionInvoice` set `paidAt` + status `paid`; no partial
   amount, no per-payment record. `saveHistoricalInvoice` already created `paid` invoices post-factum.
2. **New model:** append-only `InvoicePayment` (companyId/invoiceId/amountKopeks/paymentDate/source/
   method/comment/proofDocumentId/createdById/status confirmed|reversed/reversal fields/
   reversesPaymentId/idempotencyKey/enteredAfterPayment/legacyBackfill) + `Invoice.prePaymentStatus`.
3. **paidTotal** = Σ confirmed payments (integer kopeks; reversed excluded).
4. **remainingTotal** = invoiceTotal − paidTotal.
5. **Multiple payments** accumulate on the same invoice; each has its own date/source.
6. **partially_paid** = `0 < paidTotal < invoiceTotal` (derived, never picked by the accountant).
7. **Reverse:** chief accountant ONLY (`canReverseInvoicePayment`), with a required reason; flips the
   payment `confirmed→reversed` (append-only, never deleted) and recomputes status.
8. **Legacy cancel blocked** for paid/partially_paid (removed from `INVOICE_CANCELABLE`; the action
   returns a message pointing to reversal). No hard delete.
9. **Add already-paid:** `saveHistoricalInvoice` creates the invoice + an `InvoicePayment`
   (`enteredAfterPayment=true`), paid amount → `paid`|`partially_paid`, source ЭДО/банк/другое; badge
   «после оплаты».
10. **Duplicate detection:** exact (file hash / EDO id) blocks; probable (INN+number+date+total)
    requires confirm (audited); weak (≥2 fields) warns.
11. **Financial-fact date:** the invoice accrues by `expensePeriod` (unchanged); the cash payment fact
    is `paymentDate` per partial payment.
12. **Backfill:** one `legacy_backfill` payment per paid invoice, idempotent, dry-run/apply,
    non-destructive.
13. **No double count:** analytics/budgets read the `Invoice` (by expensePeriod), never
    `InvoicePayment`; payments are capped at the total; the calendar obligation for partially_paid is
    the **remaining**.
14. **Real AI risks addressed:** supplier confused with payer/address/bank/ФИО; payer picked by name
    instead of INN; VAT / subtotal / advance mistaken for the final «к оплате».
15. **Supplier extraction:** `normalizeSupplierName` (meaning preserved) + `supplierNameWarnings`.
16. **Payer by INN:** `matchPayerByInn` — company-scoped, 10/12-digit validation, one/none/multiple.
17. **Final payable amount:** `selectPayableAmount` + `amountBlocksPayment` (blocks on VAT/subtotal/
    advance/negative/zero/multiple totals until reviewed); review resets on file/field change.
18. **Migrations:** additive dev sqlite + prod postgres (CREATE TABLE InvoicePayment + ADD COLUMN
    prePaymentStatus); no recompute, no delete; schemas valid.
19. **Tests / build:** `pilot:invoice-partial-payment-postfactum` **45/45**; `pilot:full`
    **3547/0 across 78 suites**; tsc clean; prisma dev+prod valid; `build:prod` compiled.
20. **Commit hashes:** see `git log` (audit → model/migration → payment actions → payment UI →
    backfill/dedupe/AI → obligation/AI-wire → tests → docs).
21. **Manual checks:** see `invoice-partial-payment-postfactum-checklist.md`.
