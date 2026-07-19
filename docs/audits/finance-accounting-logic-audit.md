# CLUB-OPS — Finance & Accounting Logic Audit

Date: 2026-07-19
Base commit audited: `ef2306e` (main)
Scope: formulas, data sources, page/route wiring, roles, accounting semantics, double-counting, legacy/dead code.
This audit changed **no** business logic except one minimal presentation bug fix (§9); everything else is documentation + verification tests.

## 1. Executive summary

The managerial finance contour is coherent and OFD-driven:

- **Revenue** comes only from OFD aggregates (`OfdDailySalesSummary`, `OfdRevenueCategoryDailySummary`). Manual sales (`SalesReport`, `Sale`) are retired — used only as a silent fallback when OFD has no data.
- **Cash ООО/ИП** comes from one source of truth (`loadClubCashBalances` → `calculateCashBalances`), separate from profit and from the retired `CashWallet/CashMovement` ledger.
- **Expenses / result / obligations** follow one consistent definition across Dashboard, Analytics and the cash pages.
- **Cash operations** (инкассация, изъятие, приход «Иное») correctly move cash but never touch revenue or profit.

Two items require a **business decision** (not code bugs): (a) a potential **double-count of returns** if a refund is recorded both as an OFD fiscal return and as a manual `Refund`, and (b) two pages (`/balances` and `/collections`) writing the same `BalanceSnapshot` baseline. One clear **bug was fixed**: the Analytics "Финансовый итог" card showed profit/cash from the retired `SalesReport` source.

**Final verdict: PASS WITH RISKS.**

## 2. Data source map

| Показатель | Источник | Где используется | Формула | Статусы | Роли |
|---|---|---|---|---|---|
| ОФД выручка (gross/income) | `OfdDailySalesSummary.incomeTotalKopeks` | Dashboard, Analytics, /analytics/ofd-sales | Σ income | — (фискальные, импорт) | owner/GD/regional (`ofd_sales`) |
| ОФД наличные | `OfdDailySalesSummary.incomeCashKopeks` | ofd-sales, cash-balances | Σ cash | — | owner/GD/regional |
| ОФД безнал | `OfdDailySalesSummary.incomeElectronicKopeks` | ofd-sales | Σ electronic | — | owner/GD/regional |
| ОФД возвраты | `OfdDailySalesSummary.returnTotalKopeks` | ofd-sales, net | Σ return | — | owner/GD/regional |
| ОФД net | `OfdDailySalesSummary.netTotalKopeks` | Analytics/Dashboard result | income − returns (`importer.ts:332`) | — | owner/GD/regional |
| Чеки | `OfdDailySalesSummary.receiptCount` | ofd-sales, weekday | Σ receipts | — | owner/GD/regional |
| Абонементы | `OfdRevenueCategoryDailySummary` `membership` | Dashboard/Analytics | Σ incomeTotal (code=membership) | — | owner/GD/regional |
| Персональные | `…` `personal_training` | Dashboard/Analytics | Σ (code=personal_training) | — | owner/GD/regional |
| Групповые | `…` `group_training` | Analytics/ofd-sales | Σ (code=group_training) | — | owner/GD/regional |
| Доп. услуги | `…` `extra_services` | Analytics/ofd-sales | Σ (code=extra_services) | — | owner/GD/regional |
| Иное | `…` `other` | Analytics/ofd-sales | Σ (code=other) | — | owner/GD/regional |
| Расходы ИП наличные | `Expense` (cash, ИП, entryVersion 2) | /expenses, cash-balances | Σ | pending → cash; verified/confirmed → profit | financials + manager (own cash) |
| Фактические расходы | `Expense` + `Invoice` + `Refund` | Dashboard/Analytics/budget | Σ spendEvents | Expense `confirmed`/`verified`; Invoice `paid`; Refund `paid` | financials |
| Счета | `Invoice` | /invoices, expenses, obligations | paid→expense; approved-unpaid→obligation | paid / approved_by_* / draft/rejected | owner/GD/regional/accountant |
| Возвраты | `Refund` | /refunds, expenses, obligations | paid→expense; approved-unpaid→obligation | paid / approved_by_* | owner/GD/regional/accountant |
| Долги/обязательства | `Invoice`+`Refund` approved-unpaid | Analytics, dashboard debt | Σ (status ∈ APPROVED_UNPAID) | approved_by_regional/chief_accountant/owner | financials |
| Наличные ООО | `loadClubCashBalances.cashOooFactBalance` | Dashboard, /collections, /expenses, Analytics | see §7 | pending/approved count | owner/GD/regional/manager (`collections`) |
| Наличные ИП | `loadClubCashBalances.cashIpFactBalance` | Dashboard, /collections, /expenses, Analytics | see §7 | pending/approved/verified/confirmed | owner/GD/regional/manager |
| Контрольный остаток | `BalanceSnapshot` (latest per club+entity) | cash-balances baseline | last snapshot | — | manager/regional/owner/GD/accountant |
| Инкассация | `CashCollection` | /collections, cash ООО | − ООО (pending/approved) | draft/pending/approved/rejected/cancelled | manager/regional create; accountant/CA/owner/GD review |
| Изъятие ООО→ИП | `CashWithdrawal` | /collections, cash | − ООО, + ИП (pending/approved) | same machine | manager/regional; regional/accountant review |
| Приход «Иное» | `CashOtherIncome` | /collections, cash ИП | + ИП (pending/approved) | same machine | manager/regional |
| Управленческий результат | pure `computeManagementResult` | Dashboard, Analytics | ofdNet − confirmedCosts | — | owner/GD/regional |
| Прогноз месяца | pure `buildMonthlyForecast` | Analytics | factToDate/elapsed×daysInMonth | — | financials |
| Выполнение плана | `buildMonthlyForecast` | Analytics | fact/plan; «План не задан» если 0 | план из `SalesPlan` | financials |
| Риск плана | `buildMonthlyForecast` | Analytics | от прогноза; «none» без плана | — | financials |
| Дни недели | `OfdDailySalesSummary` grouped by weekday | Analytics | Σ revenue/receipts, avg/day | — | owner/GD/regional |

## 3. Formula map (verified)

- **ОФД net** = `incomeTotalKopeks − returnTotalKopeks`, computed once at import (`src/lib/ofd/importer.ts:332`) and stored as `netTotalKopeks`. `buildOfdManagementOverview` sums income, returns and net independently — consistent (net === Σincome − Σreturns).
- **Categories** = Σ `OfdRevenueCategoryDailySummary.incomeTotalKopeks` grouped by `categoryCode` ∈ {`membership`, `personal_training`, `group_training`, `extra_services`, `other`}. (Note: the code uses `extra_services`, not `additional_services`; label = «Доп. услуги».)
- **Confirmed costs** = confirmed/verified `Expense` + paid `Invoice` + paid `Refund` (`analytics.ts` `spendEvents`, `EXPENSE_REALIZED_STATUSES=["confirmed","verified"]`).
- **Management result** = `ofdNet − confirmedCosts` (`ofd-management.ts` `computeManagementResult`), identical on Dashboard and Analytics.
- **Obligations/debt** = Σ `Invoice`+`Refund` with status ∈ `APPROVED_UNPAID_STATUSES=["approved_by_regional","approved_by_chief_accountant","approved_by_owner"]` — never paid (already in costs), never draft/rejected.
- **Forecast**: `averagePerDay = fact/elapsedDays`; `projected = fact + averagePerDay×remainingAfterToday`; `completion = fact/plan`; `needPerDay = max(0, plan−fact)/daysLeft`; no plan → «План не задан»; no elapsed → «Недостаточно данных». Fact = OFD gross income when OFD has data.
- **Cash ООО** = last ООО `BalanceSnapshot` + OFD cash ООО after checkpoint − collections(pending|approved) − withdrawals(pending|approved).
- **Cash ИП** = last ИП `BalanceSnapshot` + OFD cash ИП after checkpoint + withdrawals(pending|approved) + «Иное»(pending|approved) − ИП expenses(pending + verified/confirmed). draft/rejected/cancelled never counted; approval never double-moves.

These formulas are shared (one implementation each) across Dashboard, Analytics, /collections and /expenses — no divergent copies.

## 4. Page / route map

| Route | Page key | Class | Purpose | Notes |
|---|---|---|---|---|
| /dashboard | dashboard | **A active** | Ключевые цифры (АБ/ПТ/расходы/результат/наличные) | OFD + cash; no SalesReport for display |
| /analytics | analytics | **A** | Управленческая аналитика | OFD-driven; SalesReport only as fallback |
| /analytics/ofd-sales | ofd_sales | **A** | Сверка чеков ОФД | не главный экран; owner/GD/regional |
| /analytics/expenses | analytics | **A** | Детализация расходов по статьям | read-only |
| /sales | sales | **B legacy read-only** | Архив старых сменных отчётов | нет в навигации; форма отключена, createSalesReport disabled |
| /expenses | expenses | **A** | Наличные расходы ИП + факт-остаток ИП | `loadClubCashBalances`, не wallet-ledger |
| /expenses/cash | expenses | **B legacy read-only** | Указатель на /collections | «Касса ИП» ретайрнута; только факт-остаток |
| /collections | collections | **A** | Инкассация/изъятия/приход/контрольный остаток | source of truth для cash |
| /invoices | invoices | **A** | Счета | |
| /refunds | refunds | **A** | Возвраты | |
| /balances | balances | **B legacy / risk** | Ручные снапшоты остатка | нет в навигации; пишет тот же `BalanceSnapshot`, что и /collections — см. §10 риск |
| /payments | payments | **A** | Календарь платежей, кассовые разрывы | |
| /mandatory-payments | mandatory_payments | **A** | Обязательные платежи | нет в навигации (внутри календаря) |
| /budgets | budgets | **A** | Бюджеты/лимиты | |
| /workspace | workspace | **A** | Рабочий стол бухгалтера | accountant/CA |
| /settings/integrations/ofd | (role-gated) | **A** | Настройка Такском | owner/GD only |

## 5. Role / access matrix

| Роль | Финансовые карточки | ОФД mgmt (`ofd_sales`) | Dashboard/Analytics | Наличные (`collections`) |
|---|---|---|---|---|
| owner | всё | да | да | да |
| general_director | всё управленческое | да | да | да |
| regional_director | да, по `allowedClubIds` | да | да | да |
| manager | нет прибыли/аналитики; только свой клуб | нет | page-access есть, но без financials/ОФД → только наличные ключевые карточки | да (свой клуб) |
| accountant | нет управленческого результата | нет | нет (workspace) | да |
| chief_accountant | как accountant | нет | нет (workspace) | да |
| marketer | нет | нет | dashboard/analytics открыты, но `financials`/`canSeeCash`/`canSeeOfdSales` = false → финансовых сумм нет | нет |

Enforcement is server-side: `requirePageAccess` on every page; write actions check `ctx.allowedClubIds.includes(clubId)` (e.g. `collections/actions.ts:33`) so a spoofed `clubId` in FormData cannot escape scope; review/cancel queries also filter `clubId: { in: g.clubIds }`.

## 6. Accounting workflow checks

- **A. ОФД-продажа** → daily + category summary → Dashboard/Analytics; enters cash only if cash-tender and after the checkpoint; creates NO Expense/Refund/manual Sale (OFD importer writes only OFD/sync tables). ✔
- **B. ОФД-возврат** → reduces `netTotalKopeks`. See §7 risk on paid-refund overlap. ✔ (net) / ⚠ (overlap)
- **C. Счёт** — draft/needs_review not an expense; approved-unpaid = obligation; paid = expense; dated by accounting month (`invoiceAnalyticsDate`). ✔
- **D. Расход** — draft no effect; pending affects cash fact but NOT profit; verified/confirmed affects profit; rejected/cancelled reverses. ✔
- **E. Инкассация** — pending/approved reduce ООО cash; profit unchanged; not an expense. ✔
- **F. Изъятие** — pending/approved reduce ООО + increase ИП; profit unchanged; not revenue. ✔
- **G. Приход «Иное»** — pending/approved increase ИП; revenue/profit unchanged. ✔
- **H. Контрольный остаток** — rebases cash; movements before the checkpoint excluded. ✔

## 7. Double-counting checks

| Пара | Дважды? | Вывод |
|---|---|---|
| ОФД cash как выручка И как остаток | Разные измерения (P&L vs касса), не суммируются | OK |
| Инкассация как −cash И как расход | Не расход — только −cash | OK |
| Изъятие как −ООО/+ИП И как доход | Не доход | OK |
| Приход «Иное» как +cash И как доход | Не доход | OK |
| Счёт как invoice И как expense | Один и тот же invoice — одна запись в spend | OK |
| Расход как Expense И как invoice | Разные модели, не задваиваются | OK |
| SalesReport в текущей выручке | Только fallback при отсутствии ОФД | OK |
| **ОФД возврат И paid Refund** | **Возможен** — см. риск | ⚠ RISK |

**Returns double-counting (critical):** `ofdNet` subtracts OFD returns (`returnTotalKopeks`); `confirmedCosts` separately includes paid `Refund` rows (category `refunds`). There is **no code linkage or dedup** between a `Refund` row and an OFD return receipt (the OFD importer never creates `Refund`/`Expense`; `Refund` has no fiscal field; refunds are created only via the manual `/refunds` flow). Therefore `result = ofdNet − confirmedCosts` subtracts a refund twice **iff the same economic refund is recorded both as a fiscal return receipt and as a manual paid `Refund`**. Whether that co-occurs is a **business-process** question — see §10.

## 8. Legacy / dead code inventory

| Артефакт | Класс | Используется? |
|---|---|---|
| `src/lib/cash-wallets.ts` (CashWallet/CashMovement ledger) | **B legacy (still written)** | `recordExpenseMovement` вызывается живым `/expenses/simple` verify (`simplified-actions.ts:293`) — пишет `CashMovement`, но нигде не отображается |
| `src/app/(app)/expenses/cash/CashPanel.tsx` | **C dead** | не импортируется/не рендерится нигде |
| `src/app/(app)/expenses/cash-actions.ts` (4 actions) | **C dead** | импортируются только мёртвым CashPanel |
| `src/lib/club-cash-cards.ts` `getClubCashCards` | **C dead** | нет вызывающих |
| `src/app/(app)/sales/_components/SalesReportForm.tsx` | **C dead** | не импортируется; createSalesReport отключён |
| `src/app/(app)/sales/*` (архив отчётов) | **B legacy read-only** | доступен по URL, нет в навигации |
| `src/app/(app)/expenses/cash/page.tsx` | **B legacy read-only** | указатель на /collections |
| `/balances` | **E требует решения** | активна, но дублирует контрольный остаток /collections |

None removed in this audit (task: не удалять крупный дед-код). No **class D (dangerous)** legacy found — the manual-sales creation path is already server-disabled; the dead CashWallet UI is unreachable.

## 9. Bugs found and fixed

**BUG-1 (fixed): Analytics «Финансовый итог» показывал прибыль/наличные из ретайрнутого `SalesReport`.**
- `FinancialSummaryCard` получал `profit={s.profitKopeks}` (report-based: confirmed `Sale`+`SalesReport` − spend → ~отрицательный/ноль после отключения ручных продаж), `oooKopeks={s.cashOooRemainingKopeks}` (из строк `SalesReport`, тоже ретайрнут), а «Наличные ИП» = плейсхолдер «скоро».
- Fix (minimal, `src/app/(app)/analytics/page.tsx`): при `useOfd` показывать управленческий результат `ofdNet − confirmedCosts` (та же `computeManagementResult`, уже используемая на странице) с лейблом «Результат (ОФД − расходы)»; «Наличные ООО/ИП» — фактический остаток из `loadClubCashBalances` (`loadScopeCashFactTotals`), а не из `SalesReport`. Без `useOfd` (нет ОФД / роль без доступа) поведение прежнее.
- Covered by tests `AUDIT-BUGFIX1`, `AUDIT-PAGE6`.

## 10. Risks requiring business decision

- **RISK-1 — Returns double-count.** If a refund can be both a fiscal return (OFD `returnTotalKopeks`) and a manual paid `Refund`, the management result subtracts it twice. Decision needed: (a) OFD returns and manual refunds are always distinct money (no action) → current formula correct; or (b) they can overlap → need a dedup/exclusion rule (e.g. exclude fiscal-origin refunds from `confirmedCosts`, or tag refunds that were issued through the till). **Not changed silently.** Test `AUDIT-DOUBLECOUNT1` documents the current, un-deduplicated behavior.
- **RISK-2 — `/balances` vs `/collections` share one `BalanceSnapshot` baseline.** Both `createBalanceSnapshot` (/balances) and `setCashOpeningBalance` (/collections) write `BalanceSnapshot`; the fact-balance engine takes the latest by (snapshotDate desc, createdAt desc). A snapshot entered on either page silently rebases the other's baseline. Decision: retire `/balances` (route already out of the sidebar), or keep both with clear guidance. **Not changed** (no proven bug; `/balances` is a legitimate, role-gated register).
- **OBSERVATION — `Refund.status` inline comment** omits `approved_by_chief_accountant`, although that status is included in `APPROVED_UNPAID_STATUSES`. Doc-only; no behavior impact.
- **OBSERVATION — Analytics «Динамика продаж» chart** uses `report.salesSplitTrend` (SalesReport-derived) and renders an empty trend when OFD-only. Migrating it to an OFD daily split-trend is a follow-up feature (out of this audit's minimal-change scope). Documented; not changed.
- **OBSERVATION — Vestigial `CashMovement` writes.** `/expenses/simple` still writes the confirmed-only ledger via `recordExpenseMovement`, though nothing renders it. Harmless to displayed numbers; candidate for later removal.

## 11. Tests added

`AUDIT-FORMULA1..10`, `AUDIT-DOUBLECOUNT1`, `AUDIT-PAGE1..6`, `AUDIT-ROLE1..4`, `AUDIT-SCOPE1`, `AUDIT-NAV1`, `AUDIT-SECURITY1`, `AUDIT-LEGACY1`, `AUDIT-BUGFIX1` — in `scripts/pilot-ofd-taxcom.mjs` (pure invariants + static-source guards). See test names for exact assertions.

## 12. Final verdict

**PASS WITH RISKS.** No critical accounting violation blocks further development. Managerial revenue is OFD-only; cash, expenses, result and obligations use single consistent formulas; cash operations never distort profit; manual sales are disabled and out of the UI. Outstanding items are two **business decisions** (returns double-count RISK-1, balances-snapshot overlap RISK-2) and inert legacy code — none of which mis-state currently-displayed numbers after the §9 fix.
