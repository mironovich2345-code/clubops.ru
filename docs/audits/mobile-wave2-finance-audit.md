# WAVE 2 — аудит мобильной готовности финансового контура

Дата: 2026-07-28 · Ветка: main · Скоуп: **только** расходы, счета, возвраты, их документы,
согласования по ролям, sticky-actions/клавиатура. Вне скоупа: зарплата, сотрудники, ОФД,
аналитика, бюджеты (кроме role-логики перерасхода §6/§23), календарь платежей, новые функции.

Аудит проведён по реальному коду (4 параллельных обхода: expenses / invoices / refunds /
shared+overspend). До завершения аудита правки кода не вносились (§1).

---

## 0. Что уже даёт WAVE 1 (не переделывать)

- `globals.css:158-165` — `@media(max-width:767px){ input,select,textarea,.input{font-size:16px} }`.
  → **Риск «поля <16px / iOS auto-zoom» закрыт для всех form-controls.** Не флагать повторно.
- `html,body{max-width:100%;overflow-x:clip}` — страница не скроллится вбок; но **слишком
  широкий блок обрезается**, если у него нет своего `overflow-x-auto`. Это меняет характер
  дефекта: не «страница едет», а «контент клипается/теряется».
- Утилиты `.pt-safe/.pb-safe/.pb-safe-actions/.has-sticky-actions/.pb-bottom-nav/.break-anywhere/
  .min-w-0-safe` определены, **но ни одна финансовая страница их не использует** — это WAVE-1
  фундамент, который WAVE 2 должна начать применять.

---

## 1. Ключевой вывод: нет слоя общих финансовых компонентов

Таблицы, загрузка файлов, бейджи, формы — **захардкожены на каждой странице**. Единственные
общие примитивы: класс `.input`, `PageHeader.tsx`, набор CSS-утилит из WAVE 1.

| Примитив | Состояние сейчас | Нужно для WAVE 2 |
|---|---|---|
| Таблица/список | `<div overflow-x-auto><table min-w-full>` копипастой на каждой странице; у expenses-list даже `overflow-hidden` → **клип без скролла** | Mobile-карточка (одна на контур) + сохранить desktop-таблицу |
| Фильтры | Инлайновые pill-ссылки / `<select>`; у refunds фильтров нет вовсе | Filter **sheet** + активные chips |
| Загрузка файлов | 5 разных компонентов (Expense/Invoice/Refund/Payroll/Attachments); нет `capture`, нет прогресс-бара, retry только для AI | Единый upload: camera/library/PDF, прогресс, retry, delete-before-submit, анти-двойной-tap |
| Просмотр документа | **Нет.** `<a target="_blank">` → сырой файл в новой вкладке; webp/HEIC форс-download | Единый full-screen viewer (JPG/PNG/PDF), zoom, fit-width, safe-area |
| Modal/Dialog/Sheet | **Нет ни одного.** Подтверждения через `window.prompt/confirm` | Bottom-sheet + full-screen sheet (keyboard-safe) |
| Sticky action bar | CSS-утилиты есть, **не используются**; кнопки инлайн внизу формы | Единый `StickyActions` (safe-area, keyboard-aware, primary full-width) |
| Пагинация | **Нет нигде** — списки грузят весь набор | Пагинация/lazy для списков + ленивые секции документов/истории |
| Form-controls | Только класс `.input` (16px на mobile, но `py-2`≈38px < 44px) | Touch-target ≥44px для действий; labels над полями (уже так) |
| Status badge | Реализован заново на каждой странице | Общий `StatusBadge` (текст + тон, не только цвет) |

**Следствие для плана:** WAVE 2 начинается с shared-компонентов (commit #2), затем применяет их
по контурам. Это не «responsive CSS», а введение отсутствующего слоя.

---

## 2. Поддерживаемые ширины (§2)

Проверяем: 320×568, 360×800, 375×667, 390×844, 393×852, 414×896, 430×932, 768×1024, 1440×900.
Устройства: iPhone SE / 12-14 / Pro-Max, Android Chrome, Safari iOS, PWA standalone, landscape.
Критичная нижняя граница — **320px** (≈288px контента при `px-4`). Планшет 768px — допускается
2 колонки. Desktop 1440px — таблицы сохраняются без изменений.

---

## 3. РАСХОДЫ — постранично

Файлы: `expenses/page.tsx` (список+таблица инлайн), `expenses/simple/SimpleExpenseForm.tsx`
(создание), `expenses/[id]/page.tsx` + `_components/{ExpenseEditForm,ExpenseAttachments,
WorkflowActions,CancelExpenseForm}.tsx`.

| # (§1) | Дименсия | Список | Создание | Деталь |
|---|---|---|---|---|
| 1 | Общий h-scroll | нет (body clip) | нет | нет |
| 2 | Локальный h-scroll | **да** — 7-col таблица, `overflow-hidden` → **клип** (`page.tsx:214-215`) | нет | нет |
| 3 | Блоки за viewport | таблица; `IpCashFactBlock grid-cols-2` длинные RU-подписи (`L420`) | нет | header `justify-between` без wrap (`L146`) |
| 4 | Таблицы → карточки | **список расходов** (Дата/Тип/Статья/Контрагент/Сумма/Кто/Действия); analytics-drilldown 9-col (вне скоупа) | — | — |
| 5 | Мелкие поля | — (16px) | — | кнопки WorkflowActions `py-2`≈36px < 44px (`Btn L28`) |
| 6 | Клавиатура перекрывает | — | **да** — submit инлайн внизу длинной формы (`L276`), не sticky | — |
| 7 | Наложение sticky | — | — | — |
| 8 | Модалка не влезает | `window.prompt` для причин | — | `window.prompt/confirm` (return/cancel/remove) |
| 9 | Длинный текст ломает | nowrap-ячейки (`L239/240/253/256`) | filename `break-all` OK | filename `truncate` OK |
| 10 | Непонятно гл. действие | «Открыть» `text-xs` слаб | submit есть, но далеко внизу | кнопки wrap OK, но роль-контекст не показан |
| 11 | Дублирование действий | — | — | — |
| 12 | Тяжёлая загрузка | **нет пагинации** — весь scope рендерится | локальные object-URL OK | нет lazy истории |
| 13 | Не пройти одной рукой | боковой скролл таблицы | скролл до submit | — |
| 14 | Убрать с mobile-list | Контрагент, «Кто добавил» → в деталь | — | — |
| 15 | Перенести в detail | тех-поля, автор | — | — |

**Карточка расхода (mobile) должна показывать:** статья/тип · сумма · клуб · дата · статус ·
кто должен действовать · наличие документов · перерасход/проблема · главное действие/menu.
Убрать: контрагент, автор, тех-таймстемпы.

**Фильтры расходов:** сейчас только 4 pill-бакета по статусу. Нужен sheet: статус · клуб ·
период · категория · автор · только проблемные · требующие действия. Активные — chips.

**Создание:** форма уже `grid-cols-1 lg:grid-cols-2` (стек на mobile ✓), порядок близок к §5.
Нужно: sticky «Создать расход» (safe-area, keyboard-aware, анти-повтор), подсказка «После
создания расход будет отправлен региональному директору». Idempotency — `draftIdRef` уже есть.

---

## 4. ПЕРЕРАСХОД — role-логика (§6) — КРИТИЧНО, сейчас НАРУШЕНА

Перерасход детектится при создании расхода (`expenses/actions.ts:319-329`): `evaluateExpenseBudget`
→ статус `waiting_budget_approval` + строка `BudgetApprovalRequest`. **Согласование живёт в модуле
budgets**, но role-логика — общая auth-функция и явно в скоупе WAVE 2 (§6/§23).

Текущий код `src/lib/auth.ts:166-174`:
```ts
export const GD_OVERRUN_CATEGORIES = ["advertising", "salary"];
export function canApproveBudgetOverrunForCategory(roles, category) {
  if (roles.includes("owner") || roles.includes("regional_director")) return true; // ЛЮБАЯ категория
  if (roles.includes("general_director")) return GD_OVERRUN_CATEGORIES.includes(category);
  return false;
}
```
Категория рекламы: ключ `advertising`, лейбл «Реклама» (`src/lib/expenses.ts:47`).

**Требование §6:** owner согласует ЛЮБОЙ перерасход, **кроме «Реклама»**; рекламный перерасход
согласует **только ГД**.

| Роль | Реклама сейчас | Реклама по §6 | Прочие категории |
|---|---|---|---|
| owner | ✅ разрешено ❌ | **запретить** | разрешено ✓ |
| regional_director | ✅ разрешено ❌ | запретить (реклама → GD-only) | по текущей клуб-модели ✓ |
| general_director | ✅ разрешено ✓ | **разрешено** | (whitelist adv+salary) |

**Что менять (server-side, безопасность):**
1. `src/lib/auth.ts:166-174` — `canApproveBudgetOverrunForCategory`: если `category==="advertising"`
   → разрешить **только** `general_director` (исключить owner И regional_director); иначе owner
   разрешён (RD — по существующему клуб-скоупу). Единая точка, через неё идут все пути.
2. `budgets/actions.ts:107-127` `loadDecidableRequest` — enforcement для **approve (:144) и
   reject (:176)**. Решить: reject рекламного перерасхода тоже GD-only (сейчас да). Клуб-скоуп
   `getManageableClubIds` и self-approval блок — оставить.
3. `budgets/page.tsx:96-102` `canDecide` + `RequestActions.tsx` — UI-зеркало (не граница
   безопасности): owner видит кнопку на обычном перерасходе, НЕ видит на рекламе; ГД видит на
   рекламе. Прямой action/API owner по рекламе — запрещён guard'ом.

**Тесты (§23):** owner НЕ согласует рекламу (UI скрыт + server 403); ГД согласует рекламу; owner
согласует обычный перерасход; guard блокирует прямой owner-вызов по рекламе; IDOR/клуб-скоуп.

> Примечание: `budgets.ts:16-17` объявляет `REGIONAL_MAX_OVER_PERCENT=5` /
> `OWNER_DOUBLE_CONFIRM_PERCENT=20`, но они **нигде не используются** — пороговая модель не
> реализована. В WAVE 2 не вводим (вне §6); зафиксировано для WAVE 3.

**Mobile-деталь перерасхода** должна показывать: сумма бюджета · сумма перерасхода · категория ·
кто должен согласовать · комментарий · статус. Сейчас — read-only строка `text-xs` (`page.tsx:191-196`).

---

## 5. СЧЕТА — постранично

Файлы: `invoices/page.tsx` (3 таблицы + обе upload-формы инлайн), `_components/{InvoiceFilters,
InvoiceUpload,InvoiceEditForm,InvoiceDataReview,CancelInvoiceForm,HistoricalInvoiceForm}.tsx`,
`[id]/page.tsx`. (`InvoiceAnalytics.tsx` — мёртвый, не импортируется.)

| # | Дименсия | Список | Создание+AI | Деталь (вкл. бухгалтер) |
|---|---|---|---|---|
| 1 | Общий h-scroll | нет | нет | нет |
| 2 | Локальный h-scroll | **да ×3** таблицы `min-w-full`+`overflow-x-auto` (`L286/325/360`), `whitespace-nowrap` | нет | нет |
| 3 | Блоки за viewport | elevated-cards `grid-cols-2` (`L166`) тесно | реквизиты `flex-wrap` длинный р/с без break (`L286`) | header title+back без wrap (`L183`); `ReadField`/filename без `break-anywhere` |
| 4 | Таблицы → карточки | **3 списка** (за период / очередь проверки / просроченные) | — | — |
| 5 | Мелкие поля | «Открыть» `text-xs px-2.5 py-1` | — (16px) | — |
| 6 | Клавиатура перекрывает | — | форма инлайн (на списке) | AI-поля бухгалтера + submit не sticky |
| 7 | Наложение sticky | — | — | — |
| 8 | Модалка не влезает | — | — | return-textarea инлайн |
| 9 | Длинный текст ломает | nowrap-ячейки | р/с/БИК без break | назначение/р/с/filename без `break-anywhere` |
| 10 | Гл. действие непонятно | «Открыть» слаб | «Создать счёт» есть | нужно «кто должен действовать» |
| 11 | Дублирование | 2 upload-формы на списке | — | — |
| 12 | Тяжёлая загрузка | **нет пагинации** (3 таблицы load-all) | AI processing OK | — |
| 13 | Одной рукой | скролл таблиц | — | длинная форма редактирования |
| 14 | Убрать с mobile-list | все реквизиты, полный AI JSON, длинное назначение, тех-таймстемпы | — | — |
| 15 | Перенести в detail | реквизиты, назначение | — | — |

**Карточка счёта:** контрагент · сумма · номер/дата · срок оплаты · клуб · статус · AI-warning ·
кто действует · главное действие/menu. Убрать из списка: банк-реквизиты, AI JSON, длинное
назначение, тех-timestamps.

**Форма создания (mobile flow §9):** клуб → файл → предпросмотр → доступные поля → статус AI
processing → «Создать счёт» → подсказка об отправке регионалу. Guards `needs_review`/confidence/
`clientSubmissionId`/idempotency — **уже есть** (`InvoiceUpload.tsx`), сохранить.

**Деталь (§10):** бухгалтеру редактировать AI-поля удобно на mobile — форма уже
`grid-cols-1 md:grid-cols-2` (1 колонка на телефоне ✓). Добавить: `break-anywhere` для ИНН/КПП/
р/с/БИК/назначение; sticky-actions (Согласовать/Вернуть/Оплачено/Сохранить), не под клавиатурой;
читаемые confidence/warnings (уже пилюли). Payment guard `invoicePaymentBlockedReason` — сохранить.

---

## 6. ВОЗВРАТЫ — постранично (самый критичный сценарий)

Файлы: `refunds/page.tsx` (список+очереди), wizard `refunds/new/page.tsx`→`NewRefundStarter`,
`new/[id]/page.tsx`→`RefundDraftEditor`, `new/[id]/details/page.tsx`→`{MembershipCalcForm,
PtCalcForm}`, `RefundWorkflow.tsx`, `[id]/page.tsx`, `RefundPayForm.tsx`, `RefundEditForm.tsx` (v1).

| # | Дименсия | Список | Wizard | Документы (4) | Расчёт | Деталь |
|---|---|---|---|---|---|---|
| 1 | Общий h-scroll | нет | нет | нет | нет | нет |
| 2 | Локальный h-scroll | **да** — до 4 таблиц 6-col `whitespace-nowrap` (`L84-85,99-103`) | нет | нет | нет | нет |
| 3 | Блоки за viewport | — | — | thumb 56px + break-all в узкой колонке | — | header без wrap (`L82`) |
| 4 | Таблицы→карточки | **список + очереди** | — | — | — | — |
| 5 | Мелкие поля | «Открыть» `text-xs px-2.5 py-1` | nav-кнопки `py-2`<44px | **Открыть/Заменить/Удалить `text-xs`** рядом → мис-тапы | — | action `py-2`<44px |
| 6 | Клавиатура перекрывает | — | **да** — nav-бар под полями, не sticky (`RefundDraftEditor:221`) | — | **да** — «Рассчитать» под инпутами (`:86`) | — |
| 7 | Наложение sticky | — | нет sticky вовсе | — | — | — |
| 8 | Модалка не влезает | — | — | `window.prompt` причина удаления | — | return-textarea инлайн |
| 9 | Длинный текст ломает | nowrap-ячейки | — | filename char-by-char | суммы OK | filename в `li` wrap |
| 10 | Гл. действие непонятно | «Открыть» слаб | **нет stepper «шаг N из K»** | — | итог `text-xl` виден ✓ | роль-контекст не показан |
| 11 | Дублирование | 4 таблицы-очереди | — | — | — | — |
| 12 | Тяжёлая загрузка | **нет пагинации** | — | — | — | — |
| 13 | Одной рукой | скролл таблиц | скролл к nav | 3 мелкие кнопки | — | — |
| 14 | Убрать с mobile-list | клуб, дата создания → деталь | — | — | — | — |
| 15 | Перенести в detail | тех-поля | — | — | — | — |

**Важная бизнес-деталь:** «4 документа» по факту = **договор (стр.1) + договор (стр.3 / стр.2 для
ПТ) + заявление на возврат + чек оплаты** (`refund-documents.ts:20-31`). Отдельного документа
«реквизиты» нет — реквизиты это **форма**, не файл. В аудите/UI спецификации §13 «реквизиты»
трактуем как поля, а не 4-й файл. Бизнес-логику не менять — только упростить UI.

**Карточка возврата:** ФИО · сумма · тип АБ/ПТ · клуб · дата заявления · срок возврата · статус ·
документы · кто действует · проблема · действие/menu.

**Wizard (§12) — целевая структура из 6 шагов** (бизнес-логику сохранить, UI упростить):
1. Клиент и клуб · 2. Тип возврата · 3. Исходные данные · 4. Расчёт · 5. Документы · 6. Проверка
и создание. Добавить видимый stepper, sticky nav (Назад/Далее/Создать), keyboard-safe, не терять
файлы. Idempotency — server compare-and-set (`RefundWorkflow.tsx:18-27`), сохранить.

**Документы (§13):** вертикальный список на mobile (не 2×2 при 320px; 2 колонки — только tablet).
Каждый слот: статус · preview · replace · delete-до-submit · progress · retry · читаемая ошибка.
Кнопки — ≥44px, разнести Удалить от Заменить.

**Расчёт (§14):** уже одна колонка, итог `text-xl`, без raw JSON ✓. Оставить формулу/промежуточные/
итог/warnings/manual-correction; sticky «Рассчитать/Сохранить» не под клавиатурой.

---

## 7. Документ-viewer и upload (§16/§17) — построить с нуля

- **Viewer:** сейчас `<a target="_blank">` на сырой файл (`ExpenseAttachments.tsx:93-98`). webp/HEIC
  форс-download (`expense-document-storage.ts:109-111`). Нужен единый адаптивный viewer:
  full-screen sheet/page, zoom изображения, fit-to-width, download/open-external, close, safe-area,
  без h-overflow, loading/error/retry, PDF не грузить заранее. HEIC — backend не транскодит
  (отклоняется), поэтому viewer поддерживает JPG/PNG/PDF; HEIC → честный download-fallback.
- **Upload:** объединить 5 компонентов в один: камера (`capture`)/медиатека/Files, прогресс, retry,
  cancel, размер/формат (10МБ, jpg/png/webp/pdf), preview, remove, max count/size, server-валидация
  (magic-byte уже есть), **анти-двойной-tap** (уже `useFormStatus().pending`, закрепить).

---

## 8. Sticky actions, modal/sheet, статусы (§18/§19/§20)

- **StickyActions** (единый): safe-area-bottom (`.pb-safe-actions`), page bottom-padding, primary
  full-width, secondary → menu/sheet, destructive отдельно, loading/disabled, keyboard-aware, без
  дубля с кнопкой в теле. Проверить на: расход/счёт/возврат/согласование/оплата/возврат-на-исправление.
- **Sheet:** короткое подтверждение → bottom-sheet; комментарий возврата/отклонения → full-width
  sheet с textarea (обязательность, keyboard-safe, close-warning при несохранённом тексте); сложная
  форма → отдельная страница. Заменить `window.prompt/confirm` в WorkflowActions/Attachments/
  RefundDraftEditor/Cancel-формах.
- **Статусы (§20):** на каждой detail — текущий статус · кто должен действовать · что будет после ·
  почему заблокировано · следующая роль. Не только цвет бейджа — обязательно текст. Примеры:
  «Ожидает проверки регионального директора», «После согласования будет передан бухгалтеру»,
  «Оплата заблокирована: требуется проверка реквизитов», «Возврат просрочен на N дн.».

---

## 9. Приоритеты и привязка к коммитам (§28)

| # commit | Объём | Основание аудита |
|---|---|---|
| 1 | этот аудит | §1 |
| 2 | shared: MobileCard, FilterSheet, StickyActions, FileUpload, DocViewer, Sheet/Modal, StatusBadge | §1 (нет слоя) |
| 3 | expenses списки/фильтры/создание (карточки, sheet, sticky) | §3 |
| 4 | expenses деталь/согласование (роль-статусы, sticky, sheet вместо prompt) | §3 |
| 5 | overspend role-логика (owner-any-except-adv, adv→GD, server guards + IDOR-тесты) | §4 |
| 6 | invoices списки/создание (3 таблицы→карточки, AI-flow) | §5 |
| 7 | invoices деталь/бухгалтер (AI-поля, break-anywhere, sticky, payment guard) | §5 |
| 8 | refunds списки (карточки+очереди) | §6 |
| 9 | refunds wizard/документы (6 шагов, stepper, verт. список, sticky) | §6 |
| 10 | refunds деталь/согласование/оплата | §6 |
| 11 | document viewer / unified upload | §7 |
| 12 | performance (пагинация/lazy) | §12, отд. `mobile-wave2-performance.md` |
| 13 | visual/tests/docs (`pilot:mobile-wave2-finance`, Playwright, гайды, отчёт) | §25-30 |

## 10. Вне скоупа WAVE 2 (в WAVE 3+)

- Полная mobile-переверстка модуля budgets (правим только role-логику перерасхода §6).
- `analytics/expenses` drilldown 9-col таблица (аналитика — WAVE 4).
- Пороговая модель `REGIONAL_MAX_OVER_PERCENT`/`OWNER_DOUBLE_CONFIRM_PERCENT` (не реализована).
- HEIC-транскодинг (backend отклоняет; viewer даёт download-fallback).
- Зарплата, сотрудники, ОФД, календарь платежей.

---

## 11. Критерии завершения WAVE 2 (не только зелёные тесты, §30)

Расходы/счета/возвраты полностью проходятся на 320px; нет общего h-scroll; таблицы → осмысленные
карточки; документы открываются без масштабирования; sticky-actions не под клавиатурой; owner
согласует любой перерасход кроме рекламы; рекламу — только ГД; все role-guards server-side; ручная
проверка на реальном iPhone; desktop не деградировал.
