# Multi-account session model (device-local)

Как CLUB-OPS позволяет держать несколько независимых аккаунтов на одном устройстве, не ломая
существующую одиночную сессию.

## Раньше: одна сессия

Cookie `club_ops_session` (httpOnly/sameSite lax/secure(prod)/30d) → строка `Session`
(`tokenHash @unique`, HMAC-SHA256(SESSION_SECRET); сырой токен только в cookie). Единственная
точка резолва — `getValidSession` (`src/lib/session.ts`). Scope (компания/клуб) — отдельные
cookies `scope_company`/`scope_club` (не в БД). Логин — двухшаговый: пароль + обязательный email-OTP;
`Session` создаётся только в `verifyCurrentChallenge` → `createSession`.

## Почему не несколько cookies с одним именем

Браузер адресует cookie по имени — два `club_ops_session` в одном origin невозможны. Разные имена
дали бы N независимых auth-грантов без «активного» указателя, без атомарного remove/logout-all, без
изоляции scope. Нужен **контейнер**, который ссылается на несколько `Session` и выбирает активную.

## Модель (аддитивная, `User`/`Session` не изменены)

Две таблицы (dev SQLite + prod PostgreSQL, scalar id, без FK — прецедент `SettingsPinSession`):

- **`AccountSessionContainer`** — один на браузер. `tokenHash @unique` (HMAC нового httpOnly
  cookie `club_ops_accounts`), `activeStoredSessionId?`, `expiresAt`, `revokedAt?`, метаданные.
- **`StoredAccountSession`** — один припаркованный аккаунт: `containerId`, `userId`, `sessionId`
  (ссылка на существующий `Session.id`), `displayOrder`, `lastUsedAt`, `revokedAt?`,
  `@@unique([containerId, userId])`.

Браузер хранит **только** случайный токен контейнера в httpOnly cookie. Пароли/чужие session-токены/
список аккаунтов в localStorage/IndexedDB **не хранятся**.

## Единственная нагрузочная правка: `getValidSession`

```
1. resolveContainerAuth(): есть валидный container-cookie?
   да  → контейнер ГЛАВНЫЙ: активная StoredAccountSession → её Session → тот же isValid() →
         вернуть {session,user}. Если активная истекла → null (требуется вход, §7), БЕЗ fallback
         на другой аккаунт.
   нет → legacy: club_ops_session → Session → isValid() (нулевая регрессия для одиночных).
```
Downstream (`getCurrentUser`→`getCurrentAccessContext`→`requirePageAccess`, `recordAudit`, scope) не
меняется — chokepoint один. Активный аккаунт резолвится по `Session.id` (не по токену), поэтому
переключение не требует переписывания cookie.

## Жизненный цикл

- **Первый вход:** только `club_ops_session` (контейнер не создаётся — legacy путь). Zero-regression.
- **Добавить аккаунт (`§5`):** `startAddAccountAction` снимает текущий аккаунт в контейнер
  (`ensureCurrentAccountStored`, создаёт контейнер при первом использовании) + ставит intent-cookie
  → `/login?mode=add-account`. После OTP-verify `completeLoginAttach` добавляет новый аккаунт и
  делает его активным (остальные не отзываются). Audit `account.added_to_device`.
- **Переключение (`§6`):** `switchAccount(storedId)` — ownership (`stored.containerId===container`),
  сессия не отозвана/не истекла, user активен → `activeStoredSessionId=stored`; scope-cookies
  очищаются; `revalidatePath("/","layout")` + redirect. Полный reload → нет смешения данных.
- **Истёкшая (`§7`):** активная истекла → `getValidSession`=null → вход; статус «Требуется вход» в
  switcher; re-login обновляет только этот аккаунт (`attachToExistingContainer`).
- **Удалить с устройства (`§8`):** `removeAccount` — revoke stored + его `Session`; если активная —
  переставить на следующую; пусто → revoke контейнер + очистить cookie. Остальные не тронуты.
- **Выйти из всех (`§8`):** `logoutAllAccounts` — revoke контейнер + все stored + их `Session` +
  очистить container/scope cookies; плюс legacy `signOut` (на случай отсутствия контейнера).
- **Обычный «Выйти»:** `revokeCurrentSession` container-aware — удаляет только активный аккаунт
  (не трогает stale cookie другой сессии).

## Файлы

`src/lib/account-container.ts` (сервис), `src/lib/session.ts` (chokepoint + container-aware logout),
`src/lib/login-challenge.ts` (attach после createSession), `src/app/(app)/account-actions.ts`
(server actions), `src/app/(app)/_components/AccountSwitcher.tsx` (UI), `src/app/login/page.tsx`
(add-account режим). Тесты: `scripts/pilot-multi-account-sessions.mjs` (18). Угрозы:
[multi-account-threat-model.md](../security/multi-account-threat-model.md).
