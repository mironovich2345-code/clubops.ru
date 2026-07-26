# Отчёт: версионируемые схемы зарплаты (STAGE 12)

Реализован только STAGE 12. Не менялись: формулы, role_categories_v2, финансовая логика,
STAGE 9 транши, snapshot прошлых расчётов. Payroll rework НЕ объявляется завершённым.

## Финальный отчёт (§26)
1. **Как работало раньше.** `EmployeePayScheme` — append-forward effective-dated, только
   employee-specific через UI; сразу «действующая», без версии/статуса/approval; resolver по
   дате периода; snapshot immutable.
2. **Риски.** Нет явной версии/статуса; частичные пересечения интервалов молча разрешались
   (побеждал новый); нет server-guard против in-place правки параметров; будущее изменение
   застревало в `approved_pending_scheme_creation` без материализации.
3. **Добавленные поля.** `version, status, payrollCategory, submittedById/At, approvedById/At,
   activatedAt, archivedAt, supersedesSchemeId, sourceChangeRequestId(@unique), comment`
   (аддитивная миграция dev+prod).
4. **Логический ключ.** `(company|club|employee?ALL|position)` — та же группировка, что и в
   resolver; версия инкрементируется в его пределах.
5. **Version.** `max(version в ключе)+1`, не глобальный.
6. **Статусы.** draft/pending_approval/approved/scheduled/active/superseded/archived/rejected/
   cancelled + машина переходов.
7. **effectiveFrom/effectiveTo.** End-exclusive `с ≤ t < по`; активация закрывает предыдущую
   открытую (`по`=дата новой, статус superseded); параметры старой неизменны.
8. **Resolver.** По дате периода среди «живых» (approved/scheduled/active/superseded); stale
   status не переопределяет интервал.
9. **Employee > category.** Приоритет: employee-версия, покрывающая дату → она; иначе category.
10. **Conflict.** ≥2 живых версии, покрывающих дату → блок с сообщением (не случайный выбор);
    аудит-скрипт находит пересечения/дубли/multi-covering.
11. **Snapshot.** schemeId/version/status/интервал/логический ключ/уровень resolver/
    sourceChangeRequestId/resolvedAt — фиксируются, не переписываются.
12. **Защита прошлого.** Новая версия не меняет существующий snapshot; silent refresh отсутствует.
13. **Ручная версия.** Регионал → черновик → submit → ГД/owner/гл.бух «Согласовать и
    активировать» (закрытие предыдущего интервала, версия, статус).
14. **Materialize из заявки.** `materializeApprovedSchemeChange` мёржит предложенное значение на
    base snapshot params и создаёт employee-specific версию с указанной даты; approve заявки
    вызывает материализацию сразу.
15. **Idempotency.** `sourceChangeRequestId @unique` + повтор возвращает существующую версию;
    сбой не помечает заявку applied (безопасный retry-кнопкой).
16. **Immutable поля.** paramsJson/payrollCategory/employeeId/clubId/companyId/effectiveFrom/
    version/schemeType (для used/active/superseded); черновик редактируется.
17. **Backfill.** version 1..N по effectiveFrom, status по датам, supersedes-цепочка; dry-run по
    умолчанию, `--apply` явно; неоднозначные ключи пропускаются.
18. **Конфликты/manual review.** `payroll:scheme-audit` — счётчики + технические ID (без ПДн):
    overlaps, dup versions, multi-covering, missing scope, pending materialization; hard-конфликты
    → exit≠0.
19. **Роли.** Управляющий — read-only применённой схемы. Регионал — черновики своих клубов +
    submit. ГД/собственник/гл.бухгалтер — approve/activate/materialize. Все проверки server-side +
    tenant/IDOR.
20. **UI истории версий.** `/payroll/schemes` (цепочки) + `[id]` (история версий + сравнение
    последних двух, без сырого JSON) + действия по статусу.
21. **Mobile.** Список карточками, цепочка вертикально, compare без горизонтального скролла,
    кнопки ≥44px — от 320px.
22. **Тесты/build.** `pilot:payroll-versioned-schemes` 41/0; tsc/next build/build:prod/prisma
    validate dev+prod зелёные; `pilot:full` зелёный.
23. **Commit hashes.** Серия `feat/test/docs(payroll): STAGE 12 item N …` (см. `git log`).
24. **Остаточные ограничения.** Материализация из change-request создаёт **employee-specific**
    версию (безопасно, не трогает общую схему категории) — category-level версия из заявки
    остаётся ручным путём. Форма ручного черновика поддерживает legacy scheme types;
    role_categories_v2-схемы создаются через материализацию/сидинг. `/payroll/employees` форма
    по-прежнему основной вход создания employee-схем.
25. **STAGE 13–14.** OfdCashierMapping; авто-личная выручка; category-level materialization из
    заявки; полноценный UI ручного создания role_* черновиков; расширенный compare произвольных
    версий; уведомления о скором вступлении запланированной версии.

## Критерии завершённости STAGE 12
Approved future scheme change создаёт реальную новую версию ✔; старая не редактируется ✔;
resolver по дате периода ✔; пересечения блокируются ✔; snapshot прошлых периодов не меняется ✔;
повторный materialize без дубля ✔; used-scheme immutable ✔; backfill безопасен (dry-run) ✔; UI
схем и сравнения на mobile от 320px ✔.

## Тесты
`npm run pilot:payroll-versioned-schemes` — 41 (12 pure + 16 static + 13 real-DB).
