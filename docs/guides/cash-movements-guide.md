# Cash movements guide (ИП / ООО)

The managerial cash contour tracks the **physical** cash of a club's ИП and ООО as a
**fact balance**, measured from the last applicable control point plus the movements after it.
It is separate from profit/revenue analytics and from the confirmed-only wallet ledger.

## ИП fact-balance formula (`src/lib/cash-balances.ts`)
```
Остаток ИП = контрольный остаток
           + ОФД-наличные ИП после контрольной точки
           + изъятия ООО→ИП (pending|approved)
           + приход «Иное» (pending|approved)
           − подтверждённые (confirmed) передачи региональному директору   ← новое
           − наличные расходы ИП на проверке
           − подтверждённые наличные расходы ИП
```
Only movements dated **strictly after** the control point count (`date > effectiveDate`, by
club-local calendar day). **No other term changed** for this feature.

> The card **«Расходы ИП на проверке»** is unchanged: it still sums only unconfirmed cash ИП
> expenses of the selected club's active ИП after the last applicable control point. It is a
> narrower set than the expenses list and the two are NOT expected to be equal.

## «Передать деньги региональному директору» (new)
Internal movement — the club physically hands ИП cash to a regional director. **NOT** a sale,
revenue, sale, expense, инкассация, или изъятие ООО→ИП.

- **Create** (status `pending_confirmation`): a **club manager** or a **regional director** with
  access to the club. Recipient must be an **eligible active regional director** of the club /
  company (archived users are never offered); the recipient's name is snapshotted so history
  survives later user edits. A per-form `idempotencyKey` blocks duplicate submits.
- **Confirm** (`confirmed`): **only an explicit manager of that club** confirms receipt. A regional
  director cannot self-confirm; a user of another club, an accountant, owner or GD cannot stand in.
  Confirmation is transactional + idempotent (a repeat is a no-op).
- **Cancel** (`cancelled`): the author or a club manager may cancel while `pending_confirmation`.
  A **confirmed** transfer cannot be cancelled — return the money instead (below).
- **Effect on money:** only a **confirmed** transfer reduces the ИП fact balance. `pending_confirmation`
  moves nothing; `cancelled` never counts. It touches no profit, revenue, OFD, or bank balance.

## Returning money from a regional director
Use the existing **«Пополнить ИП — приход "Иное"»** with source **«Региональный директор»**. It
increases the ИП fact balance (pending|approved), is not a sale and not profit revenue, and keeps
its source + comment. **No separate reverse operation** exists — the model already covers it.

## Collections page structure (daily working order)
1. Header + **MonthNav** (history month).
2. **«Фактические деньги» — сверка наличных** (first working block). This is the **daily count** of
   real cash in the till (A) — it is **NOT** a control point (B). A daily reconciliation never
   automatically becomes a control point.
3. **Current ООО / ИП balance cards** («Фактический остаток сейчас»).
4. **Контрольный остаток** (control point B: a new calculation base) + version timeline.
5. **Операции с наличными** split into two columns — **ООО** (Инкассировать ООО, Изъять ООО→ИП) and
   **ИП** (Приход «Иное», Передать регионалу). Mobile stacks ООО then ИП.
6. **Единая история операций** for the selected month, with compact filters (type / entity /
   status / author) and monthly totals.

**A daily reconciliation (fact count) and a control point are different operations** and are never
conflated. **The current balance does not depend on the selected history month** — the cards are
always «Сейчас»; the MonthNav + filters change only the history rows and the monthly totals.

The regional transfer has **no separate history block** — every transfer (pending / confirmed /
cancelled) appears in the **common history** (sign «−» only for confirmed; recipient, author, and
the confirming manager shown). The `CashRegionalTransfer` model, RBAC, confirmation, recipient
snapshot, audit, and balance effect are unchanged.

## Roles (unchanged RBAC)
- Create cash operations (collection/withdrawal/other-income/transfer): club manager or regional
  director with club access.
- Review/approve collection/withdrawal/other-income: accountant / chief_accountant / owner / GD /
  regional.
- Confirm a regional transfer: explicit club manager only.
