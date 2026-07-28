# Final mobile visual polish — Part 2: аудит по реальным скриншотам

Дата: 2026-07-29 · Ветка: main. 8 реальных скриншотов с iPhone (dark). Анализ каждого экрана →
маршрут → компонент → дефект → исправление.

## ВАЖНО: расхождение скриншотов с текущим кодом

Скриншоты сделаны на сборке **ДО** коммитов `028ff58`/`14fc465`. На них ещё видно то, что уже
исправлено в коде (HEAD `14fc465`, проверено grep'ом):
- **нижнее меню** (Главная/Аналитика/Счета/Расходы/Ещё) — в коде удалено (`fixed bottom-0` = 0);
- **эмодзи-иконки** в drawer (🏠📊👥💰📁) — заменены SVG `NavIcon`;
- **два select компания/клуб в ряд** (Клуб уходит за drawer) — в коде стек (`ScopeSwitcher` `lg:flex-row`);
- **таблица сотрудников** — в коде карточки (`space-y-3 p-3 lg:hidden`).
→ Нужен **rebuild/redeploy**, чтобы это увидеть. В Part 2 эти пункты НЕ переделываю (уже сделаны).

Ниже — дефекты, которые **реально в текущем коде** и на скриншотах (Part 1 их не трогал).

## Пер-скриншот

| # | Экран / маршрут | Компонент | Дефект (виден) | Исправление |
|---|---|---|---|---|
| SS1 | Drawer | MobileShell/ScopeSwitcher | (stale) emoji + company/club в ряд | уже в коде: SVG + стек. Rebuild. |
| SS2 | Dashboard `/dashboard` | `DashboardMonthSelector`, OFD sync card | month-nav: стрелки+label+badge «Текущий месяц» в один ряд, неровно; «Синхронизировать» не full-width | shared **MonthNav** (44×44 стрелки, центр label, badge отдельной строкой); sync → **PrimaryButton** full-width |
| SS3/4 | Expenses `/expenses` | `expenses/page.tsx` top-actions + status pills | «Инкассация и остатки» и «+ Новый расход» — **разной ширины**, не равны; info-note близко; статус-пилюли **хаотичный 2+2** разной ширины | top-actions → **ActionButtonRow** (grid 1fr/1fr, стек на узком, равная высота); gap ≥16px; статусы → **StatusChips** (горизонтальный скролл в контейнере, ровные) |
| SS5 | Collections `/collections` | `collections` accordion form | CTA «Сохранить контрольный остаток» **не full-width**, смещена влево; date-field ок (стал full-width после §18) | CTA → **PrimaryButton** full-width; отступ до CTA ≥16px |
| SS6 | Invoices `/invoices` | `invoices/page.tsx` KPI + filters + month-nav | KPI **2+2+1** с «одинокой половинной» картой «Счетов 2»; city/club два select; month-nav | KPI: последняя карта full-width (`min-[400px]:grid-cols-2` + `последняя col-span-2`); month-nav → shared MonthNav; фильтры ровные |
| SS7/8 | Employees `/employees` | add-form + filters (+ list) | (stale) list таблица → уже карточки. Реально: add-CTA «Добавить сотрудника» не full-width; фильтры Клуб/Должность/Статус+Применить | add-CTA → PrimaryButton full-width; фильтры → FilterActionRow |

## Что делаем в Part 2

1. **Button system** (`src/components/mobile/buttons.tsx`): Primary/Secondary/Danger/Ghost/Icon +
   ActionButtonRow + SegmentedControl. Правила: ≥44px (CTA 48px), одиночная primary — full-width,
   пара — grid 1fr/1fr → стек на узком, центрированный label, единые radius/font/padding/focus.
2. **MonthNav** shared (Dashboard/Invoices/OFD): 44×44 стрелки, центр label, badge отдельно.
3. Expenses top-actions + status chips; Collections CTA; Invoices KPI+filters; Employees add-CTA.
4. **Playwright** реальные скриншоты 320–1440 light/dark + bounding-box проверки (нет overflow,
   controls внутри parent, нет overlap, edge ≥12px, primary label центрирован). Честно: capture
   требует запущенного авторизованного приложения — статус прогона фиксирую явно.
5. **pilot:final-mobile-visual-polish-part2** (структурные + presence-проверки).
6. Ручной iPhone URL-список (точные состояния для проверки на устройстве).

## Не входит

Emoji/bottom-nav/drawer/employees-cards (сделано). Analytics/OFD breakdown-таблицы (Part-2 density —
отдельно). Payroll/Settings глубоко.
