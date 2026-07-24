# Payroll (ФОТ) module — приёмочный отчёт

Дата: 2026-07-24 · ветка `main` (последний payroll-коммит `4a30da7`).
Метод: инспекция фактического кода + прогон `npm run pilot:full` (2604/0, 39 наборов).
**Важно:** зелёные unit/integration-тесты — это НЕ доказательство готовности сквозных
сценариев. Ниже прямо отмечено, что реализовано в UI/action, а что существует только как
чистая функция движка или требует ручного шага. Живой прогон A–G против БД и браузерный
smoke-test в этой среде **не выполнялись** (нет сессии/auth-контекста и браузера) — см. §5, §8.

---

## 0. Итоговый вердикт (кратко)

**READY WITH LIMITATIONS.**

Полностью работают через UI+actions: настройка сотрудников/схем, расчётные периоды,
согласование, корректировки после утверждения, авансы и выплаты (нал/безнал) с единым
списанием кассы, долги и их адресное погашение/списание, сводка ФОТ, уведомления, журнал.
Существенные ограничения, из-за которых часть спецификации нельзя пройти сквозным путём:

1. **Тренер тренажёрного зала §4.2 (пакеты 40/50 %) и «кредит тренера» не подключены к
   расчёту периода** — функции `calcGymTrainer`/`calcGymPackage`/`calcTrainerCredit`
   реализованы и покрыты unit-тестами, но `computeScheme` их не вызывает и в UI нет ввода
   пакетов/проведённых занятий. **Сценарий D сквозным путём недостижим** (только арифметика).
2. **Выплата зарплаты создаёт только движение кассы (`CashMovement`), но не создаёт
   `Expense{category:"salary"}`** — начисленная зарплата не попадает в расходный/P&L контур
   как строка расхода. Это нужно подтвердить бизнесом.
3. **Авансы и выплаты доступны только после утверждения периода** — аванс «в середине
   месяца до расчёта» невозможен.
4. **Безналичная выплата не даёт выбрать юрлицо (ООО vs ИП) по каждому платежу** — берётся
   юрлицо сотрудника по умолчанию. Сценарий F поддержан частично.
5. **Зарплата регионала по нескольким клубам** ведётся как независимые расчёты на клуб;
   разбивку между клубами оператор делает вручную, авто-защиты от двойного учёта нет.
   Сценарий E поддержан частично/вручную.

Ни одно ограничение не блокирует пилот на «менеджерских» ролях и план-факте, но пилот по
тренерам ТЗ и по регионалу нужно проводить с оговорками.

---

## 1. Пользовательский путь по ролям

Все страницы — под `/payroll` (AppPage `payroll`, зарегистрирована в
`src/lib/auth.ts` + `src/lib/navigation.ts`). Видимость: owner, general_director,
regional_director, manager, accountant, chief_accountant (маркетологу закрыто).
Каждый action резолвит `getCurrentAccessContext()` + клубный скоуп (`getUserClubs` +
`canAccessClub`) + capability, проверяет закрытие месяца и пишет `recordAudit`.

### Управляющий (manager)
- **URL:** `/payroll`, `/payroll/employees/[id]`, `/payroll/periods`,
  `/payroll/periods/[id]`, `/payroll/obligations`, `/payroll/summary`.
- **Действия:** правит платёжный профиль сотрудника, закрепляет за клубами; создаёт период
  и формирует расчёты; вводит данные расчёта; отправляет период на согласование; вносит
  премии/штрафы (до утверждения); проводит **наличные** авансы/выплаты из кассы клуба;
  отмечает частично/полностью выплачено; погашает долги.
- **Ограничения:** **не** настраивает схемы оплаты; **не** согласовывает/утверждает; после
  утверждения корректировки недоступны; безнал недоступен; только свой клуб.
- **Server actions:** `updatePayrollProfile`, `saveClubAssignment`,
  `removeClubAssignment`, `createPayrollPeriod`, `generateCalculations`,
  `saveCalculationInputs`, `transitionPeriod("submit"/"mark_partially_paid"/"mark_paid")`,
  `addAdjustment`/`cancelAdjustment` (до утверждения), `recordPayment`/`cancelPayment`
  (cash), `recordAdvance`/`cancelAdvance` (cash), `settleObligation`.

### Регионал (regional_director)
- **URL:** те же.
- **Действия:** всё, что управляющий, плюс **настройка схем оплаты** (`savePayScheme`),
  **согласование** периода и **возврат на исправление**; наличные из **своего**
  regional-кошелька; закрытие месяца.
- **Ограничения:** не относится к бухгалтерскому этапу утверждения (accounting_approve);
  списание долга недоступно; скоуп — его клубы.
- **Server actions:** `savePayScheme`, `transitionPeriod("start_regional_review"/
  "regional_approve"/"return_for_correction"/"close")`, платежи/авансы (cash),
  `settleObligation`.

### Бухгалтер (accountant / chief_accountant)
- **URL:** те же (лендинг accountant — `/workspace`, но `/payroll/*` доступны).
- **Действия:** проверка/утверждение бухгалтерского этапа (`accounting_approve`),
  возврат на исправление; **корректировки после утверждения** (только бухгалтерия);
  **безналичные** выплаты/авансы; закрытие месяца; погашение долгов; **списание долга —
  только chief_accountant**; настройка схем — только chief_accountant.
- **Ограничения:** наличные из клубной кассы проводит управляющий/регионал, не бухгалтер
  (роль-гейт в `recordPayment`); обычный accountant не списывает долги и не задаёт схемы.
- **Server actions:** `transitionPeriod("start_accounting_review"/"accounting_approve"/
  "return_for_correction"/"close")`, `addAdjustment` (после утверждения),
  `recordPayment`/`recordAdvance` (bank), `settleObligation`, `writeOffObligation` (CA),
  `savePayScheme` (CA).

### Собственник (owner) / general_director
- **URL:** `/payroll`, `/payroll/employees/[id]` (просмотр), `/payroll/periods` (просмотр),
  `/payroll/obligations`, **`/payroll/summary` (агрегаты ФОТ по всем клубам)**.
- **Действия:** схемы оплаты (owner/GD входят в `canManagePaySchemes`); **списание долга**
  (owner входит в `canWriteOffObligation`); просмотр сводки по всем клубам компании.
- **Ограничения:** owner/GD **не** в операционном бэнде (`canManagePayrollAssignments`) —
  не формируют расчёты, не проводят выплаты, не согласовывают этапы. Роль стратегическая.
- **Server actions:** `savePayScheme`, `writeOffObligation`; чтение `/payroll/summary`.

---

## 2. Новые/изменённые файлы по коммитам

**S1 `5e897f4`** — docs/audits/payroll-module-audit.md, docs/testing/payroll-pilot-scenarios.md,
package.json, prisma/migrations/20260723201402_add_payroll_module/migration.sql,
prisma/production/migrations/20260723201402_add_payroll_module/migration.sql,
prisma/schema.prisma, prisma/production/schema.prisma, scripts/pilot-full.mjs,
scripts/pilot-payroll.mjs, src/lib/payroll/{calc,enums,period,scheme}.ts.

**S2 `0534d06`** — package.json, scripts/pilot-full.mjs, scripts/pilot-payroll-setup.mjs,
src/app/(app)/payroll/_components/{AssignmentForm,PaySchemeForm,PayrollProfileForm,
RemoveAssignmentButton}.tsx, src/app/(app)/payroll/actions.ts,
src/app/(app)/payroll/employees/[id]/page.tsx, src/app/(app)/payroll/page.tsx,
src/lib/auth.ts, src/lib/navigation.ts, src/lib/payroll/{access,assignments,schemes}.ts.

**S3 `9cdd1f5`** — package.json, scripts/pilot-full.mjs, scripts/pilot-payroll-periods.mjs,
src/app/(app)/payroll/_components/{CalculationCard,CreatePeriodForm,GeneratePeriodButton}.tsx,
src/app/(app)/payroll/page.tsx, src/app/(app)/payroll/periods/[id]/page.tsx,
src/app/(app)/payroll/periods/{actions.ts,page.tsx}, src/lib/payroll/{compute,periods}.ts.

**S4 `5d5c06f`** — package.json, scripts/pilot-full.mjs, scripts/pilot-payroll-workflow.mjs,
src/app/(app)/payroll/_components/{AdjustmentsSection,CalculationCard,PeriodWorkflowBar}.tsx,
src/app/(app)/payroll/periods/[id]/page.tsx, src/app/(app)/payroll/periods/actions.ts,
src/lib/payroll/{access,aggregate}.ts.

**S5 `52f5188`** — package.json, scripts/pilot-full.mjs, scripts/pilot-payroll-payments.mjs,
scripts/pilot-payroll-workflow.mjs, src/app/(app)/payroll/_components/PaymentsSection.tsx,
src/app/(app)/payroll/periods/[id]/page.tsx, src/app/(app)/payroll/periods/actions.ts,
src/lib/payroll/{aggregate,payments}.ts.

**S6 `2e8e378`** — package.json, scripts/pilot-full.mjs, scripts/pilot-payroll-obligations.mjs,
src/app/(app)/payroll/_components/ObligationRow.tsx,
src/app/(app)/payroll/employees/[id]/page.tsx,
src/app/(app)/payroll/obligations/{actions.ts,page.tsx}, src/app/(app)/payroll/page.tsx,
src/app/(app)/payroll/periods/actions.ts, src/lib/payroll/{obligations,payments}.ts.

**S7 `7bea8cc`** — package.json, scripts/pilot-full.mjs, scripts/pilot-payroll-surface.mjs,
src/app/(app)/payroll/page.tsx, src/app/(app)/payroll/periods/actions.ts,
src/app/(app)/payroll/summary/page.tsx, src/lib/activity.ts,
src/lib/notifications/{events,outbox,telegram}.ts.

**S8 `4a30da7`** — docs/audits/payroll-module-final-report.md, docs/testing/payroll-pilot-scenarios.md,
package.json, scripts/pilot-full.mjs, scripts/pilot-payroll-integration.mjs,
scripts/pilot-payroll-periods.mjs, src/app/(app)/payroll/periods/[id]/page.tsx,
src/app/(app)/payroll/periods/actions.ts, src/lib/payroll/sales-bases.ts.

---

## 3. Prisma-модели и связи

**Дизайн-факт (проверено):** все 8 зарплатных моделей используют **скалярные id БЕЗ Prisma
`@relation`** (в моделях 0 `@relation`). Это осознанный выбор для чисто аддитивной миграции
(как `AuditLog`/`RateLimitBucket`): владение и связи проверяются в серверном коде, а не FK.
`ClubEmployee` получил 4 nullable-колонки и НЕ имеет обратных payroll-связей.

Связи (логические, по id):
- **ClubEmployee** ← `employeeId` в EmployeeClubAssignment/EmployeePayScheme/
  PayrollCalculation/PayrollAdjustment/PayrollAdvance/PayrollPayment/
  EmployeeFinancialObligation; сам ClubEmployee: `hireDate, preferredPaymentMethod,
  isOfficial, defaultLegalEntityId`.
- **Club** ← `clubId` (скаляр) во всех таблицах; PayrollPeriod уникален `@@unique([clubId,
  year, month])`.
- **Company** ← `companyId` (скаляр) во всех таблицах.
- **LegalEntity** ← `PayrollCalculation.legalEntityId`, `PayrollPayment.legalEntityId`,
  `ClubEmployee.defaultLegalEntityId` (скаляры). Наличная касса резолвит **активное ИП
  клуба** через `resolveActiveIpForClub`.
- **CashMovement** ← `PayrollPayment.cashMovementId` (проставляется после списания);
  авансы/реверсы связаны через `CashMovement.sourceType/sourceId`
  (`payroll_advance`/`payroll_payment`/`…_reversal`), уникальность `@@unique[sourceType,
  sourceId]` в CashMovement гарантирует однократность.
- **Банковские операции:** `PayrollPayment.bankTransactionId` (скаляр, сейчас всегда null —
  подтверждение вручную; интеграции с банком нет).
- **Activity log:** связи нет; каждый action пишет `recordAudit` → `AuditLog`
  (`action`, `entityType`, `entityId`). Ярлыки — в `src/lib/activity.ts`.

Полные определения моделей — см. `prisma/schema.prisma` (dev) и `prisma/production/schema.prisma`
(prod). Ключевые поля денежного контура в `PayrollCalculation`: `automaticAmountKopeks,
bonusesKopeks, deductionsKopeks, advancesKopeks, grossAccruedKopeks, netPayableKopeks,
paidKopeks, remainingKopeks, employeeDebtKopeks, companyDebtKopeks`, снапшот схемы
`schemeSnapshotJson`, расшифровка `detailsJson`.

---

## 4. Таблица переходов статусов PayrollPeriod

Источник: `src/lib/payroll/period.ts` (RULES) + бизнес-гварды в
`transitionPeriod` (`src/app/(app)/payroll/periods/actions.ts`).

| Исходный статус | Действие | Новый статус | Роли | Блокирующие проверки |
|---|---|---|---|---|
| draft, needs_correction | submit | manager_submitted | manager | легальность перехода + роль |
| manager_submitted | start_regional_review | regional_review | regional_director | — |
| manager_submitted, regional_review | regional_approve | regional_approved | regional_director | **есть draft-расчёты → блок** |
| manager_submitted, regional_review, accounting_review | return_for_correction | needs_correction | regional_director, accountant, chief_accountant | — |
| regional_approved | start_accounting_review | accounting_review | accountant, chief_accountant | — |
| regional_approved, accounting_review | accounting_approve | approved | accountant, chief_accountant | **есть draft-расчёты → блок**; при переходе все `calculated`-расчёты → `approved` (лок) |
| approved, partially_paid | mark_partially_paid | partially_paid | manager, regional_director, accountant, chief_accountant | — |
| approved, partially_paid | mark_paid | paid | manager, regional_director, accountant, chief_accountant | — |
| paid, partially_paid | close | closed | regional_director, accountant, chief_accountant | **есть выплаты в статусе pending → блок**; при закрытии из каждого остатка создаётся обязательство, расчёты → `closed` |

Любой переход отклоняется, если статус-источник или роль не совпали (`applyPayrollAction`).
После `approved` прямое редактирование расчёта заблокировано (`isPayrollPeriodLocked` в
`saveCalculationInputs`); закрытый период иммутабелен.

---

## 5. Сквозные сценарии A–G

**Способ проверки (честно):** в этой среде нет сессии/auth-контекста для вызова server
actions и нет БД-раннера для драйва UI, поэтому сценарии **прослежены по фактическому коду**
(какой action → какие записи БД → как считает `aggregateCalculation`/кошелёк) и сопоставлены
с чистыми unit-тестами, доказывающими арифметику. **Живой прогон против БД и через UI — это и
есть ручной пилот; он не заменён этим отчётом.**

### A. Аванс — ✅ достижим (после утверждения периода)
- **Начальные данные:** сотрудник, схема даёт начисление 50 000 ₽; период утверждён.
- **Действия:** `recordAdvance(cash, 10 000)` → `recordPayment(cash, 40 000)`.
- **Записи БД:** 1× `PayrollAdvance{status:paid, amountKopeks:1000000}`;
  1× `PayrollPayment{cash, confirmed, 4000000}`; 2× `CashMovement` (outflow 10 000 с
  `sourceType:"payroll_advance"`, outflow 40 000 с `sourceType:"payroll_payment"`).
- **Касса:** кошелёк клуба −10 000, затем −40 000 = −50 000. Каждое движение один раз
  (идемпотентность по `@@unique[sourceType,sourceId]`).
- **Итог:** `recomputeCalculationTotals` → paid = advance(10 000) + payments(40 000) =
  50 000; remaining = 0. **Расход НЕ 60 000** — аванс входит в paid и не дублируется.
- **Тесты:** PAYP4, PAYP7, PAYP8, PAYP9 (`pilot-payroll-payments`), PAY39 (`pilot-payroll`).

### B. Частичная зарплата — ✅ достижим
- **Начальные данные:** начислено 100 000; период утверждён.
- **Действия:** `recordPayment(cash, 30 000)`; `recordPayment(bank, 40 000)`;
  `mark_partially_paid`; `close`.
- **Записи БД:** 2× `PayrollPayment` (cash 30 000 + bank 40 000, оба confirmed);
  1× `CashMovement` outflow 30 000 (безнал кассу НЕ трогает); при закрытии
  1× `EmployeeFinancialObligation{company_owes_employee, 30 000, open}`.
- **Касса:** −30 000 (только наличная часть).
- **Итог:** paid = 70 000; remaining = 30 000 → после закрытия долг компании 30 000.
- **Тесты:** PAYP5, S37 (`pilot-payroll-payments`), OBL1, S44 (`pilot-payroll-obligations`),
  PER13 (`pilot-payroll-periods`).

### C. Переплата — ✅ достижим (долг возникает при закрытии)
- **Начальные данные:** начислено 100 000; период утверждён.
- **Действия:** `recordPayment(cash, 110 000)`; `mark_paid`; `close` (→ долг сотрудника
  10 000); `settleObligation(cash, 4 000)`; `settleObligation(cash, 6 000)`.
- **Записи БД:** 1× `PayrollPayment` 110 000; 1× `CashMovement` outflow 110 000; при
  закрытии 1× `EmployeeFinancialObligation{employee_owes_company, orig 10 000}`; 2×
  `CashMovement` **inflow** (4 000, 6 000, `sourceType:"payroll_obligation_in"`).
- **Касса:** −110 000, затем +4 000, +6 000 → нетто −100 000. Каждый inflow один раз.
- **Итог:** долг 10 000 → после 4 000 остаётся 6 000 (`partially_settled`) → после 6 000
  `settled` (closedAt). **Оговорка:** пока период не закрыт, переплата видна как
  `employeeDebtKopeks` на расчёте, но отдельной погашаемой записи-обязательства ещё нет.
- **Тесты:** PAYP6, PAYP10 (`pilot-payroll-payments`), OBL2, OBL4, OBL5
  (`pilot-payroll-obligations`).

### D. Тренер тренажёрного зала — ❌ НЕ достижим сквозным путём
- **Ожидание:** пакеты 20 000 (40 %) и 30 000 (50 %), часть занятий проведена, показать
  кредит тренера, при увольнении долг не списывается.
- **Факт (проверено):** `calcGymTrainer`/`calcGymPackage` (пороги 40/50 %) и
  `calcTrainerCredit` определены в `src/lib/payroll/calc.ts` и покрыты unit-тестами, но
  **`computeScheme` их НЕ вызывает** и в UI **нет ввода пакетов/проведённых занятий** —
  проверено `grep`: вне `calc.ts`+пилотов эти функции нигде не используются. Нет и типа
  схемы, который бы к ним диспетчеризовал. Значит тренера ТЗ можно вести только по общей
  схеме (`sales_percentage` и т. п.), без порогов 40/50 и без кредита тренера.
- **Что работает:** «долг при увольнении не списывается» — да (обязательства переживают
  увольнение, списание только явное). Арифметика пакетов/кредита — только как чистые
  функции (тесты PAY-серии в `pilot-payroll`).
- **Вывод:** сценарий D в текущем UI **пройти нельзя**. Это ключевое ограничение.

### E. Регионал по нескольким клубам — ⚠️ частично / вручную
- **Факт:** зарплата регионала считается как отдельные `PayrollCalculation` в периоде
  каждого клуба (схема `revenue_percentage`/`profit_percentage` с ручной/предрасчитанной
  базой). Наличная выплата из каждого клуба резолвит кошелёк именно этого клуба — касса
  каждого клуба уменьшается на свою часть (корректно). Но **единого объекта «городская
  зарплата, выплачиваемая частями» нет**; разбивку между клубами оператор задаёт вручную,
  авто-защиты «не учесть общую сумму дважды» нет — это ответственность оператора.
- **Тесты:** сумма/процент — PER7, INT-серия; единого E2E по регионалу нет.

### F. Два юрлица одного клуба — ⚠️ частично
- **Факт:** одно начисление (`PayrollCalculation`), наличная часть уходит из **активного ИП
  клуба** (`resolveActiveIpForClub` → кошелёк ИП) — корректно. Безналичная часть
  записывается с `legalEntityId = calc.legalEntityId` (юрлицо сотрудника по умолчанию);
  **выбрать ООО для конкретного безналичного платежа в UI нельзя**. Агрегация по клубу
  (paid = нал + безнал) корректна на уровне расчёта.
- **Тесты:** S37 (безнал без кошелька), PAYP4 (paid-агрегация).

### G. Корректировка после утверждения — ✅ достижим полностью
- **Действия:** `accounting_approve` (→ approved, лок); попытка `saveCalculationInputs`
  отклоняется («Период закрыт для изменений расчёта»); `addAdjustment` бухгалтером с
  **обязательным комментарием** → `recomputeCalculationTotals`.
- **Записи БД:** `PayrollAdjustment{status:approved, comment, createdByUserId,
  approvedByUserId}`; отмена — soft (`status:canceled`), история сохраняется.
- **Итог:** credit → доплата (растёт gross/remaining), debit → переплата/удержание.
- **Тесты:** WF9, WF15, WF18, WF19, S25, S28 (`pilot-payroll-workflow`).

---

## 6. Итог по сценариям

| # | Сценарий | Статус | Ключевые записи БД | Δ кассы | Тесты |
|---|---|---|---|---|---|
| A | Аванс 10к + остаток 40к | ✅ | Advance, Payment, 2×CashMovement out | −50 000 (1×+1×) | PAYP4/7/8/9, PAY39 |
| B | 30к нал + 40к безнал, долг 30к | ✅ | 2×Payment, 1×CashMovement out, Obligation | −30 000 | PAYP5, S37, OBL1, S44 |
| C | Переплата 10к, возврат 4к+6к | ✅ (долг на close) | Payment 110к, Obligation, 2×CashMovement in | −110к +4к +6к | PAYP6/10, OBL2/4/5 |
| D | Тренер ТЗ, кредит, увольнение | ❌ E2E (движок-only) | — (нет UI/диспетча) | — | PAY-серия (чистые) |
| E | Регионал, 2 клуба | ⚠️ вручную | по 1 Calculation/клуб | −часть в каждом клубе | PER7, INT |
| F | 2 юрлица, нал ИП + безнал ООО | ⚠️ частично | 1 Calculation, 2 Payment | −нал из ИП | S37, PAYP4 |
| G | Корректировка после утверждения | ✅ | Adjustment (comment) | — | WF9/15/18/19, S25/28 |

---

## 7. Server-side tenant isolation (проверено по коду)

Механизм: `getUserClubs(userId, companyId)` возвращает только клубы, к которым у
пользователя есть `CompanyUserAccess` (все клубы компании) **или** `ClubUserAccess`
(конкретные). Все скоуп-хелперы делают `findUnique` по id, затем сверяют
`companyId === selectedCompanyId` и `clubIds.includes(...)` + `canAccessClub`.

- **Управляющий чужого клуба:** `resolveEmployeeScope`/`resolvePeriodScope`/
  `scopeObligation` → `getEmployeeForScope`/`getPeriodForScope` проверяют
  `accessibleClubIds.includes(clubId)`; чужой клуб не в списке → «не найдено / нет доступа».
  ✅
- **Регионал чужого региона:** блокируется, **если** доступ выдан по клубам
  (`ClubUserAccess`). Если регионалу выдан **company-wide** доступ, он видит ВСЕ клубы
  компании — «регион» не является отдельной сущностью скоупа в платформе. ⚠️ Это
  платформенное поведение, не специфичное для payroll; зависит от способа выдачи прав.
- **Бухгалтер другой компании:** `selectedCompanyId` = его компания; `findUnique` вернёт
  запись, но `companyId !== selectedCompanyId` → отказ. ✅
- **Прямой запрос по известному ID:** каждый action грузит запись по id и затем проверяет
  скоуп (пример: `settleObligation` → `scopeObligation` → `companyId` + `clubIds.includes` +
  `canAccessClub`). Обход через чужой id невозможен. ✅

Вывод: межкомпанийная и межклубная изоляция обеспечены на уровне action. Тонкость —
«регион» не является под-скоупом внутри компании (нужно выдавать регионалу клубные права,
если требуется ограничение по региону).

---

## 8. Ручной UI smoke-test

**Честно: браузерный прогон в этой среде не выполнялся** (нет браузера/скриншотов). Ниже —
оценка по исходному коду страниц; это НЕ замена ручной проверке в пилоте.

- **Desktop:** контейнеры `max-w-[1100..1440px]`, карточки/таблицы — да.
- **Mobile width:** таблицы обёрнуты в `overflow-x-auto` (горизонтальный скролл),
  формы — `flex-wrap`/`grid grid-cols-1 sm:grid-cols-2`. Ожидаемо адаптивно; **не
  проверено вживую**.
- **Пустой период:** обрабатывается — «Пока нет расчётов» + кнопка формирования.
- **50 сотрудников:** рендерится список карточек **без пагинации** — страница станет
  длинной, но функциональна; для 50+ желательна пагинация (отсутствует).
- **Длинные ФИО:** в ростере — `whitespace-nowrap` (таблица скроллится); в карточке расчёта
  имя без `truncate` → перенос строки. Критичных поломок не ожидается; **не проверено вживую**.
- **Частичные выплаты / долги:** `PaymentsSection` показывает «К выплате / Выплачено /
  Остаток», список выплат с отменой; `/payroll/obligations` — суммы по направлениям.
- **Ошибки валидации:** серверные, выводятся из `state.error`/`fieldErrors` красным
  (`text-rose-600`); обязательный комментарий корректировки, сумма > 0, превышение остатка
  долга, закрытый месяц — все дают текстовую ошибку.

---

## 9. Экраны и отсутствующие страницы

**Скриншоты не сделаны (нет браузера).** Фактические экраны (по коду):
- `/payroll` — ростер: ФИО, клуб, должность, закрепления, текущая схема; кнопки «Сводка
  ФОТ», «Долги», «Расчётные периоды».
- `/payroll/employees/[id]` — платёжный профиль (дата приёма, способ выплаты, ИП по
  умолчанию, официальность), закрепления (список + добавить/убрать), история схем + форма,
  блок обязательств (с пометкой при увольнении).
- `/payroll/periods` — создание периода + список с суммами.
- `/payroll/periods/[id]` — тоталы, панель согласования, кнопка формирования, карточки
  расчётов (ввод по типу схемы, расшифровка, предупреждения), корректировки, выплаты/авансы.
- `/payroll/obligations` — суммы по направлениям + погашение/списание.
- `/payroll/summary` — агрегаты ФОТ по клубам + долги.

**Отсутствует / не покрыто UI:**
- Ввод пакетов и проведённых занятий тренера ТЗ (§4.2) и отображение кредита тренера —
  **нет экрана и нет диспетча в движке**.
- Отдельного экрана «выдать аванс до создания периода» нет (аванс только после утверждения).
- Выбор юрлица (ООО/ИП) по конкретному безналичному платежу — нет.
- Консолидированный экран зарплаты регионала по нескольким клубам — нет.
- Пагинация больших списков — нет.
- Строка `Expense{category:"salary"}` при выплате не создаётся (только `CashMovement`).

---

## 10. Прочие проверенные факты и риски

- **Единый источник денег (§8):** paid = аванс(paid) + confirmed-выплаты, суммируются
  отдельно (нет двойного счёта аванса) — `recomputeCalculationTotals`. Касса — производная
  (`walletBalanceKopeks`), не хранится. Списание однократно (идемпотентно), отмена = обратный
  приток. ✅
- **Иммутабельность схем/периодов:** расчёт считается по `schemeSnapshotJson`, не по живой
  схеме; закрытый месяц не пересчитывается; правка схемы — только вперёд. ✅
- **Аудит:** все мутации пишут `recordAudit` (server-side), ярлыки в activity-журнале. ✅
- **Переплата** допускается на этапе выплаты (нет верхнего кэпа в `recordPayment`), долг
  материализуется записью-обязательством только при закрытии периода. ⚠️ (ожидаемо, но
  стоит подтвердить).
- **Зарплата как расход P&L:** payroll создаёт только движения кассы; строки `Expense`
  (category=salary) нет. Легаси-путь `PayrollStatement→Expense` — отдельный; при
  одновременном использовании обоих возможен двойной учёт в расходной аналитике (в кассе —
  нет). ⚠️ Требует бизнес-решения.
- **Streak-бонусы (§4.5B):** `streakBonusKopeks` не применяется автоматически — только как
  ручная корректировка. ⚠️

---

## Вердикт

# READY WITH LIMITATIONS

Модуль готов к **ручному пилоту на ролях «управляющий/регионал/бухгалтер/собственник»** для
схем: фикс, оклад по сменам, оклад+процент, почасовая, оклад по плану-факту (с автоподстановкой
из ОФД/плана), процент от выручки/прибыли — со всем циклом согласование → авансы/выплаты
(нал/безнал) → закрытие → долги. Денежный контур (единое списание кассы, долги, погашение,
списание) и изоляция арендаторов проверены по коду и покрыты 166 unit/integration-проверками.

Пилот следует проводить **с явными оговорками**:
1. Тренер тренажёрного зала (§4.2) и кредит тренера — **не готовы к пилоту** (движок есть,
   UI/диспетча нет). Сценарий D исключить или довести отдельно.
2. Регионал по нескольким клубам и «два юрлица (ООО безнал)» — только вручную/частично.
3. Зарплата не отражается как строка расхода (P&L) — подтвердить у бизнеса.
4. Авансы только после утверждения периода.
5. Живой сквозной прогон A–G через БД/UI и браузерный smoke-test в этой среде **не
   выполнялись** — их выполнение и есть цель пилота.

Модуль **нельзя** называть полностью готовым: часть спецификации (§4.2, регионал,
безнал-ООО) не проходится сквозным путём. Для «READY FOR PILOT без оговорок» нужно как
минимум подключить схему тренера ТЗ + кредит тренера к `computeScheme`/UI и определить
поведение зарплаты в расходном контуре.
