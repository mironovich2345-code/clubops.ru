# Развёртывание CLUB-OPS на российской инфраструктуре

Руководство по переносу приложения с Railway на хостинг в РФ: сервер приложения,
PostgreSQL, объектное хранилище (S3) и (в перспективе) российский AI/OCR‑провайдер.

> Railway‑конфигурация (`railway.json`) сохранена и продолжает работать. Этот
> документ описывает **альтернативный** способ развёртывания — через Docker.

---

## 1. Архитектура

| Компонент            | Railway (сейчас)        | РФ‑инфраструктура (цель)                          |
|----------------------|-------------------------|--------------------------------------------------|
| Сервер приложения    | Nixpacks на Railway     | Docker‑контейнер (`Dockerfile`) на VM в РФ        |
| База данных          | Railway PostgreSQL      | PostgreSQL в РФ (управляемый или в контейнере)    |
| Файлы документов     | Локальный диск (эфемерный) | S3‑совместимое объектное хранилище в РФ        |
| AI/OCR               | OpenAI (dev/test)       | Российский провайдер (`ru_ai`) или выключено      |

Приложение выбирает поведение по переменным окружения:
`STORAGE_PROVIDER` (local/s3) и `AI_PROVIDER` (mock/openai/ru_ai).

---

## 2. Рекомендуемые площадки в РФ

Любой из провайдеров закрывает все три потребности (VM + PostgreSQL + S3):

- **Yandex Cloud** — Compute Cloud (VM), Managed Service for PostgreSQL,
  Object Storage. S3‑endpoint: `https://storage.yandexcloud.net`, регион `ru-central1`.
- **Selectel** — облачные серверы, Managed Databases (PostgreSQL),
  Object Storage. S3‑endpoint вида `https://s3.ru-1.storage.selcloud.ru`.
- **VK Cloud** — Cloud Servers, Databases (PostgreSQL), Object Storage.
  S3‑endpoint вида `https://hb.ru-msk.vkcloud-storage.ru`.

Все три предоставляют S3‑совместимый API, который поддерживает наша абстракция
хранилища (`STORAGE_PROVIDER=s3`).

---

## 3. PostgreSQL

### Вариант А — управляемый PostgreSQL (рекомендуется)
1. Создайте кластер PostgreSQL 16 у выбранного провайдера (в РФ‑регионе).
2. Создайте базу и пользователя, разрешите подключение с сервера приложения.
3. Соберите строку подключения:
   ```
   DATABASE_URL="postgresql://USER:PASSWORD@HOST:6432/DBNAME?sslmode=require"
   ```
   (порт и `sslmode` уточните у провайдера; у управляемых БД обычно нужен SSL).

### Вариант Б — PostgreSQL в контейнере
Используйте сервис `postgres` из `docker-compose.production.yml` (данные хранятся
в томе `club_ops_pgdata`). Подходит для старта; для нагруженного прода
предпочтительнее управляемый кластер с резервным копированием.

### Миграции
Схема для PostgreSQL и её миграции лежат в `prisma/production/`. Применяются
командой (запускается автоматически при старте контейнера):
```
npm run prisma:migrate:deploy
```
После изменения модели данных: `npm run prisma:sync-prod` (регенерирует
`prisma/production/schema.prisma`) и создайте соответствующую миграцию.

---

## 4. Объектное хранилище (S3)

1. Создайте приватный бакет (например `club-ops-documents`) в РФ‑регионе.
2. Создайте сервисный аккаунт / ключ доступа с правами на чтение/запись в бакет.
3. Заполните переменные:
   ```
   STORAGE_PROVIDER="s3"
   S3_ENDPOINT="https://storage.yandexcloud.net"   # пример: Yandex
   S3_REGION="ru-central1"
   S3_BUCKET="club-ops-documents"
   S3_ACCESS_KEY_ID="..."
   S3_SECRET_ACCESS_KEY="..."
   ```

**Доступ к файлам.** Бакет держите **приватным**. Приложение отдаёт документы
через защищённые маршруты (`/api/invoices/[id]/file` и т. п.) с проверкой прав —
прямые ссылки на бакет и учётные данные наружу не попадают. Подписанные ссылки
(`getSignedUrl`) реализованы в S3‑провайдере, но по умолчанию не используются.

> Реализация хранилища: `src/lib/storage/` (`local` и `s3` провайдеры),
> подключена в `src/lib/{invoice,expense,refund}-storage.ts`.

---

## 5. Переменные окружения

Скопируйте шаблон и заполните реальными значениями:
```
cp .env.production.example .env.production
```

Ключевые переменные (полный список — в `.env.production.example`):

| Переменная             | Назначение                                              |
|------------------------|---------------------------------------------------------|
| `DATABASE_URL`         | строка подключения к PostgreSQL                         |
| `SESSION_SECRET`       | ключ подписи сессий — `openssl rand -hex 32`            |
| `APP_URL`              | публичный адрес приложения                              |
| `STORAGE_PROVIDER`     | `s3` (прод) или `local`                                 |
| `S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY` | доступ к объектному хранилищу |
| `AI_PROVIDER`          | пусто/`mock` (по умолчанию), `ru_ai`, или `openai` (dev/test) |
| `OPENAI_API_KEY`       | только dev/test — не для персональных данных            |
| `RU_AI_ENDPOINT` / `RU_AI_API_KEY` | российский AI/OCR (заглушка)                |

`SESSION_SECRET`, `DATABASE_URL` и `S3_SECRET_ACCESS_KEY` — секреты. Храните их в
секрет‑менеджере провайдера или в `.env.production` с правами `600`, никогда не
коммитьте.

---

## 6. Запуск через Docker

Сборка и старт всего стека (приложение + PostgreSQL):
```
cp .env.production.example .env.production   # заполнить значения
docker compose -f docker-compose.production.yml up -d --build
```

С опциональным reverse‑proxy nginx (TLS‑терминация):
```
docker compose -f docker-compose.production.yml --profile nginx up -d --build
```

При старте контейнер приложения:
1. применяет миграции — `npm run prisma:migrate:deploy`;
2. запускает сервер — `next start` на `PORT` (по умолчанию 3000).

**Проверка живости:** `GET /api/health` → `{ "status": "ok", ... }`. Этот эндпоинт
используется в `HEALTHCHECK` контейнера и может быть целью балансировщика.

Только приложение (например, БД и хранилище — управляемые сервисы):
```
docker build -t club-ops:latest .
docker run -d --env-file .env.production -p 3000:3000 club-ops:latest
```

---

## 7. Резервное копирование

- **PostgreSQL.** Для управляемого кластера включите автоматические бэкапы и
  PITR у провайдера. Для контейнера — регулярный `pg_dump`:
  ```
  docker compose -f docker-compose.production.yml exec postgres \
    pg_dump -U club_ops club_ops | gzip > backup_$(date +%F).sql.gz
  ```
  Храните копии в РФ, шифруйте, проверяйте восстановление.
- **Объектное хранилище.** Включите версионирование бакета и/или
  кросс‑бакетную репликацию средствами провайдера. Документы — первичные данные,
  в БД хранятся только ключи (`storageKey`).
- Зафиксируйте частоту и срок хранения копий в политике (см. `COMPLIANCE_RU.md`).

---

## 8. Рекомендации по файловому хранилищу

- В продакшене используйте `STORAGE_PROVIDER=s3` — локальный диск эфемерен и не
  масштабируется. Если всё же `local`, обязателен персистентный том (в compose —
  `club_ops_uploads`).
- Бакет — приватный; доступ только через приложение.
- Ограничение размера файла — 10 МБ (на уровне приложения и nginx `client_max_body_size`).
- Разделяйте бакеты/окружения (prod/staging), чтобы не смешивать данные.

---

## 9. Переход с Railway

1. Поднимите PostgreSQL и S3 в РФ, заполните `.env.production`.
2. Перенесите данные БД: `pg_dump` из Railway → `pg_restore`/`psql` в РФ‑кластер
   (миграции уже применены — переносите данные, схема совпадает).
3. Перенесите файлы: выгрузите содержимое Railway (если файлы ещё есть — диск
   эфемерный!) и загрузите в S3‑бакет, сохранив ключи `invoices/…`, `expenses/…`,
   `refunds/…`. Для новых загрузок ничего делать не нужно.
4. Разверните приложение в РФ (раздел 6), проверьте `/api/health` и вход.
5. Переключите DNS на новый адрес.
6. Railway‑конфигурацию пока **не удаляйте** — оставьте как запасной вариант,
   пока РФ‑развёртывание не подтверждено в бою.

---

## 10. Чек‑лист готовности

- [ ] PostgreSQL в РФ, `DATABASE_URL` задан, миграции применяются.
- [ ] Приватный S3‑бакет в РФ, `STORAGE_PROVIDER=s3` и `S3_*` заданы.
- [ ] `SESSION_SECRET` сгенерирован (`openssl rand -hex 32`).
- [ ] `AI_PROVIDER` = mock или ru_ai (OpenAI — только dev/test).
- [ ] `/api/health` отвечает 200.
- [ ] Резервное копирование БД и хранилища настроено и проверено.
- [ ] Юридические документы и политика обработки ПДн готовы (`COMPLIANCE_RU.md`).
