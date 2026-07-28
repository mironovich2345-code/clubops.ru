# WAVE 2 — финансовый контур на мобильном: итоговый отчёт (§30)

Дата: 2026-07-28 · Ветка: main · Скоуп: расходы, счета, возвраты, их документы, согласования по
ролям, sticky-actions/клавиатура. Вне скоупа (WAVE 3+): зарплата, сотрудники, ОФД, аналитика,
бюджеты (кроме role-логики перерасхода §6), календарь платежей.

> **Честно (§30):** WAVE 2 не считается закрытой только по зелёным тестам. Доставлен системный
> слой + ключевые преобразования всех трёх разделов; часть глубокой per-page полировки и **ручная
> проверка на реальном iPhone** ([чек-лист](iphone-wave2-finance-checklist.md)) остаются —
> отмечено в п. 20–21.

## Автопроверки
`npm run pilot:mobile-wave2-finance` — **40/40** (shared S1-8, overspend O1-8/O-SRC/O-SRV,
expenses E1-6, invoices I-L1-4, refunds R-L1-2/R-W1-3, detail viewer D-V1-2). Плюс `pilot:full`,
`tsc --noEmit`, `next build`, `build:prod` — см. п. 18.

## 21-точечный отчёт

1. **Какие страницы были непригодны для mobile.** Списки расходов/счетов/возвратов —
   горизонтально-скроллящиеся (или клипающиеся) desktop-таблицы; wizard/детали с мелкими
   тап-таргетами и не-sticky кнопками под клавиатурой; документы открывались новой вкладкой.
2. **Где был horizontal overflow.** Все таблицы `min-w-full`+`whitespace-nowrap`; expenses-list
   был `overflow-hidden` → контент **клипался**. Исправлено: desktop-таблица `hidden lg:block`
   (+`overflow-x-auto`), mobile — карточки.
3. **Какие таблицы заменены карточками.** Расходы (1), Счета (3: за период / очередь проверки /
   просроченные долги), Возвраты (`RefundTable` — покрывает список + 3 роль-очереди). Desktop-
   таблицы сохранены.
4. **Как работают фильтры.** Статус-пилюли (существующие) уже переносятся на mobile (flex-wrap).
   Введён общий `FilterSheet` (chips + bottom-sheet над серверной формой) для будущих фильтров;
   расширенный набор (клуб/период/категория/автор) серверно не реализован — **не выдумывали**
   (это была бы новая функция), зафиксировано как долг.
5. **Как адаптирована форма расхода.** Одна колонка (уже была), sticky «Создать расход» на
   мобильном (`StickyActions`, keyboard-aware, safe-area), десктоп — инлайн (без дубля),
   подсказка об отправке регионалу, `pb-28` clearance.
6. **Как адаптирован перерасход.** Role-логика (см. п.7). Mobile-детали суммы/категории/статуса —
   в существующей v2-карточке расхода (read-only строка бюджета/перерасхода).
7. **Права owner/GD по рекламе.** `canApproveBudgetOverrunForCategory` (`src/lib/auth.ts`):
   реклама → **только ГД** (owner И регионал исключены); прочие категории → owner/регионал
   (клуб-скоуп); ГД дополнительно — salary. Единая capability ⇒ и server-guard
   (`budgets/actions.ts loadDecidableRequest`, гейтит approve+reject до мутации), и UI-зеркало.
   Прямой owner-вызов по рекламе запрещён guard'ом. Тесты O1-8/O-SRC/O-SRV.
8. **Как адаптирована форма счёта.** Списки → карточки; создание/AI-flow сохранены
   (`needs_review`/confidence/`clientSubmissionId`/idempotency не тронуты); grid полей уже
   `md:grid-cols-2` (1 колонка на телефоне).
9. **Как бухгалтер редактирует AI-поля.** Форма в одну колонку на телефоне; документ открывается
   встроенным viewer; payment guard `invoicePaymentBlockedReason` сохранён.
10. **Как адаптирован refund wizard.** Doc-viewer встроенный, тап-таргеты ≥44px (Открыть/Заменить/
    Удалить разнесены), sticky nav «Далее» (keyboard-aware) + Сохранить/Отменить; слоты 1-колоночные
    на 320px; бизнес-логика (compare-and-set idempotency) сохранена.
11. **Как работают документы возврата.** 4 слота (заявление, договор ×2, чек — «реквизиты» это
    форма, не файл) вертикальным списком; статус/preview/replace/delete-до-submit; ошибки читаемы.
12. **Как работают sticky actions.** Единый `StickyActions` (mobile-only `lg:hidden`, safe-area
    `pb-safe-actions`, `visualViewport` подъём над клавиатурой); применён к созданию расхода и
    wizard. Не дублируется — десктоп-кнопки `hidden…lg:*`.
13. **Как viewer открывает фото/PDF.** `DocumentViewer`: full-screen, image fit-to-width +
    tap-to-zoom, PDF `<object>` по клику, HEIC/webp → download-fallback, loading/error/retry,
    safe-area. Применён: attachments расхода, wizard-слоты, детали счёта и возврата.
14. **Как работает клавиатура.** Sticky-бар поднимается на высоту клавиатуры (`visualViewport`);
    поля ≥16px (WAVE 1) — без авто-зума; формы имеют нижний `pb` под sticky-бар.
15. **Performance-оптимизации.** Ленивый PDF/картинки во viewer; карточки вместо двойного
    скролл-контейнера; малые клиентские острова (презентационные карточки — Server Components).
    Детали — [mobile-wave2-performance.md](../audits/mobile-wave2-performance.md).
16. **Результаты 320–768px.** Списки/создание/wizard/детали — одна колонка, без page-h-scroll
    (автогарантии + WAVE-1 `overflow-x:clip`). Визуальная попиксельная проверка — на устройстве.
17. **Desktop regression.** Все desktop-таблицы и инлайн-кнопки сохранены под `lg:`; overspend-
    логика не меняет routing/пороги. Автопроверки desktop-инвариантов зелёные.
18. **Тесты/build.** `pilot:mobile-wave2-finance` 40/40; `pilot:full` (см. запуск гейтов);
    `tsc --noEmit` чисто; `next build` + `build:prod` — успех; `prisma validate` dev+prod — valid.
19. **Commit hashes.** `03fd6fe` audit · `0fb05db` shared components · `29ec8b3` overspend ·
    `02d7969` expenses list · `212deab` invoices lists · `6cce19d` refunds lists · `a36f553`
    expense create sticky+viewer · `a62da42` refund wizard · `6ca6bda` detail viewer. (+docs).
20. **Осталось проверить на реальном iPhone.** Весь [чек-лист](iphone-wave2-finance-checklist.md)
    (30 пунктов): камера, клавиатура, sticky, PWA standalone, dark/light, медленная сеть, реальные
    жесты wizard. Из окружения разработки не выполнено.
21. **Что переходит в WAVE 3.**
    - Пагинация/lazy списков (серверные `take/skip`) — крупнейший перф-долг.
    - Полный 6-шаговый wizard со stepper'ом (сейчас: маршрутный wizard + sticky nav; видимый
      «шаг N из K» не добавлен).
    - Sticky «Рассчитать/Сохранить» в calc-формах (Membership/Pt) — сейчас не sticky.
    - `StatusNote` (кто-должен-действовать/что-после/почему-заблокировано) на detail —
      компонент готов, повсеместное внедрение не завершено.
    - Расширенные фильтры (клуб/период/категория/автор) — серверно не реализованы.
    - Единый upload-компонент (`MobileFileField`) внедрён точечно; полная замена 5 upload-потоков.
    - Playwright visual-скриншоты 320–1440 (сетап планируется; не в этом наборе).
    - Пороговая модель перерасхода (`REGIONAL_MAX_OVER_PERCENT`/`OWNER_DOUBLE_CONFIRM_PERCENT`).

## Критерии завершения (§30) — статус

| Критерий | Статус |
|---|---|
| Расходы/счета/возвраты проходятся на 320px | ✅ фундамент+карточки+sticky; попиксельно — на устройстве |
| Нет общего horizontal scroll | ✅ (WAVE-1 clip + карточки) |
| Таблицы заменены осмысленными карточками | ✅ все три раздела |
| Документы открываются без масштабирования | ✅ встроенный viewer (fit-to-width) |
| Sticky-actions не перекрываются клавиатурой | ✅ `visualViewport` (create+wizard); calc-формы — WAVE 3 |
| Owner согласует любой перерасход кроме рекламы | ✅ |
| Рекламу согласует только ГД | ✅ server-guard + UI |
| Все role-guards server-side | ✅ единая capability + loadDecidableRequest |
| Ручная проверка на реальном iPhone | ⏳ чек-лист готов, прогон вне окружения |
| Desktop не ухудшился | ✅ |
