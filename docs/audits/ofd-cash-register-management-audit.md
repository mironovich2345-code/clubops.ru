# Аудит: управление кассами ОФД (редактирование / удаление / история)

Аудит **до** изменения логики. Цель: полноценное редактирование привязок кассы, безопасное
удаление (hard delete пустой / archive с историей / защищённое полное удаление), сохранение
исторической принадлежности чеков.

Файлы: `prisma/schema.prisma` (OfdConnection, OfdCashRegisterMapping, OfdReceiptImport,
OfdReceiptItem, Ofd*Summary, OfdCashierIdentity/Mapping, PayrollSalesAttribution),
`src/app/(app)/settings/integrations/ofd/actions.ts` (Taxcom), `.../settings/ofd/astral/*`.

## 10 вопросов
1. **Что редактируется сейчас.** Только `clubId` + `legalEntityId` — `updateOfdMapping`
   (`ofd/actions.ts:392`, PIN-gated, owner/GD). `toggleOfdMapping` — включить/выключить
   (`isActive`, освобождает `activeMappingKey`).
2. **Что нельзя изменить.** `fnNumber`, `connectionId`, `kktRegNumber`, `kktName`,
   `registerKind`, `provider`. Нет действия смены ФН, названия, подключения, типа. Нет
   отдельного `status` (только boolean `isActive`).
3. **Смена ФН.** Действия нет — ФН менять нельзя. `activeMappingKey = "<provider>:<fn>"`
   @unique удерживает уникальность активного ФН.
4. **Физическая ККТ / установленный ФН.** Отдельной сущности НЕТ — `OfdCashRegisterMapping`
   смешивает ККТ (`fnNumber`/`kktRegNumber`/`kktName`) и привязку (`clubId`/`legalEntityId`/
   `connectionId`). Нет истории ФН.
5. **Чеки по кассе.** `OfdReceiptImport` (по `fnNumber` + `companyId`/`clubId`/`legalEntityId`,
   которые **снимаются на импорте**), `OfdReceiptItem`, `OfdDailySalesSummary`,
   `OfdRevenueCategoryDailySummary`. Плюс `OfdCashierIdentity` (fn в `identityKey`),
   `OfdCashierMapping`, `PayrollSalesAttribution` (через чеки).
6. **Что сломает hard delete.** FK — relationless scalar (нет cascade): удаление mapping-строки
   оставит orphan-чеки/агрегаты/identity/attribution с тем же `fnNumber`, теряя привязку и
   аудит. Данные не удалятся, но касса «исчезнет» из настроек, а история потеряет владельца.
7. **Дубли ФН.** `activeMappingKey @unique` → один АКТИВНЫЙ mapping на `(provider, fn)`;
   выключенные строки `key=null` (много можно). Один и тот же ФН в разных провайдерах — разные
   строки (dedupeKey чеков провайдеро-префиксован).
8. **Перепривязка между клубами/юрлицами.** `updateOfdMapping` меняет `clubId`/`legalEntityId`
   **in-place** (без истории). tenant-check есть; IDOR по клубу — клуб проверяется в company.
9. **Историческая принадлежность.** УЖЕ сохраняется: `OfdReceiptImport` хранит `clubId`/
   `legalEntityId`/`fnNumber` **на момент импорта** (snapshot). Смена mapping НЕ переписывает
   прошлые чеки — эффективно effective-dated на уровне чека. Но нет ЯВНОЙ истории привязок для
   аудита («до 15-го клуб А, с 16-го клуб Б»).
10. **Ошибочные/дублированные записи.** Выключенные mapping с `key=null`; потенциально
    несколько mapping на один ФН в разных провайдерах; кассы без `legalEntityId` («требует
    привязки»).

## Целевые решения (аддитивно)
- **`OfdCashRegisterMapping`**: `status` (active | disabled | archived | deleted), `archivedAt`,
  `deletedAt` (backfill из `isActive`). Активный список фильтруется по статусу; archived скрыт
  из основного, доступен через фильтр «Удалённые/Все».
- **`OfdCashRegisterAssignment`** (новая): явная история привязки (club/legalEntity/connection/
  type) с `effectiveFrom`/`effectiveTo` (end-exclusive). Смена привязки закрывает текущую и
  открывает новую; прошлые чеки НЕ трогаются; новые чеки берут привязку по дате чека
  (fallback — текущая attribution, которая и так снимается на импорте).
- **`OfdFiscalDrive`** (новая): история ФН одной ККТ (`fiscalDriveNumber`, `registrationNumber`,
  `validFrom/To`, `status`, `externalId`). Смена ФН: старый остаётся в истории, новый —
  текущий; чеки связываются по фактическому `fnNumber` из чека (не переписываются).
- **Удаление**: `deleteCashRegister` — hard delete ТОЛЬКО если нет чеков/позиций/агрегатов/
  identity/mapping/attribution/закрытых периодов; иначе archive (status=archived, стоп-синк,
  закрыть assignment, история сохраняется). Confirm честно сообщает исход.
- **Полное удаление** (`purgeCashRegisterHistory`): owner/system_admin + capability, повторное
  подтверждение (ввод ФН), dry-run preview, блок при закрытом payroll/периоде, транзакция,
  audit до/после. Обычным ролям недоступно.

## Не менять
Формат чеков, dedupeKey, финансовые движения, snapshot прошлых чеков, payroll-логику. Только
управление кассами + аддитивная история. Provider-import Taxcom/Astral не трогаем.
