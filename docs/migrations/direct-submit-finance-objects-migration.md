# Миграция: прямая отправка финансовых объектов (расходы, счета, возвраты)

Упрощение первичного создания (создание → сразу проверка регионала) + безопасный перевод
старых черновиков. **Схема БД не менялась** — только поведение форм/действий и backfill старых
draft. Аддитивных миграций нет.

## Что изменилось
- **Расход:** форма после загрузки документов автоматически вызывает `submitExpense` в том же
  потоке → расход сразу в `pending_regional_budget_approval` (или `pending_accountant_
  verification` для расхода регионала). Отдельная кнопка «Отправить» на детальной странице
  остаётся только для повторной отправки после возврата.
- **Счёт:** уже draftless (`createAndSubmitInvoice` → `needs_review`); обновлён только текст
  кнопки («Создать счёт») и подсказка.
- **Возврат:** финальное действие мастера = «Создать возврат» (create-and-submit), без
  повторного подтверждения; вариант «Исправить и отправить повторно» после возврата.

## Идемпотентность
- Счёт — `Invoice.clientSubmissionId @unique`.
- Расход — переиспользование draftId в форме + `submitExpense` compare-and-set (`updateMany
  where status in [draft, needs_correction]`).
- Возврат — единственный wizard-draft + `submitRefundToRegional` compare-and-set.

## Backfill старых черновиков
`finance:direct-submit-audit` (read-only) → `finance:direct-submit-backfill` (dry-run по
умолчанию, `--apply`). Готовые draft переводятся в статус региональной проверки; автор и
`createdAt` сохраняются; добавляется audit-событие `auto_submitted_after_direct_submit_
migration`; одно сводное уведомление на клуб (идемпотентно). Повреждённые/неполные draft
остаются как есть (manual_review) — не удаляются, не угадываются.

Готовность к авто-переводу:
- Расход: v2, draft, ≥1 активный документ, есть активный регионал клуба, автор — НЕ регионал.
- Счёт: draft, есть файл, контрагент, сумма > 0.
- Возврат: v2, draft, клиент, сумма > 0, 4 активных документа.

## Production rollout (§21)
```
# 0. backup БД
npm run finance:direct-submit-audit              # сохранить результат
node scripts/finance-direct-submit-backfill.mjs  # dry-run: проверить количества и manual
node scripts/finance-direct-submit-backfill.mjs --apply
npm run finance:direct-submit-audit              # повторно
# проверить очереди регионалов, уведомления; открыть по одному объекту каждого типа
```
Финансовые движения при backfill НЕ создаются. Секреты/DATABASE_URL в отчёт не выводятся.

## Не менялось
Формулы возвратов, АБ/ПТ, AI confidence guards, редактирование ИИ-полей бухгалтером, документы,
категории, финансовые движения, оплата, роли, tenant isolation, бухгалтерская стадия,
региональное согласование, закрытые периоды.
