# Owner Cabinet — iPhone Manual Acceptance Checklist

Role: **Собственник (owner)**. Run on a real iPhone (Safari + installed PWA / standalone), portrait
and landscape, in **light and dark** theme. Static/pilot/build checks are already green — this list
covers what only a device can confirm. Do **not** mark "owner cabinet accepted" until the
**document viewer** and **invitation flow** sections both pass.

## Global
- [ ] No horizontal page scroll on any owner page at 320px width.
- [ ] All form controls ≥16px (no iOS input auto-zoom).
- [ ] Light and dark: nothing renders white-on-white or unreadable.

## Dashboard (`/dashboard`)
- [ ] Month is centred; arrows are 44×44; «Текущий месяц» badge sits on its own line and doesn't shove the arrows.
- [ ] Scope filter is one compact column; selecting Город/Компания/Клуб updates the summary chips.
- [ ] Long sums in club cards don't wrap.

## Analytics (`/analytics`)
- [ ] «По сетям» shows one card per network on mobile (no clipped columns); every figure readable.
- [ ] Desktop (rotate / wide) still shows the table.

## Sales plans (`/dashboard` → Управление)
- [ ] `MonthField` and «Показать» never overlap; «Показать» full-width on mobile.
- [ ] Import: «Скачать шаблон» full-width secondary (centred text); file picker is `MobileFileField`
      (single «Выбрать файлы», no camera button for xlsx/csv); «Загрузить планы» full-width primary.

## Expenses (`/expenses`)
- [ ] Status chips scroll horizontally with a visible right-edge fade; active chip doesn't change size.
- [ ] Expense cards stay within screen; «Открыть» full-width.

## Document viewer — **CRITICAL (gate)**
- [ ] Open a **multipage PDF**; scroll from first to last page with **one finger**, no zoom needed.
- [ ] Open a **long image** (tall receipt); scroll to the bottom with one finger.
- [ ] Background page under the overlay does not scroll.
- [ ] Close the viewer → the page is at the **same scroll position** as before opening.
- [ ] open-in-new-tab / download / close buttons all work; top/bottom safe areas respected.
- [ ] Repeat in **Safari** and **installed PWA (standalone)**, **portrait and landscape**.

## Mandatory payments (`/payments`)
- [ ] Shared MonthNav; deadlines KPIs visually separated from balances; trailing balance card full-width.
- [ ] «Обязательный платёж» / «Обновить остаток» appear only with one company selected; otherwise the
      explanation is shown (no dead buttons).

## Budgets (`/budgets`)
- [ ] Limit form: Статья / Лимит / «Сохранить лимит» each full-width, equal heights, 12px gaps.
- [ ] Import: «Скачать шаблон» full-width secondary centred; `MobileFileField`; «Загрузить бюджеты» full-width primary.
- [ ] Segmented (Бюджеты / План-Факт): equal segments, active accent-soft, centred text.

## Payroll (`/payroll`)
- [ ] Month field centred and same height as the «Показать» button; «Показать» full-width.
- [ ] Tabs scroll horizontally; the active tab is fully visible after navigating; page never scrolls sideways.

## Users (`/users`)
- [ ] Mobile: one card per user with ФИО / email / роль / доступ / компания / статус + actions (nothing clipped).
- [ ] Desktop: the full table is present.

## Invitation flow — **GATE (per role)**
For each role the current actor may invite, confirm the scope control behaves and the invite sends:
- [ ] **manager** — club select becomes enabled + required; lists **active** clubs only; submitting without a
      club is blocked; submitting with a club creates a club-scoped invite.
- [ ] **regional_director** — shows «Доступ ко всей компании»; no club select; invite sends company-scoped.
- [ ] **accountant / chief_accountant** — «Доступ ко всей компании»; company-scoped invite sends.
- [ ] **other invitable roles** (general_director / marketer as applicable) — company-scoped note; sends.
- [ ] Dark theme: the club control is **not white**; disabled/among states are readable.
- [ ] Active vs **archived** club: archived clubs do not appear as assignable; active-only.
- [ ] Active vs **inactive company**: behaviour matches scope; no broken control.
- [ ] Server rejects a manager invite with no club and any cross-company/cross-club scope.

## Legal entities / settings (`/settings`)
- [ ] Inactive legal entity: neutral surface, **fully readable** text, «Неактивно» badge, «Активировать»
      as primary — **not** a faded low-contrast card.
- [ ] Check inactive **company**, **archived club**, and active cards beside inactive — all readable, light + dark.

## OFD sync (`/settings/integrations/ofd`)
- [ ] «Дата от» and «Дата до» stack on mobile with a clear gap (no overlap); two columns on desktop.
- [ ] «Синхронизировать сейчас» and «Импортировать» full-width on mobile.
- [ ] Technical status (endpoint / cron) is readable and doesn't cause page overflow.

---
**Sign-off:** owner cabinet is accepted only when every box above is checked, with the two GATE sections
(document viewer, invitation flow) explicitly verified on a real iPhone.
