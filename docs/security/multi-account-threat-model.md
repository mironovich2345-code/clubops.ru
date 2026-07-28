# Multi-account — модель угроз (§27)

Скоуп: несколько независимых аккаунтов на одном устройстве через
[AccountSessionContainer](../architecture/multi-account-session-model.md). Задача — строгая tenant
isolation и отсутствие перекрёстных утечек между аккаунтами.

## Инварианты и как они обеспечены

| # | Угроза | Защита | Тест |
|---|---|---|---|
| 1 | Переключиться на stored session чужого контейнера | `switch/remove` проверяют `stored.containerId === containerId` (ownership) | MA4 |
| 2 | Подмена `storedSessionId` в форме | id из формы всегда проверяется на принадлежность контейнеру из cookie; не доверяем submit | MA4 |
| 3 | Активация отозванной session | активный аккаунт проходит тот же `isValid()` (revokedAt/expiresAt/user.isActive) | MA7 |
| 4 | Активация заблокированного User | `isValid()` требует `user.isActive` | MA8 |
| 5 | После switch server actions используют старого User | switch меняет `activeStoredSessionId`; `getValidSession` (единый chokepoint) резолвит нового; `revalidatePath("/","layout")` + полный reload | MA2, MA-SRC1 |
| 6 | Данные прежнего User в client cache | полный reload после switch; финансовые страницы `force-dynamic` (не кешируются SW — WAVE 1); scope-cookies очищаются | MA-SRC5 |
| 7 | Компания/клуб аккаунта A видны в B | scope-cookies `scope_company`/`scope_club` очищаются при **любой** смене аккаунта (add/switch/remove/logout) | MA-SRC5 |
| 8 | Документы прежнего tenant из browser history | api-роуты документов ре-проверяют доступ по текущему user (IDOR закрыт ранее); ответы не кешируются | (существующие IDOR-suite) |
| 9 | back/bfcache раскрывает authenticated контент | authenticated страницы `force-dynamic`; переключение = полный reload | manual (§28) |
| 10 | Logout одного отзывает остальные | `removeAccount` трогает только выбранный stored + его Session | MA9 |
| 11 | Logout all не отзывает всё | `logoutAllAccounts` revoke контейнер + все stored + их Session + legacy cookie | MA11 |
| 12 | Утечка между контейнерами при remove/logout | операции ограничены `containerId` из cookie | MA12 |
| 13 | Сырой токен контейнера в БД/логах | хранится только `hashToken(token)` (HMAC), cookie httpOnly | MA-SRC4 |
| 14 | add-account привязан к чужому контейнеру | контейнер берётся из httpOnly cookie текущего браузера; нельзя указать чужой | MA-SRC2 |
| 15 | CSRF на switch/remove/logout | server actions (same-origin POST, как весь проект); container-cookie httpOnly — JS не читает | design |
| 16 | Session fixation | switch не создаёт/не переиспользует чужой токен; add-account = новый OTP-login → новый `Session` | design |
| 17 | Секреты в audit | audit пишет action/entity/userId — без токенов/паролей | MA-SRC6 |
| 18 | Container token rotation | контейнер истекает (30d) + revoke на logout-all; при пустом контейнере cookie очищается | MA10/11 |

## Остаточные проверки (только на реальном устройстве, §28)

bfcache/back на iOS Safari; PWA standalone persistence контейнера; отсутствие чувствительных данных
после logout; поведение при офлайне/истечении. См.
[iphone-navigation-multi-account-checklist.md](../testing/iphone-navigation-multi-account-checklist.md).

## Не входит в этап

impersonation / «посмотреть как пользователь» (§3) — НЕ реализовано умышленно. Свободного select
роли нет; `User.role` не меняется; переключается фактический User/Session.
