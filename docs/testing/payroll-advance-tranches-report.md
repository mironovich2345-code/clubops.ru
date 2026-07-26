# Приёмка: аванс с траншами (STAGE 9) + mobile payroll/advances

Реализованы STAGE 9 (транши аванса) и обязательная мобильная адаптация payroll+advances.
Финансовые инварианты сохранены; workflow регионал→ГД, versioned schemes, OfdCashierMapping
и авто-атрибуция — вне этапа.

## Модель
- `PayrollAdvance` (аддитивно): `requestedAmountKopeks`, `approvedAmountKopeks`,
  `linkedPayrollCalculationId`. Legacy `amountKopeks`/`expenseId` сохранены.
- `PayrollAdvancePayment` (новая, транш): собственные `expenseId`/`cashMovementId`,
  `idempotencyKey` (unique), reversal-поля. Миграция dev+prod, только ADD/CREATE.

## Финансовая модель
- Согласование аванса **не двигает деньги** (`createApprovedAdvance`).
- Каждый транш = один `Expense{category:salary, kind:advance}` + одно `CashMovement`
  (наличные). Идемпотентно по `idempotencyKey`. Транзакция не даёт сумме траншей превысить
  approved (concurrency-safe).
- Fold в зарплату: `advancesKopeks = Σ активных траншей`; **approved-но-не-выплаченное не
  уменьшает** остаток. Транзишн-безопасно (legacy paid без траншей → его `amountKopeks`).
- Сторно — **на уровне транша**: cash возвращается один раз, транш→reversed, recompute;
  закрытый период запрещает прямое сторно.
- Финальная зарплата расход не пере-признаёт.

## Backfill
`payroll:advance-audit` (read-only, счётчики) и `payroll:advance-backfill` (dry-run по
умолчанию, `--apply`): legacy paid-аванс → один транш, **переиспующий** существующий
Expense/движение (новых не создаёт), `approved=requested=amount`; идемпотентно
`legacy:<id>`; paid-без-expense пропускается на ручную проверку.

## Mobile (§19)
Payroll и advances: 5 карточек в колонку; таблицы (ростер, список авансов, транши) →
карточки на `md:hidden`; форма транша вертикальная, `inputMode=decimal`, touch ≥44px,
«после выплаты остаток»; сторно визуально отделён + подтверждение. Аудит и план —
`mobile-readiness-audit.md`, `mobile-pwa-roadmap-2026-08-18.md`.

## Тесты
`npm run pilot:payroll-advance-tranches` — **27** (один аванс/месяц, несколько траншей,
лимит approved в транзакции, идемпотентность, paid=Σ активных траншей, approved≠paid,
частичная/полная выплата, fold уменьшает остаток зарплаты, сторно на уровне транша +
двойное блокируется, частичное сторно → статус, backfill переиспользует Expense +
идемпотентен, tenant/club). `pilot:payroll-formulas` 28, `pilot:payroll-role-cards-stage2`
25 — проходят. `pilot:full` **2967/0** (56 сьютов, старые payroll advance-тесты обновлены под
fold по траншам и проходят). tsc ✓, build ✓, build:prod ✓, схемы валидны.

## Остаточные ограничения / STAGE 10–14
- Legacy single-payout авансы не принимают новые транши до backfill (модели раздельны — по
  дизайну; backfill переводит их в транш-модель).
- Полноценный approve-flow (создание «согласованного» аванса) — `createApprovedAdvance`
  доступен; UI создания в списке пока использует существующую форму немедленной выплаты +
  ссылку в карточку для траншей.
- Остальные модули mobile — по роадмапу до 18.08.2026.
- STAGE 10–14: регионал→ГД, versioned schemes, OfdCashierMapping, авто-атрибуция, детальные
  вкладки категорий, полная mobile-адаптация остальных модулей.
