# Invoice AI review guide

AI extraction is a **draft** — the accountant verifies critical fields before payment. The pipeline
never invents a value; it flags doubt via warnings and (for the amount) blocks payment until reviewed.

## Supplier (counterparty) — §14
Taken from the **supplier / Поставщик** block, never the payer, address, bank line, signer, or OCR
noise. `normalizeSupplierName` trims, collapses spaces, and unifies quotes to «» **without** losing
meaning (no translation, no dropping significant characters; Cyrillic/Latin/digits/quotes/hyphens/
organizational form kept). Warnings: empty, looks-like-address, looks-like-bank, looks-like-ФИО,
conflicts with the payer name, matches the payer with a different INN, low confidence.

## Payer — matched by INN first — §15
1. Extract payer INN, keep digits only. 2. Validate length: **10** → legal entity, **12** → ИП, else
invalid. 3. Match against the **selected company's** `LegalEntity` list (company scope only — a legal
entity of another company is never selectable). 4. One match → auto-select with evidence; none →
warning + payment blocked until manual review; multiple → warning + manual selection. The textual
name is a **secondary** signal used only to disambiguate multiples.

## Final payable amount — §16
Extract the **final «к оплате»** amount, not the amount без НДС, the НДС line, a line price, a
subtotal, an advance/предоплата, another document's debt, the contract total, or words-only sums.
`selectPayableAmount` prefers a labelled «(итого/всего) к оплате» value; if only a VAT / subtotal /
advance line is present, or there are several conflicting totals, or the value is negative/zero, it
**blocks payment** (`amountBlocksPayment`) until the accountant corrects it. Evidence kept: label,
value, (page/bounding when the pipeline supports it), confidence.

## Manual review + reset — §17
The accountant reviews the critical fields (counterparty, supplier INN, payer, payer INN, final
payable amount, account number, BIK) and saves «Данные счёта» → `aiDataReviewedAt` / `aiDataReviewedById`
are stamped, which (with the payment guard) lifts the low-confidence block. If the **file** is
replaced or any **financial field** changes afterwards, the manual review is **reset**
(`aiDataReviewedAt = null`) and must be re-done — so a payment is never made on stale, unreviewed data.
The approval fingerprint (`approvedDataFingerprint`) additionally refuses payment if the data changed
after approval.
