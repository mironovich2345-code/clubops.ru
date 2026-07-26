# Отчёт: заявки на изменение зарплаты (STAGE 10–11)

Регионал предлагает изменение закрытых для управляющего параметров зарплаты; изменение **не
влияет на расчёт до согласования ГД/собственника**. Реализованы только STAGE 10 (предложения) и
STAGE 11 (очередь и решения). Полноценная versioned-scheme migration (STAGE 12), авто-атрибуция
выручки, OfdCashierMapping и глобальный mobile остальных модулей — вне рамок.

## Архитектура
- **`src/lib/payroll/change-request.ts`** — чистое ядро (без DB/eval):
  - `WHITELIST` — единственный список полей, доступных регионалу, по типам схем (§4).
  - `applyOverridesToParams` — merge override поверх params + ре-валидация через
    `validateSchemeParams` (границы значений).
  - `effectiveSchemeParams` — snapshot + approved overrides → типизированная схема; используется
    ВЕЗДЕ в расчётном пути.
  - `previewChangeImpact` — влияние через тот же `computeScheme`, что и apply (§23); при
    отсутствии базы — «Невозможно рассчитать влияние», не 0 (§8).
  - state-machine (`canTransition`) + `appendHistory` (append-only trail).
- **`src/app/(app)/payroll/change-requests/actions.ts`** — серверные действия: propose (разовая
  премия / override / будущая схема), cancel/resubmit, return/reject/approve.
- **Расчётный путь**: `saveCalculationInputs` и `recomputeGymTrainerCalculation` резолвят
  эффективную схему; raw input сохраняется в `detailsJson.inputJson` для детерминированного
  повторного расчёта при применении.
- **Модель**: `PayrollChangeRequest` (+ `appliedToken @unique`), `PayrollCalculation.
  approvedOverridesJson`. Аддитивная миграция dev+prod.
- **UI**: очередь `/payroll/change-requests` (KPI/фильтры/таблица+карточки), деталь
  `/payroll/change-requests/[id]` (before/after, влияние, переплата, история, решения),
  блок на карточке расчёта (`ProposeChangeSection`).

## Как применяется изменение (§6)
| Тип | Что делает approve |
|-----|--------------------|
| one_time_bonus | Создаёт approved `PayrollAdjustment` (credit). Движения денег нет (§7). |
| percentage / base_salary / threshold / tier | Добавляет override в `approvedOverridesJson`; пересчитывает `automaticAmountKopeks` из эффективной схемы. Base snapshot не переписывается. |
| future_scheme_change | Статус `approved_pending_scheme_creation`. Текущий расчёт не меняется (§10 Variant B). |

Идемпотентность (§15): approve атомарно «захватывает» заявку `updateMany` c условием
`status ∈ {submitted, under_review} AND appliedToken IS NULL` и уникальным `appliedToken` —
повторный approve даёт `count=0` и ничего не применяет.

## Критерии приёмки (25 пунктов)
1. Регионал не может применить закрытое изменение напрямую — только предложить. ✔ (`canProposePayrollChange`, whitelist)
2. Pending-заявка не влияет на итог до согласования. ✔ (T1)
3. ГД видит текущее/новое значение и влияние. ✔ (деталь before/after)
4. «Невозможно рассчитать влияние» вместо фейкового 0. ✔ (§8, P6/SG3)
5. Approve применяет изменение ровно один раз. ✔ (T2–T4, идемпотентный claim)
6. Base snapshot не переписывается; override хранится отдельно. ✔ (T5/T6)
7. Разовая премия → строка начисления, без движения денег. ✔ (T7/SG8)
8. Reject не меняет расчёт. ✔ (T8/SG10)
9. Return сохраняет историю; resubmit повышает ревизию. ✔ (T9/§13)
10. Разовое изменение периода не трогает живую схему. ✔ (override на calc, не на EmployeePayScheme)
11. Будущая схема не переписывает прошлое; не объявляется «applied». ✔ (T10/SG11)
12. Закрытый период защищён от применения. ✔ (approve guard)
13. Период с незакрытой заявкой нельзя закрыть. ✔ (T11/T12/SG12)
14. Переплата при снижении суммы показывается, авто-возврата нет (§17). ✔ (overpayWarning)
15. Роли серверные: propose=regional, review=GD/owner. ✔ (SG9)
16. Нельзя согласовать собственную заявку. ✔ (`resolveReviewer`)
17. Tenant-изоляция + IDOR-guard. ✔ (T13/T14/SG13)
18. Whitelist запрещает companyId/clubId/employeeId/category/formula/engineVersion/выплаты. ✔ (SG1/P3)
19. Preview и apply — один расчётный путь. ✔ (SG2/§23)
20. Полный аудит-трейл (не только последнее состояние). ✔ (historyJson/SG14/§24)
21. Уведомления через существующую инфраструктуру. ✔ (SG18/§20)
22. Кнопка «Предложить изменение» + блок на карточке расчёта. ✔ (§21)
23. Очередь ГД: KPI + фильтры + таблица/карточки. ✔ (§11)
24. Mobile от 320px. ✔ (карточки/адаптив)
25. Аддитивная миграция dev+prod; оба schema валидны. ✔ (SG15/§25)

## Тесты
`npm run pilot:payroll-change-requests` — 44 проверки (11 pure-engine, 18 static guards, 15
real-DB), зелёные. Зарегистрирован в `pilot:full`.

## Не сделано намеренно (вне STAGE 10–11)
Полноценная versioned payroll scheme migration (STAGE 12) — будущая схема пока фиксируется как
`approved_pending_scheme_creation` без небезопасной перезаписи. Payroll rework в целом НЕ
объявляется завершённым.
