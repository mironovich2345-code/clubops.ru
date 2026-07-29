# UI consistency pass — отчёт

Дата: 2026-07-29 · Ветка: main. По 8 свежим production-скриншотам (dark, iPhone).
Автотесты: `pilot:ui-consistency-color-filter-pass` 15/15. Аудит:
[ui-consistency-pass-screenshot-audit.md](../audits/ui-consistency-pass-screenshot-audit.md).

## Разобранные скриншоты
Drawer (theme-popover, company/club), Analytics filters, OFD sales, Collections summary +
control-balance form, Budgets, Payroll overview, Payroll periods.

## Отчёт (по пунктам ТЗ)

- **Overlaps.** Analytics «Показать» накладывалась на «По дату» (period-form `flex flex-wrap
  items-end`) → mobile-стек (grid) + full-width «Показать» отдельной строкой. Payroll overview/
  periods filters (label/контрол overlap) → grid-стек.
- **Разная ширина кнопок.** Collections sync ИП/ООО (две ярко-синие primary) → две **равные
  SECONDARY** (grid 2-col). «Показать»/«Создать период» произвольной ширины → единый `buttonClass`
  primary, full-width на mobile.
- **Oversized date fields.** iOS date/month высокие/шире → shared **DateField/MonthField** (wrapper
  владеет border/bg/height 48px, native input прозрачный, 16px, max-width 100%). Применён к
  Analytics/Budgets/Payroll(periods+create).
- **Drawer.** Theme-меню выходило за левую границу (floating `absolute right-0`) → на mobile
  **inline segmented** (Системная/Светлая/Тёмная), popover только desktop. Company/club — один
  neutral surface (убран двойной тёмный `bg-slate-100`), 48px.
- **Company/club selectors.** `border-[var(--border-subtle)] + bg-[var(--surface-card)]`, label,
  truncate, stack на mobile.
- **Semantic color tokens.** Добавлены `--surface-page/-card/-elevated/-muted`, `--border-subtle/
  -strong`, `--text-primary/-secondary/-muted`, `--accent-primary/-hover/-soft`, `--success/
  -warning/-danger/-info` (light+dark).
- **Blue-on-blue уменьшен.** Dark нейтрализован navy→**graphite**: `--background #0b1220→#101114`,
  `--card #111827→#191a1e`, `--input #0e1626→#16171b`, `--border` синий→нейтральный. Синий остаётся
  только accent (primary/active/focus/soft). Segmented active → `accent-soft` (не яркая плита).
- **Shared filters на страницах.** Analytics, Budgets, Payroll periods + create-period переведены
  на grid-стек + DateField + full-width primary (единый паттерн с Employees/Invoices из Part 2).
- **Mobile tables → cards.** Payroll periods (клипалась) → `MobileDataCard` (клуб/статус/месяц/
  сотрудники/начислено/выплачено/остаток/проблемы + «Открыть»); desktop-таблица `hidden lg:block`.

## Артефакты скриншотов
`artifacts/ui-consistency-pass/...` — **генерируются при запуске Playwright у вас** (harness
`tests/visual`, команды в README). В среде разработки **не сняты** (нет сети/браузера/OTP) —
фиксирую честно, «визуально готово» без artifacts не заявляю.

## Commit hashes
`1b7135c` audit · `1047bb1` color tokens + DateField + theme/scope/analytics/budgets/collections/
payroll + pilot.

## Гейты
`pilot:ui-consistency-color-filter-pass` 15/15 · `pilot:full` **3365/0 across 71 suites** · tsc
чисто · prisma dev+prod valid · **build:prod ✓ Compiled successfully**.

## Критерий завершения — статус
| Критерий | Статус |
|---|---|
| theme-меню не выходит за drawer | ✅ inline segmented на mobile |
| company/club легче | ✅ один neutral surface |
| Analytics filters не накладываются | ✅ stack + full-width button |
| date fields одинаковые | ✅ DateField/MonthField |
| Collections buttons одинаковые | ✅ equal secondary |
| Budgets filters аккуратные | ✅ stack + MonthField |
| Payroll filters аккуратные | ✅ stack |
| mobile tables → cards | ✅ payroll periods (+ employees ранее) |
| primary buttons единообразны | ✅ buttonClass |
| dark не «синий на синем» | ✅ graphite tokens |
| desktop та же система | ✅ lg: сохранён; build:prod ✓ |
| свежие screenshots просмотрены | ⏳ запуск Playwright у вас + ручной iPhone |
| build/тесты зелёные | ✅ |

## Что проверить вручную на iPhone (после deploy)
1. Drawer: theme-сегмент внутри drawer; company/club — лёгкие, в экране. 2. Analytics: Период/С даты/
По дату/Показать без наложений; date-поля нормальной высоты. 3. OFD: тон нейтральнее (меньше синевы).
4. Collections: две одинаковые серые sync-кнопки. 5. Budgets: Клуб/Месяц/Показать столбиком; segmented
мягкий. 6. Payroll overview/periods: фильтры ровные; periods-список — карточки (не таблица). 7. light/
dark целостность на 320/375/390/430.

## Остаток
Payroll overview/payments/advances/summary filters (те же на MobileFilterStack), Refunds/Settings
pixel-pass, DesktopFilterRow формализовать, запуск Playwright + ручной iPhone.
