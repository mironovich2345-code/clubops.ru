# Manual acceptance checklist — Collections operations & control-snapshot polish

Run on a real instance with seeded roles (manager, regional director, accountant) and a club with
active ООО + ИП. Static + pilots + build are green; this covers layout + workflow on live data.

## Layout & order
- [ ] Page order top→bottom: header + MonthNav → «Фактические деньги» (recon) → current ООО/ИП
      balance cards → Контрольный остаток → Операции (ООО | ИП) → История операций.
- [ ] «Фактические деньги» is the first working block (open, not hidden in an accordion).
- [ ] The daily reconciliation is clearly distinct from a control point (labels say so).

## Operations ООО / ИП split
- [ ] Desktop: two equal columns — ООО (Инкассировать ООО, Изъять ООО→ИП) | ИП (Приход «Иное»,
      Передать регионалу).
- [ ] Mobile (320px): one column, ООО then ИП; cards stay within the viewport; controls full-width;
      no horizontal page scroll.

## Regional transfer in the common history
- [ ] There is **no** separate «Передачи региональному директору» block.
- [ ] A transfer appears in the unified history: pending as «Ожидает подтверждения»; confirmed with
      sign «−»; recipient, author, and the confirming manager shown.
- [ ] Confirm/cancel actions still work from the history (manager of the club only for confirm).

## Month switching & filters
- [ ] MonthNav changes the history month; the rows and monthly totals follow the selected month.
- [ ] The **current balance cards do not change** when the history month changes.
- [ ] Filters (type / entity ООО-ИП / status / author) change only the history rows; «Сбросить» clears;
      active-filter chips show.

## Control-point permissions
- [ ] A **manager** can create a control point for **their** club; a manager of another club cannot.
- [ ] A **regional** with access to the club can create one; a regional without club access cannot.
- [ ] An **accountant** of the company can create one; an accountant of **another company** cannot.

## Cancellation (append-only)  (GATE)
- [ ] «Отменить контрольную точку» requires a reason and an explicit confirm.
- [ ] After cancel: the point stays in the timeline marked «отменена» with its reason (not deleted).
- [ ] The balance recalculates from the **previous applicable** active point; **later** points are
      unchanged; the current balance is deterministic.
- [ ] There is **no** «Удалить» button / hard delete anywhere for a control point.

## Preserved rules (regression)
- [ ] Backdated earlier point still only fills the interval before the next point; same-date duplicate
      refused; correction creates a new version with a required reason; superseded rows remain.
- [ ] Confirmed transfer still reduces the ИП balance by exactly the amount; pending/cancelled don't.
- [ ] The ИП card «Расходы ИП на проверке» is unchanged.
- [ ] Tenant isolation: nothing leaks or acts across companies/clubs.

**Sign-off:** accepted when the layout is correct on desktop + mobile, month filtering leaves the
balances current, and the cancellation GATE passes on a real instance.
