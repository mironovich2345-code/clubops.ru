# Финальный аудит CLUB OPS Demo — 17 ноября 2026

Рабочая ветка: `demo/branch-network-showcase`. Начальная актуальная версия:
`3f9757b` (14 ранее сохранённых коммитов после `d0a4131`). Checkout был чистым;
ветка обновлена только fast-forward относительно одноимённой ветки origin.
Прежние исправления не применялись повторно. `main`, рабочая БД, production,
deployment и опубликованные переменные окружения не изменялись.

## Статус и объём

Повторно проверены реальные финансовые workflows, исходные ACL, пять доступных
деморолей, изоляция двух посетителей, reset/TTL, документы и финансовые readers.
Инвентаризация фактического дерева: **65 страниц, 53 из них внутри приложения,
22 API routes**. Это уточнение прежнего отчёта с числом 64, а не новый экран.

Полная таблица экран → исходник → назначение/контролы → роли → источники → состояния
и ограничения: [инвентаризация](screen-inventory-2026-11-17.md),
[машиночитаемые сведения](screen-inventory-2026-11-17.json).
Роли в ней извлечены из page ACL; object/club/workflow gates проверяются дополнительно.
Наличие слова `error` или `pending` в исходнике не доказывает проверку каждого
возможного состояния. Фактическое браузерное покрытие записано отдельно.

Широкая браузерная матрица: **265 сочетаний маршрут × роль**. Из них 185 экранов
отрисованы и проверены на 375/390/768/1024/1440 px в light/dark — **1 850 отображений**.
58 переходов перенаправлены по контракту, 20 обращений к закрытым настройкам
заблокированы, два запроса управляющего вернули ожидаемый 404
(`/analytics/expenses`, `/payroll/regional`). Эти 80 случаев не считаются
успешно проверенными формами. Нет пропусков из-за отсутствующих ID: runner создаёт
собственные синтетические аванс, заявку, кассира, отчёт и черновик возврата.

В каждом разрешённом отображении проверены заголовок, тема и переполнение;
на первом открытии — демобейдж, видимые отраслевые термины и error boundary.
HTTP 200 без этих проверок не считается приёмкой. Финансовые изменения отдельно
проверяются через формы/server actions с последующей проверкой записей в PostgreSQL.

## Перепроверка прежних замечаний

| Замечание 16.11 | Текущий код | Повторное подтверждение |
|---|---|---|
| Сводка на каждом экране | Уже перенесена в dashboard | Общий E2E: сводки нет в возвратах; screenshots dashboard |
| Громоздкая демопанель | Уже компактная, форма на `/demo` | Все разрешённые экраны в обеих темах/пяти ширинах |
| Слабая читаемость dark | Прежние исправления сохранены; обнаружены отдельные остаточные проблемы контраста | axe + screenshots; дополнительные исправления ниже |
| Ненадёжная мобильная навигация | Нативные ссылки уже есть | Все пять ролей: JavaScript, клавиатура, предусмотренный no-JS fallback |
| Пустой раздел документов | Уже хаб к scoped-вложениям | Разрешённым ролям доступны источники; собственник/GD перенаправляются согласно исходным ACL |
| Смешанные 400/403/429/503 | Уже разделены | Public/API runner: чужой Origin 403, неизвестная роль 400; DB runner проверяет квоты |
| SQLite probe на PostgreSQL | Уже исправлен порядок dialect probes | Readiness/PostgreSQL и health regression; no-op probes не подключаются к рабочей БД |
| Старые селекторы тестов | Уже обновлены | 25 общих и 9 финансовых браузерных проверок повторно пройдены |
| Двойной учёт зарплат, календарь, бюджеты, дата возврата | Исправления уже есть | 26 DB/action сценариев и регрессии формул/возвратов |

## Реестр текущих дефектов и решений

| Приоритет | Причина | Решение / файлы | Повторная проверка |
|---|---|---|---|
| P1 | Остаточные отраслевые подписи в аналитике, расшифровках зарплаты, сообщениях возврата, XLSX и metadata | Заменены только presentation literals в app/components/lib; identifiers и формулы сохранены | AST vocabulary regression; round-trip нового/старого XLSX; браузерная матрица |
| P1 | Инкассация/изъятие требуют документ, а загрузки запрещены в демо | `collections/actions.ts` генерирует синтетическое подтверждение после обычных ACL; формы показывают ограничение; local storage умеет читать только выделенный synthetic key | Отдельный cash E2E: создание, PDF, остаток, согласование, поддельная загрузка |
| P1 | Недостаточный контраст muted-текста и отдельных статусов в light; светлый overdue badge с ярким текстом в dark | `globals.css`: AA-палитра для вторичного текста, статусов, dark links и badge surfaces | На выбранных ключевых экранах axe не выявил нарушений; screenshots просмотрены |
| P2 | Analytics и OFD одновременно выделяются как активные | Sidebar/MobileShell выбирают самый длинный совпадающий href; `aria-current` только у текущего пункта | ОФД-страница, переходы и Back |
| P2 | Мобильный dialog не удерживал фокус и не закрывался Escape | MobileShell: focus trap, начальный фокус, Escape и возврат фокуса; aria-expanded групп | Клавиатурная проверка для каждой роли |
| P2 | Возврат к `/demo` сбрасывает роль/филиал в форме на owner/Центральный | Значения берутся из действующего собственного tenant/session; без совпадения используется безопасный default | Управляющий → Северный → `/demo`, grants остаются в одном филиале |
| P2 | Sidebar мог падать при недоступном localStorage | Обработка исключений чтения/записи, без изменения серверного доступа | Source review; обычная навигация пройдена. Отдельная эмуляция полностью заблокированного storage не проводилась |
| P2 | `npm run lint` запрашивает начальную настройку вместо проверки | Добавлены закреплённые ESLint 8.57.1/config-next 15.5.18 и `.eslintrc.json`; native offline/install fallback сохранён с локальным обоснованием исключения | ESLint без ошибок; остаются 6 предупреждений существующего кода |

P0 в проверенных сценариях не обнаружены. Это не утверждение об отсутствии ошибок
в непроверенных браузерах и комбинациях состояний.

## Отраслевая терминология: A / B / C

**A — отображаемые значения.** Убраны остатки «Продажи ПТ», «АБ», «ГП»,
«Персональные», «абонементы», подписи параметров оклада/процента, сообщения о
количестве занятий/исполнителе, описание PWA. Используются «Основные услуги»,
«Дополнительные услуги», «Пакетные услуги», «Исполнитель», «Единица услуги».
Плановый XLSX теперь формируется с универсальными заголовками и «Филиал».
Суммы, типы операций, единицы денег и финансовые алгоритмы не заменялись текстом.

**B — совместимость.** Оставлены `membership`, `personal_training`, `subscriptions`,
`trainer*`, `gym_trainer`, `group_trainer`, `pt*`, `ab*` в БД, типах, ключах форм,
доменной логике, API и snapshot. Их переименование потребовало бы миграций и
изменения контрактов. Синонимы классификатора ОФД и старые заголовки XLSX оставлены
как входные aliases; они не попадают в генерируемый шаблон. Сокращение «Пт» в
календаре означает пятницу и сохранено. Старые отчёты/ТЗ и комментарии описывают
историческую модель, а не текст текущего интерфейса.

**C — механики.** `TrainerPackages.tsx` и специализированные зарплатные алгоритмы
не удалены; пакетная отраслевая карточка уже скрыта в демо. Fixtures содержат
48 вымышленных сотрудников универсальных должностей. `PtCalcForm.tsx` сохранён
для исходного домена; в демо создание специализированного возврата блокируется
сервером, а details-route перенаправляет. Доступен проверенный договорный возврат
с прежней финансовой формулой. Превращение отраслевой модели в новый универсальный
продукт не выполнялось; финансовые данные и алгоритмы не удалялись.

## Безопасность и инфраструктура проверки

Использован существующий локальный контейнер `clubops-demo-postgres`, адрес
`127.0.0.1:55432`, отдельная БД `clubops_demo_qa`. Перед командами проверены имя,
host и demo-gate. Конфигурация `.env.demo.local` уже существовала и не изменялась;
обычный `.env` и production credentials не использовались для DB-проверок.
`prepare` и Prisma generation прошли на существующей демобазе; новых миграций нет.

Обычные auth/session/ACL сохранены. Выбор любой из пяти деморолей внутри своего
набора — предусмотренная функция. Неизвестная `system_admin` отклоняется;
подмена ID другого tenant проверяется отдельно, как и запрещённые действия ролей.
Noindex — запрет индексации, а не пароль. Секреты, реальные пользователи и внешние
платёжные реквизиты не добавлялись. Настоящие загрузки и внешние транспорты остаются
запрещены; новая cash-ветка отвергает даже подставленный file-input.

DB runner проверяет квоты, HMAC/session, reset и TTL, отсутствие паролей у fixtures,
синтетические контакты, scoped storage и отключение интеграций. Functional runner
проверяет одновременные изменения двух посетителей и финансовую изоляцию.
Во всех завершённых браузерных прогонах нет внешних запросов и необработанных JS ошибок.

## Границы приёмки и вывод о запуске

Демонстрация основных B2B-сценариев локально проверена и пригодна для сопровождаемого
показа. Полная публичная приёмка не заявляется:

- Chromium/headless проверен; Safari/iOS/WebView, реальные touch-жесты и все
  комбинации модальных/ошибочных/пустых состояний вручную не пройдены.
- axe по ключевым страницам и просмотр screenshots не являются сертификатом WCAG AA
  всего приложения. Существующие 6 предупреждений ESLint не блокируют сборку.
- Единый реестр документов, поиск по всем вложениям, реальные файлы, уведомления,
  банковские переводы и интеграции намеренно отсутствуют/закрыты. Сверка остаётся
  явно подписанным синтетическим эталоном.
- Публичный HTTPS preview в этом этапе не проверен: его точный URL не предоставлен
  в доступной конфигурации/репозитории. Существующий отчёт о Railway не выдаётся
  за новую проверку его сети, proxy, scheduler или секретов.
- До размещения ссылки на MIRONOVICH.PRO нужны проверка существующего HTTPS-стенда,
  Safari/iOS, доверенного proxy/IP, cleanup/мониторинга и отдельное решение владельца
  о публикации. Новое окружение не развёртывалось, deployment не запускался.

Технические результаты, матрица и screenshots приложены ниже после завершения
финального прогона. SHA этого этапа определяются историей демоветви и итоговым
сообщением; собственный SHA не встраивается в самоссылочный commit.


## Технические результаты и функции

| Проверка | Результат |
|---|---|
| Production build + Prisma Client 5.22.0 | PASS, Next.js 15.5.18 |
| `tsc --noEmit` | PASS |
| `npm run lint` | PASS: 0 ошибок, 6 предупреждений |
| DB/security (`demo-tests`) | 34 PASS |
| Финансовые DB/server actions (`demo-functional-tests`) | 26 PASS |
| Общий browser E2E | 25 PASS |
| Финансовый browser E2E | 9 PASS |
| Широкий browser audit | 73 PASS, 265 route/role outcomes, 1 850 отображений |
| Public/API/no-JS | 106 PASS, включая 70 переходов по всем доступным пунктам native-меню пяти ролей; 10 комбинаций темы/ширины входа |
| Cash browser regression | 7 PASS: PDF/создание/запрет файла/согласование/изъятие/повторное отображение/нет внешних запросов |
| Новая регрессия presentation/XLSX | PASS: словарь, params, новый шаблон и старый import |
| Формулы зарплат / возвраты | 28 / 34 PASS |
| Health / deploy-config | 32 / 125 PASS; deploy не запускался |
| Доступность | 60 выбранных screen/theme axe scans + раскрытая cash-форма; нарушений в этой выборке нет |
| Зависимости (`npm ls --depth=0`) | PASS |
| `git diff --check`, включая новые staged-файлы | PASS |

Все финансовые сценарии используют настоящие Prisma/PG и серверную бизнес-логику.
В DB functional runner адаптированы только Next request/cache границы; браузерные
сценарии проходят реальные формы и HTTP. В отрицательных DB-тестах ожидаемы отказ
квоты и conflict/retry зарплатной транзакции — итоговые проверки проходят.

| Функциональный блок | Доказательство и границы |
|---|---|
| Демо-вход, роли, филиал, завершение сессии | HTML-форма без JS; 5 ролей; сохранение manager/Северный; неизвестная роль 400; чужой Origin 403; session expiry и reset. Отдельной кнопки «Выйти из демо» нет |
| Дашборд, аналитика, ОФД | Реальные synthetic readers, суммы baseline, role/scope, матрица, screenshot. Классификатор сохраняет исторические aliases |
| Расходы | Создание v2 → synthetic PDF → согласование → verified; запрет чужой записи; UI формы и бухгалтерская проверка |
| Счета и оплаты | Подмена invoiceId отклонена; разрешённая оплата создаёт ledger-запись и paid; scoped PDF |
| Инкассация/остатки | Создание 1 000 ₽ с synthetic PDF, pending уменьшает кассу ровно раз; подтверждение бухгалтером не списывает повторно; изъятие 500 ₽ переносит ООО → ИП; признанные расходы не меняются; injected file отклонён |
| Календарь/бюджеты | Общий reader, obligations после аванса/выплаты; лимит/перерасход/согласование и plan-fact в 26 сценариях; owner меняет лимит в UI |
| Сотрудники/зарплата | 48 вымышленных сотрудников; расчёт, будущая схема и snapshot; аванс/транши/выплата/переплата/parallel retry; запрет mark_paid с долгом |
| Возвраты | Черновик → synthetic комплект → расчёт → согласование → бухгалтерская оплата без перевода; stale inputs, запреты и повторная оплата; дата признания сохраняется |
| Документы | Scoped PDF и generated cash PDF читаются; хаб только по ACL. Единого поиска и произвольной загрузки нет |
| Пользователи/настройки/история | Отображение по ролям и scope проверено; account/security/integration mutations закрыты. Полный CRUD пользователей не заявлен |
| Изоляция/сброс | Два одновременных посетителя меняют собственные наборы; чужие read/write отклонены; reset удаляет только свой tenant; TTL/cleanup проверены |

Полная [матрица экранов](browser-coverage-2026-11-17.md) и
[JSON результатов](browser-coverage-2026-11-17.json) отделяют отрисовку от проверки
финансового workflow. После широкой матрицы последние изменения cash-форм и
подписей dashboard/chart повторно проверены отдельным runner: 30 дополнительных
отображений, раскрытая форма, axe и новые screenshots.

## Скриншоты

Сохранены реальные Chromium screenshots с синтетическими данными. На дашборде
после cash-сценария остатки Центрального изменены, а P&L не увеличился от внутреннего
перемещения денег. Полный локальный набор всех ролей — `artifacts/final-audit/`
(игнорируется Git); ниже 12 отобранных иллюстраций, сохранённых вместе с отчётом.

| Экран | Light 375 | Dark 375 | Light 1440 | Dark 1440 |
|---|---|---|---|---|
| Вход | [PNG](screenshots-2026-11-17/entry-light-375.png) | [PNG](screenshots-2026-11-17/entry-dark-375.png) | [PNG](screenshots-2026-11-17/entry-light-1440.png) | [PNG](screenshots-2026-11-17/entry-dark-1440.png) |
| Дашборд | [PNG](screenshots-2026-11-17/dashboard-light-375.png) | [PNG](screenshots-2026-11-17/dashboard-dark-375.png) | [PNG](screenshots-2026-11-17/dashboard-light-1440.png) | [PNG](screenshots-2026-11-17/dashboard-dark-1440.png) |
| Счета | [PNG](screenshots-2026-11-17/invoices-light-375.png) | [PNG](screenshots-2026-11-17/invoices-dark-375.png) | [PNG](screenshots-2026-11-17/invoices-light-1440.png) | [PNG](screenshots-2026-11-17/invoices-dark-1440.png) |

ESLint добавлен только в devDependencies; единственное изменённое существующее
транзитивное разрешение lockfile — `hasown` 2.0.3 → 2.0.4. Runtime framework,
Prisma, React и финансовые зависимости не обновлялись. Новые QA-скрипты требуют
Playwright/Chromium; axe подключается явно через `DEMO_AXE_PATH`. QA axe установлен
в `/tmp` и не становится production-зависимостью.

Команды повторения:

```bash
node scripts/demo-runtime.mjs prepare
node scripts/demo-runtime.mjs build
node scripts/demo-runtime.mjs start
# В другом терминале, с существующим локальным demo env:
node scripts/demo-inventory.mjs
node scripts/demo-presentation-tests.mjs
node scripts/demo-tests.mjs
node scripts/demo-functional-tests.mjs
DEMO_CHROMIUM_PATH=/usr/bin/chromium node scripts/demo-browser-tests.mjs
DEMO_CHROMIUM_PATH=/usr/bin/chromium node scripts/demo-finance-browser-tests.mjs
node scripts/demo-public-browser-tests.mjs
DEMO_AXE_PATH=/path/to/axe.min.js node scripts/demo-audit-browser.mjs
DEMO_AXE_PATH=/path/to/axe.min.js node scripts/demo-collections-browser-tests.mjs
npx --no-install tsc --noEmit
npm run lint
```


## Git и проверка состава

Итог: **52 файла**, включая 12 отобранных screenshots. Проверены имена путей, секретные шаблоны и совпадения с двумя фактическими runtime-секретами: находок нет. Env-файлы, дампы, тестовая БД, логи и временные артефакты в индекс не включаются. Whitespace проверен во временном индексе со всеми новыми файлами, затем повторяется для каждого коммита. Изменения разделены на 6 логических коммитов: presentation/import (17), navigation (3), cash (4), contrast (1), tooling/tests (10), documentation/evidence (17).

```text
.eslintrc.json
docs/demo/browser-coverage-2026-11-17.json
docs/demo/browser-coverage-2026-11-17.md
docs/demo/final-audit-2026-11-17.md
docs/demo/screen-inventory-2026-11-17.json
docs/demo/screen-inventory-2026-11-17.md
docs/demo/screenshots-2026-11-17/dashboard-dark-1440.png
docs/demo/screenshots-2026-11-17/dashboard-dark-375.png
docs/demo/screenshots-2026-11-17/dashboard-light-1440.png
docs/demo/screenshots-2026-11-17/dashboard-light-375.png
docs/demo/screenshots-2026-11-17/entry-dark-1440.png
docs/demo/screenshots-2026-11-17/entry-dark-375.png
docs/demo/screenshots-2026-11-17/entry-light-1440.png
docs/demo/screenshots-2026-11-17/entry-light-375.png
docs/demo/screenshots-2026-11-17/invoices-dark-1440.png
docs/demo/screenshots-2026-11-17/invoices-dark-375.png
docs/demo/screenshots-2026-11-17/invoices-light-1440.png
docs/demo/screenshots-2026-11-17/invoices-light-375.png
package-lock.json
package.json
scripts/demo-audit-browser.mjs
scripts/demo-collections-browser-tests.mjs
scripts/demo-inventory.mjs
scripts/demo-presentation-tests.mjs
scripts/demo-public-browser-tests.mjs
src/app/(app)/_components/MobileShell.tsx
src/app/(app)/analytics/page.tsx
src/app/(app)/collections/_components/CollectionForms.tsx
src/app/(app)/collections/actions.ts
src/app/(app)/collections/page.tsx
src/app/(app)/dashboard/_components/DashboardForecast.tsx
src/app/(app)/dashboard/_components/PlanImportPanel.tsx
src/app/(app)/dashboard/_components/SalesPlanForm.tsx
src/app/(app)/dashboard/_components/SalesPlanImport.tsx
src/app/(app)/payroll/_components/CalculationCard.tsx
src/app/(app)/refunds/refund-document-actions.ts
src/app/(app)/sales/_components/SalesReportForm.tsx
src/app/(app)/sales/reports/[id]/page.tsx
src/app/demo/page.tsx
src/app/globals.css
src/app/install/page.tsx
src/app/manifest.ts
src/app/offline/page.tsx
src/components/SalesDynamicsChart.tsx
src/components/Sidebar.tsx
src/lib/imports/plan-import.ts
src/lib/payroll/change-request.ts
src/lib/payroll/role-compute.ts
src/lib/payroll/scheme-version.ts
src/lib/payroll/scheme.ts
src/lib/sales-report-rows.ts
src/lib/storage/local-provider.ts
```
