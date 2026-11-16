# Локальная разработка публичного демостенда

Рабочая ветка: **только `demo/branch-network-showcase`**. Основная спецификация —
[standalone-live-demo.md](standalone-live-demo.md). Эти инструкции не разрешают
публикацию, изменение `main`, рабочей БД или репозитория портфолио.

## Изолированный запуск

Используйте существующий checkout, без создания дополнительного worktree.
Проверьте `git branch --show-current` и `git status --short` до работы.
Нужны Node >=20.12 (проверен 24.22.1), npm и отдельная PostgreSQL 16.

Для локального теста на машине без существующего контейнера с этим именем:

```bash
docker run -d --name clubops-demo-postgres \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=clubops_demo_test \
  -p 127.0.0.1:55432:5432 postgres:16
```

`trust` допустим только в этом локальном тестовом контейнере с loopback-портом.
Для Railway нужен новый независимый проект, новая БД и отдельные credentials.
Имя БД обязано начинаться с `clubops_demo_`; БД с именем `railway` необходимо
заменить отдельной новой БД, а не переименовывать действующую рабочую БД.

Скопируйте `.env.demo.example` в игнорируемый `.env.demo.local` и заполните
`SESSION_SECRET` и `DEMO_CLEANUP_SECRET` двумя независимыми результатами
`openssl rand -hex 32`. Не выводите значения в логи и не коммитьте файл.
`DATABASE_URL`, `DEMO_DATABASE_NAME`, `DEMO_DATABASE_HOST` должны описывать
именно эту тестовую БД. Обычный `.env` не редактируется.

```bash
export npm_config_cache=/workspace/.npm
export XDG_CACHE_HOME=/workspace/.cache
npm ci --no-audit --no-fund
node scripts/demo-runtime.mjs prepare
node scripts/demo-runtime.mjs dev
```

`prepare` проверяет demo-гейт **до** генерации и миграций, генерирует PostgreSQL
Prisma client и применяет production-schema migrations только к явной демобазе.
Он не использует старый `src/lib/seed.ts`, не создаёт общего owner-пароля.
Fixture-набор создаётся транзакционно при первом входе посетителя.

Внутренняя проверка: `GET /api/health/ready` должен дать `200`, `status=ready`,
provider `postgresql`, совместимую схему. Вход — `/demo` на `APP_URL`.
Не создавайте пользовательские localhost-preview ссылки.

Для production-сборки, **после остановки dev-сервера**:

```bash
node scripts/demo-runtime.mjs build
node scripts/demo-runtime.mjs start
```

`build` и `dev` не запускаются одновременно: у них общий `.next`.
`start` работает и в production `NODE_ENV`: demo-гейт не основан на NODE_ENV.
Next выдаёт рекомендацию standalone-server при `next start` с `output=standalone`;
используемый полный checkout запуск проверен отдельно.

## Границы деморежима

- Требуются `DEMO_MODE=true`, `APP_ENVIRONMENT=standalone-demo`, точный
  `APP_URL`/`DEMO_ALLOWED_HOST`, точные имя и адрес демобазы, сильный session key.
  Конечный хост проверяется на запросах, а Origin — на создании/смене демосессии.
  Публично разрешён только явно заданный HTTPS `*.up.railway.app`; loopback — для QA.
- Live SMTP/ИИ/Telegram/ОФД/S3 credentials запрещены гейтом. Транспортные клиенты
  дополнительно блокируют внешние действия; регистрация, приглашения, account/security
  actions и изменение credentials закрыты на сервере. Scope/role/session проверки
  оригинального приложения сохранены.
- Один посетитель — одна синтетическая Company, три филиала и пять пользователей
  без паролей, с адресами `@visitor.invalid`. Cookie содержит случайный токен,
  в БД хранится HMAC. Доступ выдаётся обычными CompanyUserAccess/ClubUserAccess.
  Управляющему выдаётся ровно один филиал; переключение филиала меняет grant на сервере.
- TTL — два часа. Обычные Session.expiresAt ограничены этим сроком. Сброс удаляет
  старый tenant и создаёт новый. Пользовательские загрузки файлов отключены;
  подтверждающий PDF синтетический, генерируется из фиксированного текста и
  доступен через обычный scoped document route. Внешних рассылок/переводов нет.
- Лимиты: 6 новых наборов/сбросов на IP в час, 30 tenant одновременно,
  1000 строк на tenant в каждой company-scoped таблице. Admission и счётчики
  сериализованы в PostgreSQL, отказ БД не открывает вход. За reverse proxy
  требуется доверенный ingress, который заменяет входящий X-Forwarded-For.
- Очистка удаляет company-scoped строки, дочерние документы, пользователей и
  сессии; включает таблицы ОФД без Prisma FK. Прямые DB ошибки откатывают очистку.
  Нет пользовательских файлов для отдельного purge; PDF формируется динамически.
- Отчётный срез фиксирован: 1–15 ноября 2026. Только read-side reporting использует
  историческую дату. Авторизация, TTL, новые записи и реальное время не подменяются.
  На всех защищённых экранах есть бейдж; noindex включён, robots запрещает обход.

Периодическая очистка: cron выделенного демопроекта должен каждые 5 минут
отправлять `POST /api/demo/cleanup` с `Authorization: Bearer <DEMO_CLEANUP_SECRET>`.
Не помещайте значение в репозиторий/командную историю. Новые входы также очищают
истёкшие наборы. До публикации требуется проверить cron в целевом проекте.

## Проверки

```bash
node scripts/demo-tests.mjs
node scripts/demo-functional-tests.mjs
npm run pilot:health
npm run pilot:deploy-config
# В том же demo-окружении с реальным запущенным приложением:
DEMO_CHROMIUM_PATH=/usr/bin/chromium node scripts/demo-browser-tests.mjs
DEMO_CHROMIUM_PATH=/usr/bin/chromium node scripts/demo-finance-browser-tests.mjs
```

Браузерному runner нужен Playwright; в текущей cloud-машине он доступен через
NODE_PATH. В другой машине установите Playwright 1.62.1 в отдельный каталог QA и
добавьте этот каталог node_modules в NODE_PATH, либо используйте существующую
совместимую установку. Chromium можно задать через DEMO_CHROMIUM_PATH.
Скриншоты сохраняются в игнорируемом `artifacts/demo-browser`.

DB runner проверяет реальные PostgreSQL-транзакции, признание расходов штатным
доменным reader, суммы ОФД/счетов/бюджетов, синтетичность пользователей, изоляцию
очистки, серверные запреты SMTP/регистрации и отказ oversized insert.
Browser runner проверяет исходные экраны, пять ширин, два tenant, scoped read/write,
смену ролей, обычные оплату счёта и проверку расхода, reset/expiry и отсутствие
внешних browser-запросов. Backend outbound отдельно блокируется транспортами.

Подробное QA зарплат, авансов, бюджетов и возвратов с результатами и исправлениями:
[functional-qa-2026-11-16.md](functional-qa-2026-11-16.md). Демо-расход автоматически
получает синтетический PDF. В черновике возврата кнопка «Заполнить синтетический
комплект» создаёт вымышленные документы и нулевые тестовые реквизиты; обычные
проверки авторства, tenant и ролей остаются включёнными.

## Оставшиеся условия публичного запуска

Railway не развёрнут и ссылка на mironovich.pro не изменена. После локального QA
нужны отдельное решение владельца, новый проект/БД, публичный host и secrets,
проверка доверенного ingress/cron, повторение smoke на публичном HTTPS URL.
До этого стенд нельзя считать опубликованной и принятой публичной версией.

Ограничения исходной системы не скрываются: ОФД хранит также gross-показатели;
нетто и прогноз утверждённого демосреза показаны отдельно и подписаны. Электронное
подписание и live банковские интеграции не обещаются. Дополнение тройной сверки
показывает **расчётные эталоны**, а не выдаёт их за импортированную CRM/банк.
