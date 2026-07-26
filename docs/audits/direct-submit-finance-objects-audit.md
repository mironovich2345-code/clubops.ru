# Аудит: прямая отправка финансовых объектов на проверку (расходы, счета, возвраты)

Аудит **до** изменения бизнес-логики. Цель: после нажатия основной кнопки объект сразу
создаётся и отправляется регионалу — без отдельного шага «Отправить на проверку». Сохранить
цепочку согласования, проверку регионала, передачу бухгалтеру, отклонение/возврат, документы,
права, историю, уведомления, tenant isolation, финансовую логику.

**Ключевой факт:** СЧЕТА уже draftless — `createAndSubmitInvoice` создаёт счёт сразу в
`needs_review` (с `Invoice.clientSubmissionId @unique` для идемпотентности). Это эталон.
РАСХОДЫ и ВОЗВРАТЫ пока двухшаговые.

## 7 пунктов

1. **Текущие статусы.**
   - Расход (`Expense`, v2, `expense-simplified.ts` `EXP`): `draft` → `pending_regional_budget_
     approval` → `pending_accountant_verification` → `verified` (+ `needs_correction`,
     `cancelled`). Draft = `draft`; региональная проверка = `pending_regional_budget_approval`.
   - Счёт (`Invoice`, `invoices.ts`): `draft` → `needs_review` → `approved_by_regional` →
     `approved_by_chief_accountant`/`approved_by_owner` → `paid` (+ `needs_correction`,
     `rejected`, `canceled`). Draft = `draft`; проверка = `needs_review`. **Создание уже в
     `needs_review`.**
   - Возврат (`Refund` v2, `refund-workflow.ts` `REFUND_V2_STATUS`): `draft` →
     `pending_regional_review` → `accounting_in_progress` → `paid` (+ `needs_correction`,
     `canceled`). Draft = `draft`; проверка = `pending_regional_review`.
2. **Где создаётся draft.**
   - Расход: `createSimplifiedExpenseDraft` (`expenses/simplified-actions.ts:105`) → `status:
     "draft"`. Документы прикрепляются ПОСЛЕ, на детальной странице.
   - Счёт: `createAndSubmitInvoice` (`invoices/actions.ts:309`) — **сразу `needs_review`**, файл
     привязывается через server-owned `PendingInvoiceUpload` (bind при create).
   - Возврат: `createRefundDraft` (`refunds/refund-document-actions.ts:57`) — draft с одним
     `returnType` в начале мастера; сумма/клиент/расчёт/4 документа добавляются шагами.
3. **Где выполняется send_to_review (отдельная кнопка).**
   - Расход: `submitExpense` (`simplified-actions.ts:179`) — кнопка «Отправить» на детальной
     странице (`WorkflowActions.tsx:85`). Проверяет ≥1 документ, маршрутизирует по роли автора,
     аудит `expense.submitted`+`routed_*`, `notifyRegionalReview`.
   - Счёт: `applyInvoiceAction` case `send_to_review` (`invoices.ts:174`) — теперь в основном
     для повторной отправки после `needs_correction` (создание draftless).
   - Возврат: `submitRefundToRegional` (`refund-document-actions.ts:537`) — кнопка «Отправить
     региональному директору» (`RefundWorkflow.tsx:29`). Readiness-gate + fingerprint,
     `notifyRegionalReview`.
4. **Повторяющиеся проверки между create и send.** Расход: tenant/club, month-close, категория,
   активный ИП — в create; документы (≥1), маршрут регионала — в submit. Возврат: club/company,
   returnType — в create; readiness (4 документа, реквизиты, расчёт, сумма) + fingerprint — в
   submit. Счёт: всё в одном create-and-submit (эталон).
5. **Роли и разные маршруты.** Следующий согласующий для объекта **управляющего** — всегда
   регионал (expense→`pending_regional`, invoice→`needs_review`, refund→`pending_regional_
   review`). Разные маршруты, которые НЕЛЬЗЯ ломать:
   - Расход, созданный **регионалом** → `submitExpense` шлёт сразу `pending_accountant`
     (регионал не согласует сам себя).
   - Счёт, созданный регионалом → `needs_review`, но регионал МОЖЕТ согласовать свой счёт.
   - Возврат v2 создаёт только управляющий.
   - owner/general_director не создают операционные объекты (`canCreateOperational`).
   Нет активного регионала: расход/возврат — блок (не падать к бухгалтеру); счёт — на approve
   падает к гл. бухгалтеру.
6. **Какие старые draft переводятся автоматически.** draft-объект, который технически можно
   отправить без потери данных: расход с ≥1 документом, действующим маршрутом регионала,
   валидными полями; счёт с файлом и минимальными данными; возврат с полным набором 4 доков +
   валидным расчётом + клиентом. Перевод → статус региональной проверки, автор/createdAt
   сохраняются, audit `auto_submitted_after_direct_submit_migration`, уведомление (сводное по
   клубу), без финансовых движений, без пропуска регионала.
7. **Какие draft — на ручной разбор (`manual_review`).** Нет clubId/companyId; нет документа
   там, где без него объекта нет; ссылка на удалённого автора/клуб без маршрута; нет активного
   регионала; критическая ошибка расчёта возврата; неполный набор обязательных документов. Не
   удалять, не угадывать; вывести технические ID в отчёте.

## Целевые решения
- **Счета:** без изменений логики (уже draftless); привести toast/подсказку к единому виду;
  форма `InvoiceUpload` уже single-button.
- **Расходы:** новое серверное действие `createAndSubmitExpense` — валидация + документы
  (server-owned pending upload, ≥1, ≤3) + создание + перевод в `pending_regional`/
  `pending_accountant` (по роли автора) + audit + notify, транзакционно + идемпотентно
  (`clientSubmissionId`). Форма `SimpleExpenseForm` собирает документы и делает одно действие;
  кнопка «Создать расход» + подсказка; toast «Расход создан и отправлен региональному
  директору». Кнопка «Отправить» на детальной странице остаётся только для повторной отправки
  после возврата.
- **Возвраты:** финальное действие мастера = create-and-submit (кнопка «Создать возврат»),
  readiness сохраняется; технический wizard-draft остаётся как допустимое (§7) промежуточное
  состояние для сбора 4 документов/расчёта, но пользователь не видит отдельного шага «Отправить»
  сверх завершения мастера; toast «Возврат создан и отправлен региональному директору». Возврат
  на исправление и повторная отправка не трогаются.
- **Backfill:** `finance:direct-submit-audit` + `finance:direct-submit-backfill` (dry-run по
  умолчанию, `--apply`), идемпотентно, manual_review для повреждённых, сводное уведомление по
  клубу, без финансовых движений.

## Не менять
Формулы возвратов, АБ/ПТ, AI confidence guards, редактирование ИИ-полей бухгалтером, категории,
финансовые движения, оплату, роли, tenant isolation, бухгалтерскую стадию, региональное
согласование, закрытые периоды. Только упрощение первичного создания + миграция черновиков.
