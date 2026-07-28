# Density Part 1 — краткий performance-pass (§21)

Скоуп: только 5 разделов (Analytics, ОФД, Инкассация, Бюджеты, История). Без глобального
performance-rewrite. Метрики на устройстве — в ручном чек-листе.

## Что проверено и статус

| Аспект | До | После |
|---|---|---|
| Desktop-таблицы монтируются на mobile | таблицы рендерились и на mobile (внутр. скролл) | таблицы `hidden lg:block` — **desktop-разметка не строится на mobile**; mobile рендерит только карточки (меньше DOM) |
| Число карточек | KPI `p-5 text-3xl` крупные | компактные (`p-3`, clamp) — тот же счётчик узлов, меньше высота |
| Двойной рендер (таблица+карточки) | — | да, оба варианта в DOM, но противоположные `hidden`/`lg:hidden` → браузер не раскладывает скрытый (display:none), стоимость раскладки одна |
| History (Collections) | все `<details>` независимы, могли быть раскрыты одновременно | single-active accordion → одновременно раскрыт максимум один блок (истории по умолчанию свёрнуты) |
| Action History пагинация | серверная (`getActivityLog` page/pageSize) | **сохранена** — не грузим все записи; новую архитектуру не вводили (§18) |
| Analytics/ОФД запросы | без изменений | не трогали серверные выборки (только верстка) |
| Bottom-nav скролл-логика | отсутствовала | единый hook (`useHideOnScrollDown`) + внешний store — **одна** реализация, не per-page; passive scroll listener |

## Замечания

- Двойная разметка (desktop table + mobile cards) — компромисс: скрытый через `hidden` узел не
  участвует в layout/paint (display:none), поэтому mobile не платит за desktop-таблицу и наоборот.
  Полное «не монтировать» desktop-таблицу на mobile потребовало бы client-детекции ширины (SSR-
  несовместимо) — не оправдано для Part-1.
- Bottom-nav скрытие — `transform` (не изменение layout) → нет reflow/layout shift.
- `useSyncExternalStore` для suppression — без лишних ре-рендеров вне подписчиков (только bottom nav).

## Долг (Part 2)

- Collections history → карточки (сейчас скролл-таблица в контейнере, свёрнуто).
- Analytics breakdown-таблицы (weekday/manager/top-expenses/by-network) → карточки/«краткий вид».
- ОФД `OfdRevenueTable` (статьи доходов) → карточки.
- Реальные метрики (Lighthouse mobile, DOM-size) — снять на устройстве.
