# UI consistency pass — аудит по свежим production-скриншотам

Дата: 2026-07-29 · Ветка: main. 8 свежих скриншотов текущего прод-деплоя (dark, iPhone). **Не
stale** — соответствуют актуальному коду (SVG-иконки drawer, MonthNav, стек company/club,
segmented budgets уже видны). Скриншоты — главный источник приёмки.

## Пер-скриншот

| # | Экран / маршрут | Дефект (виден) | Компонент / причина | Исправление |
|---|---|---|---|---|
| SS1 | Drawer | **Theme-popover выходит за левую границу drawer** (обрезан слева, накрывает «Компания»/«Клуб») | `ThemeToggle` — `absolute right-0 w-40`, кнопка у левого края → меню растёт влево за drawer | На mobile/в drawer — **inline segmented** (Системная/Светлая/Тёмная), без floating popover; popover оставить только на desktop (`lg:`) |
| SS1 | Drawer | **Company/club: двойной тёмный фон** (тёмная плашка + ещё темнее select); тяжело | `ScopeSwitcher` `bg-slate-100` пилюля + native select | Один neutral surface (border + `var(--surface-card)`), label сверху, select прозрачный внутри, 48px, stack, truncate |
| SS1 | Drawer | switch-account иконка «висит отдельно»; активный nav — тяжёлый блок | AccountSwitcher / nav active | switch → обычная icon-button; active — accent-soft |
| SS2 | Analytics `/analytics` | **«Показать» накладывается на «По дату»** date-field; поля асимметричны, разной высоты | период-форма `flex flex-wrap items-end gap-2 p-2` | **MobileFilterStack**: Период / С даты / По дату — full-width строками; «Показать» — отдельной строкой full-width; DateField |
| SS3 | OFD `/analytics/ofd-sales` | «синий на синем»: navy page+cards, голубые суммы, badge «Месяц» светло-синий | navy `--background`+`--card`; accent на каждом значении | Нейтрализовать палитру; badge «Месяц» → neutral/soft; secondary-суммы — text-primary; total — accent |
| SS4/5 | Collections `/collections` | **2 больших ЯРКО-СИНИХ sync-кнопки** (тяжело для системной операции) | `CashSyncButtons` — обе primary | Обе → **secondary**, равная full-width, gap 12px, один ActionStack |
| SS6 | Budgets `/budgets` | Клуб/Месяц/Показать в ряд — Месяц oversized, «Показать» зажата справа; segmented тёмно-синяя плита | filter grid `min-[420px]:grid-cols-[1fr_auto_auto]`; segmented dark | Mobile: Клуб/Месяц/Показать **full-width строками**; Date(month)Field; segmented — neutral bg + accent-soft active |
| SS7 | Payroll overview `/payroll` | **Месяц и Клуб перекрываются** (label над контролом), второй ряд иначе, «Показать» мелкая; tabs у края | payroll `flex flex-wrap` фильтры | **MobileFilterStack + FilterActionRow**; tabs — horizontal-scroll |
| SS8 | Payroll periods `/payroll` (Расчётные) | Месяц-поле «пустой большой блок»; «Создать период» произвольной ширины; фильтры иначе; checkbox выравнен случайно; **таблица клипается справа (НАЧ…)** | create-form + filters + wide table | Create: Клуб/Месяц/Кнопка full-width; фильтры → FilterActionRow + checkbox отдельной строкой; **таблица → mobile cards** |

## Общие проблемы

1. **Цвет: «синий на синем».** `--background:#0b1220` (navy), `--input:#0e1626` (navy), `--border:
   #273244` (blue) → весь dark отдаёт синим. Нужны нейтральные graphite-токены + семантические
   алиасы (`--surface-*`, `--border-*`, `--accent-*`); синий — только primary/active/focus/links.
2. **Фильтры непоследовательны.** Analytics/Budgets/Payroll/Payroll-periods — каждый свой pattern.
   Единый контракт: `MobileFilterStack` (1 колонка, gap 12, full-width) + `FilterActionRow`
   (Apply primary / Reset secondary, full-width на узком).
3. **Date fields.** iOS date/month выглядят высокими/шире соседних. Нужен shared `DateField`/
   `MonthField` (wrapper владеет border/bg/padding; native input прозрачный, 16px, 48–52px).
4. **Кнопки.** Разная ширина у однотипных (sync, «Показать»/«Создать»); per-page синие оттенки.
   Единый Button API (`buttons.tsx`) + secondary для нейтральных операций.
5. **Mobile tables.** Payroll periods — клипается; → cards.
6. **Desktop.** Тот же color-pass (нейтральные cards/borders, единые высоты) — не только mobile.

## План

tokens (semantic + neutralize dark) → DateField/MonthField → ThemeToggle inline segmented →
ScopeSwitcher lighten → Analytics/Budgets/Payroll/Payroll-periods фильтры на MobileFilterStack/
FilterActionRow + DateField → payroll-periods cards → collections sync secondary → OFD/nav neutral
→ pilot `ui-consistency-color-filter-pass` → screenshots (harness; запуск у вас) → gauntlet.

> Playwright-скриншоты: harness готов (Part 2), но в среде **не запускается** (нет сети/браузера/
> OTP) — команды в `tests/visual/README.md`; фиксирую честно.
