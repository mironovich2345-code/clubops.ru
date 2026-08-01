# Manual acceptance checklist — invoice partial payment / post-factum / AI

Run on a real instance as **accountant** and **chief accountant**, with an approved invoice.

## Partial / multiple / full payment  (GATE)
- [ ] «Отметить оплату» → «Оплачено полностью»: amount = remaining (read-only); saving → status **paid**.
- [ ] «Оплачено частично»: amount required, `0 < amount ≤ remaining`; a value > remaining or ≤ 0 is refused.
- [ ] First partial → status **partially_paid**; the invoice stays in the payment queue.
- [ ] A second payment accumulates; when paidTotal = total → **paid**.
- [ ] «Осталось» is exact after each payment (kopeks).
- [ ] The payments calendar shows a partially_paid invoice's **remaining** as due (not the full amount).

## Reversal  (GATE)
- [ ] A plain **accountant** has **no** «Сторнировать» control and the action is refused server-side.
- [ ] A **chief accountant** reverses a specific payment with a required reason; status recomputes;
      the reversed payment stays in history marked «Сторнирован» (never deleted).
- [ ] After full reversal the invoice returns to its exact pre-payment approved status.

## Legacy cancel blocked
- [ ] A **paid** or **partially_paid** invoice cannot be cancelled the old way — the message points to reversal.
- [ ] No «Удалить счёт»/hard-delete for a paid invoice; payment history is preserved.

## Add already-paid  (GATE)
- [ ] «Добавить уже оплаченный счёт» (accountant/chief): short form; full paid amount → **paid**,
      partial → **partially_paid**; the payment shows «после оплаты»; no approval workflow runs.
- [ ] Analytics/budgets reflect it by its `expensePeriod`; it is not double-counted.

## Duplicate guard
- [ ] Re-adding the **same file** (or same EDO id) is **blocked** (exact).
- [ ] Same supplier INN + number + date + total → **probable**: the existing invoice is shown and a
      confirm is required; the override appears in the audit log.

## AI review  (GATE)
- [ ] Supplier is the Поставщик (not payer/address/bank/ФИО); warnings appear when it looks wrong.
- [ ] Payer is matched by **INN** within the company; a foreign-company entity is never selectable.
- [ ] The extracted amount is the final «к оплате» — a VAT / subtotal / advance value **blocks** payment
      until corrected.
- [ ] Reviewing «Данные счёта» lifts the low-confidence block; **replacing the file** or changing a
      financial field **resets** the review.

## Regression
- [ ] The regular create/approve/pay route for a normal invoice is unchanged.
- [ ] Tenant isolation: no payment/reversal/entry acts across companies/clubs.

**Sign-off:** accepted when the GATE sections pass on a real instance, with backfill run (`--apply`)
and verified to not double-count analytics.
