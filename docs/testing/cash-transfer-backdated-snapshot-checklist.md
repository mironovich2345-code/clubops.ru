# Manual acceptance checklist — cash transfer + backdated snapshots

Run on a real instance with seeded roles (owner, GD, regional director, club manager, accountant)
and at least one club with an active ИП. Static + pilot + build are already green; this covers what
only live data + real RBAC confirm. **Not accepted** until every GATE box passes.

## Transfer — create & effect on money  (GATE)
- [ ] «Передать деньги региональному директору» card is visible to a club manager / regional.
- [ ] Recipient dropdown lists ONLY active regional directors with access to the club (archived /
      other-company users are absent); a single eligible director is preselected but shown.
- [ ] Creating a transfer shows «Ожидает подтверждения управляющего» and does **not** change the ИП
      fact balance yet.
- [ ] The ИП card row «Передано регионалу (подтв.)» stays 0 until confirmation.
- [ ] After a manager confirms, the ИП fact balance **decreases** by exactly the amount, and
      «Передано регионалу (подтв.)» reflects it.
- [ ] Profit, revenue, OFD sales, ООО balance, and bank balances are unchanged; no Expense row is
      created; the transfer is not in any expense list.

## Transfer — RBAC  (GATE)
- [ ] A **regional director cannot** confirm their own received transfer.
- [ ] A manager of a **different club** cannot confirm.
- [ ] An **accountant / owner / GD** cannot confirm (no auto-bypass).
- [ ] Confirming twice (or double-click) applies the reduction **once** (idempotent).
- [ ] A pending transfer can be cancelled by the author or club manager; a **confirmed** one cannot
      (message points to «Приход Иное» for a return).

## Return path
- [ ] A regional returning cash is entered as «Приход Иное» (source «Региональный директор») and
      **increases** the ИП balance; it is not counted as revenue/profit.

## Backdated control balance  (GATE)
- [ ] Set 02.07 = 15 509,92 ₽, then add 01.07 = 0,98 ₽.
- [ ] The 02.07 point is unchanged (amount + date); today's balance is still computed from 02.07.
- [ ] The interval 01.07→02.07 is computed from 0,98 ₽ (historical view).
- [ ] Adding 01.07 did **not** delete the 02.07 point or become the current point.
- [ ] Trying to add a **second** point on 02.07 is refused with the «используйте корректировку»
      message.
- [ ] A **future** date is refused.

## Correction (append-only)  (GATE)
- [ ] «Скорректировать» requires a reason; saving creates a **new version** and keeps the old one in
      the timeline (status «скорректирована»).
- [ ] The balance uses the latest active version for that date.
- [ ] A second correction chains sequentially; there are never two active versions on a date.
- [ ] No control point is ever deleted or its amount/date edited in place.

## Timeline & audit
- [ ] The version timeline shows, per club + legal entity: effective date, amount, coverage interval
      («с 01.07 до 02.07» / «по настоящее время»), version, status, author, reason. Mobile = cards.
- [ ] Audit log has `cash.regional_transfer_created/confirmed/cancelled` and
      `cash.opening_balance_set/corrected`.

## Regression
- [ ] The ИП-cash card «Расходы ИП на проверке» is unchanged (same unconfirmed-cash-expense set).
- [ ] Existing collections/withdrawals/other-income and the fact balance behave as before.
- [ ] Tenant isolation: none of the above leaks or acts across companies/clubs.

**Sign-off:** accepted only when all GATE sections pass on a real instance.
