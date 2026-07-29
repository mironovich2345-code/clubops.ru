# Final iPhone acceptance — 13 screenshots: аудит

Дата: 2026-07-29 · Ветка: main.

> **Честно про источник:** 13 изображений, упомянутых в задании, **не пришли в сообщение** (в этом
> ходе доступен только текстовый спек, без image-блоков — в отличие от прошлых ходов, где я видел и
> описывал каждый экран). Не заявляю, что анализировал скриншоты, которых не вижу. К счастью, спек
> §2–13 перечисляет каждое исправление конкретно + я знаю текущий код, поэтому работа выполнима по
> тексту спека. Ниже — карта экранов по спеку (маршрут/компонент/дефект/фикс), не по картинкам.

## Карта (по спеку + коду)

| # | Экран | Route | Компонент | Дефект (спек) | Фикс | Статус |
|---|---|---|---|---|---|---|
| 1 | Collections control balance | /collections | `CollectionForms.OpeningBalanceForm` | raw date крупнее select; history — таблица | DateField 48px; history → mobile cards | ✅ |
| 2 | Collections incassation | /collections | `CollectionForms.CollectionForm` | raw date | DateField | ✅ |
| 3 | Collections ООО→ИП | /collections | `WithdrawalForm` | raw date | DateField | ✅ |
| 4 | Collections «Иное» | /collections | `OtherIncomeForm` | raw date | DateField | ✅ |
| 5 | Refund detail | /refunds/[id] | `[id]/page.tsx` | «К списку» тяжёлая; docs | compact back-link + FileRow | ⏳ частично/долг |
| 6 | Mandatory payments | /mandatory-payments | page + `MandatoryPaymentForm` | кнопки/pill; dueDate raw; MonthNav | DateField; buttons stack | ✅ форма; KPI/MonthNav — долг |
| 7 | Employee payment profile | /payroll/employees/[id] | `PayrollProfileForm` | hireDate raw; Save ширина | DateField; full-width Save | ✅ |
| 8 | Payment scheme | /payroll/employees/[id] | `PaySchemeForm` | effectiveMonth raw | MonthField; full-width | ✅ |
| 9 | Employee advances | /payroll/advances | page + `AdvanceCreateForm`/`EmployeeAdvancePanel` | month raw; filters | MonthField; filter stack; full-width | ✅ |
| 10 | Payroll overview | /payroll | page.tsx | month filter raw; overlap | MonthField; filter stack full-width | ✅ |
| 11 | Payroll advances (filters) | /payroll/advances | page.tsx | filters overlap | filter stack | ✅ |
| 12 | Payroll periods create | /payroll/periods | `CreatePeriodForm` | month empty block | MonthField (done ранее) | ✅ |
| 13 | Payroll periods list | /payroll/periods | periods/page.tsx | filters/table | stack + cards (done ранее) | ✅ |

## Приоритет этого хода

1. **DateField/MonthField sweep (§2)** — заменить raw `input[type=date/month]` в Collections +
   Payroll + Mandatory на shared component (48px, native input прозрачный, 16px). Static guard:
   raw date/month запрещён в этих директориях.
2. **Payroll overview/advances/periods filters (§8–10)** — full-width mobile stack (periods сделан
   ранее; overview/advances — сейчас).
3. **Collections history → mobile cards (§4)**.
4. **Payroll profile/scheme/advance CTAs full-width (§7/§11)**.
5. **Viewport / iOS zoom (§viewport)** — все form-controls ≥16px (CSS уже есть) + тест.
6. `pilot:final-iphone-13-residuals` + gauntlet.

## Долг (честно, вне этого хода)
Refund detail FileRow (§5), Mandatory KPI compact + MonthNav (§6), Employee профиль-секции accordion
(§7/§12), tabs horizontal-scroll (§13), native file-upload → MobileFileField sweep (§3, рискованно
для 5 upload-потоков), Playwright-запуск + ручной iPhone. Не-приоритетные raw date (invoices AI/
expenses detail/activity/dashboard-plan) — вне 13-screenshot скоупа.
