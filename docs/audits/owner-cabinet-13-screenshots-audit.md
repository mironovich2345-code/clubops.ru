# Owner Cabinet Acceptance — 13 iPhone Screenshots Audit

**Role:** Собственник (owner). Separate role acceptance — not mixed with manager/accountant cabinets.
**Build:** current deployed build; screenshots supplied and visible (real iPhone, portrait).
**Scope rule:** fix confirmed visual / responsive / functional / RBAC defects only. No changes to
financial formulas, statuses, approvals, tenant isolation, or existing permissions beyond what the
current RBAC model already dictates.

Defect types: **V** visual · **R** responsive · **F** functional · **RBAC**.

---

## 1 — Owner Dashboard
- **Route:** `/dashboard` · **Role/state:** owner, multi-network strategic view.
- **Component:** `dashboard/page.tsx`, `DashboardMonthSelector` (→ shared `MonthNav`), `StrategicScopeFilter`.
- **Defect (R/V):** month selector sat in a `justify-between` flex and did not span width, so the month
  read left-of-centre; scope filter was a wrapping row of tiny inline `label+select` pairs (≈32px),
  eating the first screen.
- **Root cause:** selector not width-constrained on mobile; scope filter used inline labels + small controls.
- **Fix:** wrapped `DashboardMonthSelector` in `w-full sm:w-auto` (both dashboard branches) so `MonthNav`
  centres the month; rebuilt `StrategicScopeFilter` mobile-first (one column, 48px/16px controls, labels
  above, full-width segmented mode switch, scope-summary chips).
- **After:** month centred with 44×44 arrows and the "Текущий месяц" badge on its own line; compact filter.
- **Accepted:** ✅ (static/structural; device pass pending).

## 2 — Owner Analytics
- **Route:** `/analytics` · **Role/state:** owner, all-networks.
- **Component:** `analytics/page.tsx` — «По сетям» table + KPI grid + `StrategicScopeFilter`.
- **Defect (R):** the «По сетям» table lived in an `overflow-hidden` card, so on mobile the right columns
  (Продажи ПТ / Расходы) were clipped with **no** horizontal scroll.
- **Root cause:** `overflow-hidden` container around a `min-w-full` table; no mobile card fallback.
- **Fix:** desktop table now `hidden … lg:block` inside `overflow-x-auto`; added a `lg:hidden` `MobileDataCard`
  list per network (сеть / выручка ОФД / продажи АБ / продажи ПТ / расходы / результат / клубов).
- **After:** every network figure readable on mobile; desktop table unchanged.
- **Accepted:** ✅.

## 3 — Sales plans / import
- **Route:** `/dashboard` → «Управление» → «Планы продаж» + `PlanImportPanel`.
- **Defect (V/R):** `MonthField` and «Показать» overlapped; native `<input type=file>`; «Скачать шаблон»
  small/mis-aligned; «Загрузить планы» arbitrary width.
- **Root cause:** raw `<input type=month>` + cramped `flex gap-2`; raw file input; ad-hoc button widths.
- **Fix:** month form → `MonthField` + full-width primary «Показать» (grid→row); import → `MobileFileField`,
  full-width secondary «Скачать шаблон», full-width primary «Загрузить планы».
- **After:** no overlap; consistent full-width stack on mobile, compact on desktop.
- **Accepted:** ✅.

## 4 — Expenses
- **Route:** `/expenses` · **Role/state:** owner.
- **Component:** `expenses/page.tsx` — scope filter, status chips, expense cards.
- **Defect (R):** status chips row («Требуют исправления / На проверке / Проверенные») scrolled but gave
  no affordance — «Проверенные» clipped at the edge looked broken.
- **Root cause:** horizontal-scroll container with no edge fade; not obviously scrollable.
- **Fix:** kept fixed-size chips (`min-h-[40px] shrink-0`, active doesn't resize) and added a right-edge
  gradient fade (mobile) signalling more statuses. Cards + «Открыть» already full-width. Scope filter now compact.
- **After:** scroll affordance visible; chips stable; cards in bounds.
- **Accepted:** ✅.

## 5 — Document viewer — **CRITICAL**
- **Route:** any finance document (`DocumentLink` → full-screen viewer). Screenshot: multipage PDF «ванягина чеки.PDF».
- **Component:** `components/mobile/DocumentViewer.tsx`.
- **Defect (F):** could not scroll the document down with one finger; the rest was only reachable by
  pinch-zooming out.
- **Root cause:** the scroll body used `overflow-auto` without iOS touch hints, so a drag over the image/PDF
  was captured as a pan/zoom gesture, not a scroll; PDF used `<object>` (unreliable scroll on iOS); no
  body-scroll lock / restore; overlay used `inset-0` (address-bar height issues), not `100dvh`.
- **Fix:** 100dvh overlay; sticky toolbar (`shrink-0`); scroll body `overflow-y-auto overscroll-contain`
  with `-webkit-overflow-scrolling: touch` + `touch-action: pan-y`; image renders full-width in vertical
  flow (tap toggles zoom, not required for nav); PDF via `<iframe>`; iOS-safe body lock
  (`position:fixed` + negative top) that **restores** the exact scroll position on close; Esc closes;
  open/download/close always reachable; `pt-safe`/`pb-safe`.
- **After:** one-finger vertical scroll through the whole document; zoom optional.
- **Accepted:** ⚠️ **structurally fixed — NOT accepted until the real-device viewer scroll test passes**
  (multipage PDF + long image, Safari + PWA standalone, portrait/landscape). See checklist.

## 6 — Mandatory payments (Календарь платежей)
- **Route:** `/payments`.
- **Component:** `payments/page.tsx`.
- **Defect (V/R):** heavy amber warning; custom `‹ ›` month nav; KPI cards not separated from balances.
- **Root cause:** bespoke month nav; single KPI block; trailing balance card half-width on mobile.
- **Fix (prior batch, verified here):** shared `MonthNav`; «Обязательный платёж» primary + «Обновить остаток»
  secondary full-width stack that appears only when a single company is selected (otherwise the explanatory
  notice); KPIs compact; deadlines vs balances split by `SectionLabel`; trailing balance card
  `col-span-2 lg:col-span-1` (full-width on mobile).
- **After:** clear deadline/balance separation; action buttons gated on company selection with explanation.
- **Accepted:** ✅.

## 7 — Budgets
- **Route:** `/budgets`.
- **Component:** `BudgetForms` (limit form), `BudgetImportPanel`, page segmented control.
- **Defect (V/R):** limit form controls not full-width; native file input; «Скачать шаблон» small; «Загрузить
  бюджеты» arbitrary width.
- **Fix:** limit form → single-column full-width (Статья / Лимит / Сохранить cta), 16px card, 12px gaps;
  import → `MobileFileField` + full-width secondary/primary buttons. Segmented (Бюджеты / План-Факт) already
  uses the shared `SegmentedControl`/`segmentClass` (equal segments, neutral surface, accent-soft active);
  overview already has desktop-table + mobile-cards.
- **After:** consistent full-width form + import; compact limit cards preserved.
- **Accepted:** ✅.

## 8 — Payroll overview
- **Route:** `/payroll` · **Component:** `payroll/page.tsx`, `PayrollNav`.
- **Defect (R):** tabs (Обзор/Сотрудники/Схемы/Расчётные…) — «Расчётные» clipped; needed reliable scroll.
- **Fix (prior batch, verified):** `MonthField` + full-width «Показать»; tab strip in a contained
  `overflow-x-auto`, labels `whitespace-nowrap`, active tab auto-centred via `scrollLeft`, `aria-current`;
  page never scrolls sideways. Calculations/data untouched.
- **After:** tabs scroll safely, active tab fully visible; month aligned with controls.
- **Accepted:** ✅.

## 9 — Users list
- **Route:** `/users` · **Component:** `users/page.tsx`.
- **Defect (R):** wide desktop table clipped on mobile (ПОЛЬЗОВАТЕЛЬ / РОЛЬ / ДОСТУ… cut); access info hidden.
- **Root cause:** single `min-w-full` table, no mobile fallback.
- **Fix:** `lg:hidden` `MobileDataCard` list (ФИО / email / роль / доступ / компания / статус + action menu);
  desktop table kept as `hidden … lg:block`; per-user admin block keyed off a precomputed first-row map so
  both renderings match.
- **After:** all access info reachable on mobile; desktop table preserved.
- **Accepted:** ✅.

## 10 — Legal entities / settings
- **Route:** `/settings` → Юридические лица · **Component:** `settings/_components/LegalEntities.tsx`.
- **Defect (V):** a deactivated entity («ИП Мазгалин С.А.») rendered as a light-grey, low-contrast card
  (text nearly unreadable); no dark-theme handling.
- **Root cause:** inactive state used a grey wash (`bg-slate-100/60`); the component had no `dark:` tokens.
- **Fix:** inactive is now a **semantic** state — neutral theme surface + full-contrast text (no opacity wash),
  a clear «Неактивно» badge, and Activate rendered as **primary** (Deactivate secondary); full light/dark tokens.
- **After:** inactive entities fully readable in both themes, next to active ones; WCAG-AA contrast.
- **Accepted:** ✅ (checklist covers inactive company / archived club variants on device).

## 11 — OFD synchronization / import
- **Route:** `/settings/integrations/ofd` · **Component:** `OfdForms` (`OfdImportForm`, `OfdSyncNow`).
- **Defect (R):** on mobile «Дата от» and «Дата до» crowded/overlapped; «Синхронизировать сейчас» not full-width.
- **Fix:** import form → `grid grid-cols-1 gap-3 sm:grid-cols-2 lg:flex`; dates → `DateField`; connection +
  «Импортировать» full-width on mobile; «Синхронизировать сейчас» full-width on mobile. Technical status
  (endpoint / cron) kept but in a compact section (long endpoint wraps; no page overflow).
- **After:** dates stack with a 12px gap on mobile (no overlap), two columns on desktop.
- **Accepted:** ✅.

## 12 — User invitation form — **FUNCTIONAL / RBAC**
- **Route:** `/users` → «Пригласить пользователя» · **Component:** `InviteForm.tsx` (+ `actions.ts`, `lib/invites.ts`).
- **Defect (F/RBAC/V):** the club select could not be used and rendered white in dark theme; label hardcoded
  «Клуб (для менеджера)».
- **Root cause:** `needsClub = role === "manager"` hardcoded; the club `<select>` was `disabled` for every
  other role and its `disabled:bg-slate-50` looked white in dark theme; the form had no dark tokens. (As
  owner you can only invite owner/GD — both company-scoped — so the club field was permanently dead.)
- **RBAC model (confirmed, unchanged):** `isClubScopedRole(role) === (role === "manager")` — **manager** is
  the only club-scoped role (requires exactly one active club); **owner / general_director /
  regional_director / chief_accountant / accountant / marketer** are company-scoped (access to the whole
  company, `clubId = null`). `getInvitableRoles` still governs who may invite whom.
- **Fix:** the form now drives its scope control off `clubScopedRoles` (server-computed from `isClubScopedRole`).
  Club-scoped role → enabled, **required** club select of active clubs (with a reason when there are none);
  company-scoped role → an explicit «Доступ ко всей компании» note (no dead disabled select); no role yet →
  a hint. Theme-aware throughout. Server validation unchanged (`isClubScopedRole` gate).
- **After:** club selectable exactly when the role needs it; company roles show whole-company access; nothing
  renders white in dark theme; invalid scope can't be submitted.
- **Accepted:** ⚠️ **structurally fixed — NOT accepted until the invitation flow is exercised on-device per
  role** (manager / regional / accountant / …, active + archived club). See checklist.

## 13 — Related mobile table/card state
- **Route:** cross-cutting (users, analytics networks, budgets/plan import previews).
- **Defect (R):** wide desktop tables clipped on phones.
- **Fix:** the table→(desktop `lg:block` + mobile `MobileDataCard`) pattern applied to users and analytics
  networks; budgets/plan import preview tables keep their own `overflow-x-auto` container.
- **Accepted:** ✅.

---

### Honest status
Static/structural + typecheck + pilot coverage are green. **Two items remain gated on real-device
acceptance and are NOT marked accepted:** the document-viewer one-finger scroll (§5) and the invitation
flow per role (§12). See `docs/testing/owner-cabinet-iphone-checklist.md`.
