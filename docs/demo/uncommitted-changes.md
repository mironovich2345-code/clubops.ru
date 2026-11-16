# Исторический снимок изменений перед фиксацией в Git

Ветка: `demo/branch-network-showcase`. Снимок после функционального QA, до ревью и коммитов 16 ноября 2026 года. Это сохранённая исходная опись, а не текущий `git status`. Результаты последующего ревью и проверок — в [отчёте о фиксации](git-review-2026-11-16.md); актуальное состояние определяют Git и история демоветви.

Изменённых отслеживаемых файлов: **139**; новых файлов: **31**; всего: **170**.

Предыдущая работа сохранена, ничего не откатывалось. В этом QA-этапе добавлены исправления финансовых readers/бюджетов/аналитики/календаря, защита статуса зарплаты, фиксация даты возврата, синтетические документы и формы, тесты и отчёты.

## Изменённые отслеживаемые файлы

```text
 M prisma/production/schema.prisma
 M prisma/schema.prisma
 M src/app/(app)/_components/ScopeSwitcher.tsx
 M src/app/(app)/activity/page.tsx
 M src/app/(app)/analytics/expenses/page.tsx
 M src/app/(app)/analytics/ofd-sales/page.tsx
 M src/app/(app)/analytics/page.tsx
 M src/app/(app)/budgets/_components/BudgetImportPanel.tsx
 M src/app/(app)/budgets/_components/SalaryBudgetPanel.tsx
 M src/app/(app)/budgets/page.tsx
 M src/app/(app)/collections/_components/CashTransferForms.tsx
 M src/app/(app)/collections/_components/CollectionForms.tsx
 M src/app/(app)/collections/page.tsx
 M src/app/(app)/dashboard/_components/ClubCard.tsx
 M src/app/(app)/dashboard/_components/OfdSalesOverview.tsx
 M src/app/(app)/dashboard/_components/PlanImportPanel.tsx
 M src/app/(app)/dashboard/_components/RegionalReviewCards.tsx
 M src/app/(app)/dashboard/_components/SalesPlanForm.tsx
 M src/app/(app)/dashboard/_components/SalesPlanImport.tsx
 M src/app/(app)/dashboard/_components/StrategicScopeFilter.tsx
 M src/app/(app)/dashboard/_components/UnconfirmedSalesBlock.tsx
 M src/app/(app)/dashboard/page.tsx
 M src/app/(app)/employees/_components/EmployeeForm.tsx
 M src/app/(app)/employees/page.tsx
 M src/app/(app)/expenses/[id]/page.tsx
 M src/app/(app)/expenses/_components/ExpenseUpload.tsx
 M src/app/(app)/expenses/_components/PayrollUpload.tsx
 M src/app/(app)/expenses/cash/CashPanel.tsx
 M src/app/(app)/expenses/cash/page.tsx
 M src/app/(app)/expenses/page.tsx
 M src/app/(app)/expenses/simple/SimpleExpenseForm.tsx
 M src/app/(app)/expenses/simple/page.tsx
 M src/app/(app)/invoices/_components/HistoricalInvoiceForm.tsx
 M src/app/(app)/invoices/_components/InvoiceAnalytics.tsx
 M src/app/(app)/invoices/_components/InvoiceFilters.tsx
 M src/app/(app)/invoices/_components/InvoiceUpload.tsx
 M src/app/(app)/invoices/page.tsx
 M src/app/(app)/layout.tsx
 M src/app/(app)/mandatory-payments/_components/MandatoryPaymentForm.tsx
 M src/app/(app)/mandatory-payments/page.tsx
 M src/app/(app)/payments/page.tsx
 M src/app/(app)/payroll/_components/AdvanceCreateForm.tsx
 M src/app/(app)/payroll/_components/AssignmentForm.tsx
 M src/app/(app)/payroll/_components/CalculationCard.tsx
 M src/app/(app)/payroll/_components/CreatePeriodForm.tsx
 M src/app/(app)/payroll/_components/PaySchemeForm.tsx
 M src/app/(app)/payroll/_components/PayrollEmptyPeriod.tsx
 M src/app/(app)/payroll/_components/PayrollScopeBar.tsx
 M src/app/(app)/payroll/_components/ProposeChangeSection.tsx
 M src/app/(app)/payroll/_components/RegionalCityForms.tsx
 M src/app/(app)/payroll/advances/page.tsx
 M src/app/(app)/payroll/change-requests/[id]/page.tsx
 M src/app/(app)/payroll/change-requests/page.tsx
 M src/app/(app)/payroll/employees/[id]/page.tsx
 M src/app/(app)/payroll/employees/page.tsx
 M src/app/(app)/payroll/ofd-cashiers/[id]/page.tsx
 M src/app/(app)/payroll/ofd-cashiers/page.tsx
 M src/app/(app)/payroll/page.tsx
 M src/app/(app)/payroll/payments/page.tsx
 M src/app/(app)/payroll/periods/actions.ts
 M src/app/(app)/payroll/periods/page.tsx
 M src/app/(app)/payroll/regional/page.tsx
 M src/app/(app)/payroll/schemes/page.tsx
 M src/app/(app)/payroll/summary/page.tsx
 M src/app/(app)/refunds/[id]/page.tsx
 M src/app/(app)/refunds/_components/MembershipCalcForm.tsx
 M src/app/(app)/refunds/_components/PtCalcForm.tsx
 M src/app/(app)/refunds/_components/RefundDraftEditor.tsx
 M src/app/(app)/refunds/_components/RefundPayForm.tsx
 M src/app/(app)/refunds/_components/RefundUpload.tsx
 M src/app/(app)/refunds/new/[id]/page.tsx
 M src/app/(app)/refunds/new/_components/NewRefundStarter.tsx
 M src/app/(app)/refunds/page.tsx
 M src/app/(app)/refunds/refund-document-actions.ts
 M src/app/(app)/sales/_components/CreateSaleForm.tsx
 M src/app/(app)/sales/_components/SalesReportForm.tsx
 M src/app/(app)/sales/page.tsx
 M src/app/(app)/sales/reports/[id]/page.tsx
 M src/app/(app)/settings/_components/LegalEntities.tsx
 M src/app/(app)/settings/_components/SettingsClient.tsx
 M src/app/(app)/settings/actions.ts
 M src/app/(app)/settings/integrations/ofd/_components/CashRegisterManager.tsx
 M src/app/(app)/settings/integrations/ofd/_components/OfdForms.tsx
 M src/app/(app)/settings/integrations/ofd/actions.ts
 M src/app/(app)/settings/integrations/ofd/page.tsx
 M src/app/(app)/settings/legal-entity-actions.ts
 M src/app/(app)/settings/ofd/astral/_components/AstralSteps.tsx
 M src/app/(app)/settings/ofd/astral/actions.ts
 M src/app/(app)/settings/ofd/astral/steps-actions.ts
 M src/app/(app)/settings/ofd/page.tsx
 M src/app/(app)/settings/page.tsx
 M src/app/(app)/settings/pin-actions.ts
 M src/app/(app)/settings/security/_components/DeleteAccountFlow.tsx
 M src/app/(app)/settings/security/account-actions.ts
 M src/app/(app)/settings/security/actions.ts
 M src/app/(app)/settings/security/delete-actions.ts
 M src/app/(app)/settings/security/telegram-actions.ts
 M src/app/(app)/users/_components/InviteForm.tsx
 M src/app/(app)/users/_components/RoleControls.tsx
 M src/app/(app)/users/actions.ts
 M src/app/(app)/users/page.tsx
 M src/app/(app)/users/role-actions.ts
 M src/app/(app)/workspace/page.tsx
 M src/app/accept-invite/actions.ts
 M src/app/auth-actions.ts
 M src/app/layout.tsx
 M src/app/no-access/page.tsx
 M src/app/onboarding/OnboardingForm.tsx
 M src/app/onboarding/actions.ts
 M src/app/onboarding/page.tsx
 M src/app/restore-account/_components/RestoreFlow.tsx
 M src/app/restore-account/actions.ts
 M src/components/NoCompanyState.tsx
 M src/components/RegionalTaskPanel.tsx
 M src/components/SalesDynamicsChart.tsx
 M src/components/Sidebar.tsx
 M src/lib/ai/openai-client.ts
 M src/lib/ai/yandex-gpt-client.ts
 M src/lib/ai/yandex-ocr-client.ts
 M src/lib/analytics.ts
 M src/lib/budgets.ts
 M src/lib/dashboard-cards.ts
 M src/lib/email.ts
 M src/lib/finance/recognition.ts
 M src/lib/finance/recognized-expense.ts
 M src/lib/health/database-validation.ts
 M src/lib/health/migration-manifest.ts
 M src/lib/invoice-view.ts
 M src/lib/ofd/astral/client.ts
 M src/lib/ofd/taxcom/client.ts
 M src/lib/payroll/aggregate.ts
 M src/lib/payroll/salary-expense.ts
 M src/lib/prisma.ts
 M src/lib/seed.ts
 M src/lib/session.ts
 M src/lib/storage/config.ts
 M src/lib/storage/local-provider.ts
 M src/lib/telegram/client.ts
 M src/middleware.ts
```

## Новые файлы

```text
?? .env.demo.example
?? docs/demo/development.md
?? docs/demo/functional-qa-2026-11-16.md
?? docs/demo/uncommitted-changes.md
?? docs/demo/validation-2026-11-16.md
?? prisma/migrations/20261116110000_standalone_demo/migration.sql
?? prisma/migrations/20261116120000_demo_resource_limits/migration.sql
?? prisma/production/migrations/20261116110000_standalone_demo/migration.sql
?? prisma/production/migrations/20261116120000_demo_resource_limits/migration.sql
?? scripts/_stubs/demo-cache.cjs
?? scripts/_stubs/demo-request.cjs
?? scripts/demo-browser-tests.mjs
?? scripts/demo-finance-browser-tests.mjs
?? scripts/demo-functional-tests.mjs
?? scripts/demo-runtime.mjs
?? scripts/demo-tests.mjs
?? src/app/(app)/demo/reconciliation/page.tsx
?? src/app/api/demo/cleanup/route.ts
?? src/app/api/demo/session/route.ts
?? src/app/demo/actions.ts
?? src/app/demo/page.tsx
?? src/app/robots.ts
?? src/components/DemoDocumentButton.tsx
?? src/components/DemoSummary.tsx
?? src/components/DemoToolbar.tsx
?? src/lib/demo/config.ts
?? src/lib/demo/document.ts
?? src/lib/demo/documents.ts
?? src/lib/demo/fixtures.ts
?? src/lib/demo/reporting.ts
?? src/lib/demo/visits.ts
```

## Резервные копии

Вне checkout, `/workspace/scratch/clubops-functional-qa/`:

- `baseline.patch`, `baseline-status.txt`, `baseline-untracked.tar.gz` — состояние до этого QA;
- `final.patch` — все текущие tracked изменения относительно HEAD демоветви;
- `final-untracked.tar.gz` — все новые неигнорируемые файлы;
- `final-status.txt`, `final-head.txt`, `SHA256SUMS` — manifest, база Git и контроль целостности.

Для восстановления сначала нужен checkout указанного в `final-head.txt` commit этой демоветви, затем применение patch и распаковка новых файлов. Не применять поверх изменённого checkout без проверки существующих файлов. Архивы не содержат `.env.demo.local`, `.env`, секреты, node_modules, тестовую БД или скриншоты; данные воспроизводятся из fixtures.

На момент этого исторического снимка коммиты, push, merge и публикация не выполнялись. В следующем этапе разрешена фиксация и отправка только в `origin/demo/branch-network-showcase`; развёртывание требует отдельного решения владельца. Архивы предназначены для восстановления именно состояния до фиксации и не должны повторно применяться поверх коммитов.
