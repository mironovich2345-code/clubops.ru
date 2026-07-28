# Multi-account — отчёт

Дата: 2026-07-28 · Ветка: main.

Реализация: [multi-account-session-model.md](../architecture/multi-account-session-model.md).
Угрозы: [multi-account-threat-model.md](../security/multi-account-threat-model.md).
Тесты: `npm run pilot:multi-account-sessions` — **18/18**.

## Что доставлено (технически завершено)

- Аддитивная миграция (dev+prod): `AccountSessionContainer` + `StoredAccountSession`; `User`/`Session`
  не изменены.
- Сервис `account-container.ts`: create/attach/resolve-active/switch/remove/logout-all/list +
  cookie-обёртки; ownership + validity + scope-очистка.
- `getValidSession`: контейнер главный при наличии; иначе legacy (zero-regression).
- Логин: add-account режим (`/login?mode=add-account`), attach после `createSession`,
  container-aware `revokeCurrentSession`.
- Server actions: startAddAccount / switch / remove / logout-all (audit + revalidate + redirect).
- UI: `AccountSwitcher` (текущий + список + add/remove/logout-all, статус «Требуется вход»).

## Тестовое покрытие (18)

resolve-active, switch, идемпотентность, ownership (чужой storedId), expired→require-login,
re-login-updates-one, revoked-not-activatable, blocked-user-not-activatable, remove-one-keeps-others,
remove-active-repoints, logout-all, cross-container-isolation + 6 source-guard (chokepoint, ownership,
validity gate, HMAC-only, scope-cookie clear, httpOnly/logout).

## Осталось на реальном устройстве (§28) / долг

- Ручной прогон [iphone-navigation-multi-account-checklist.md](iphone-navigation-multi-account-checklist.md):
  PWA persistence, bfcache/back после logout, offline/expiry, add→switch→close→reopen.
- «Управление аккаунтами» как отдельная страница (сейчас — sheet-действия) — опционально.
- Desktop dropdown-вариант switcher (сейчас единый Sheet и на desktop) — полировка.
- Unsaved-form warning / block-switch-during-upload (§9) — не внедрено в этот этап (долг).
