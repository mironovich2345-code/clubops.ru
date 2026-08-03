# CLUB-OPS — Prisma Model Catalog

82 models at commit `66bc9e3`. The exhaustive machine-readable catalog (per-model fields, tenant
scope, money fields, status, versioning, uniques, relations, onDelete) is
`docs/audits/data/model-catalog.json` (regenerate: `npm run audit:data-model-catalog`). This doc
categorizes them and records the audit-relevant attributes.

## Model classes
| Class | Models |
|---|---|
| **Financial — invoices/expenses/refunds** | Invoice, InvoicePayment, Expense, ExpenseDocument, ExpenseCategory, ExpenseCategoryNameHistory, Refund, RefundDocument |
| **Financial — budgets** | Budget, BudgetApprovalRequest, BudgetChangeProposal |
| **Financial — cash (current contour B)** | BalanceSnapshot, CashCollection, CashWithdrawal, CashOtherIncome, CashRegionalTransfer, DailyCashReconciliation |
| **Financial — cash (legacy contour A)** | CashWallet, CashMovement |
| **Financial — payroll** | PayrollPeriod, PayrollCalculation, PayrollAdjustment, PayrollPayment, PayrollAdvance, PayrollAdvancePayment, PayrollPaymentObligation, PayrollChangeRequest, EmployeeFinancialObligation, EmployeePayScheme, PayrollStatement, PayrollStatementRow, RegionalCityPayroll, RegionalCityPayment |
| **Financial — payments/sales** | MandatoryPaymentPlan, Sale, SalesReport, SalesReportLine, SalesPlan |
| **Reference / dictionary** | Company, Club, LegalEntity, ClubLegalEntity, ClubEmployee, PayrollOfdCashier |
| **Workflow** | MonthClose, MonthReopenRequest, ImportBatch |
| **External integration (OFD)** | OfdConnection, OfdReceiptImport, OfdReceiptItem, OfdDailySalesSummary, OfdRevenueCategoryDailySummary, OfdCashRegisterMapping, OfdCashRegisterAssignment, OfdFiscalDrive (+ related) |
| **Notifications** | NotificationOutbox, CashNotification, TelegramConnection, TelegramLinkCode |
| **Auth / access** | User, Session, CompanyUserAccess, ClubUserAccess, UserClubAccess, Invite, EmailOtpChallenge, AccountDeletion, AccountSessionContainer, SettingsPinSession |
| **Audit** | AuditLog |

## Immutable / versioned records (append-only intent)
| Model | Version field | Immutable amount/date? | Supersede/reverse | One-active enforced | Note |
|---|---|---|---|---|---|
| **BalanceSnapshot** | `version` | ✅ amount/date never edited | `supersedesSnapshotId` | ❌ **app-only, race window** (no `@@unique(club,LE,date)`) | correction/cancel are compare-and-set; **insert is check-then-create** (DATA-012) |
| **EmployeePayScheme** | `version` | ✅ params frozen once committed (gated by `status!=="draft"`) | `supersedesSchemeId` | ❌ **read-then-write in tx, not CAS** | two concurrent approvals could both create active (DATA-013) |
| **InvoicePayment** | — | ✅ reversal = status flip, amount kept | `reversesPaymentId` | n/a | **model example** — `idempotencyKey @unique`, P2002=duplicate-success |
| **PayrollPayment** | — | ✅ cancel = status flip | none | n/a | **NO idempotencyKey** (DATA-003); "paid" = confirmed-only, no minus-reversed |
| **PayrollAdvancePayment** | — | ✅ reverse = status flip | `reversedAt` | n/a | `idempotencyKey @unique` |
| **PayrollChangeRequest** | — | ✅ proposed value written once | `appliedToken @unique` | apply-once ✅ (token) | strongest exactly-once in the codebase |
| **BudgetChangeProposal** | — | ✅ | `appliedBudgetId` | ❌ status-check only, not CAS | |

## Tenant scoping (from the catalog)
- **66 models carry `companyId`, 58 `clubId`, 31 `legalEntityId`** — heavily denormalized.
- **Two FK styles coexist:** (1) relational models with DB-enforced `@relation` + `onDelete`
  (Invoice, Expense, Refund, Budget, BalanceSnapshot, CashWallet/Movement, Sale…); (2)
  **scalar-only models with NO relations at all** — the entire payroll module, the current cash
  contour (CashCollection/Withdrawal/OtherIncome/RegionalTransfer), all OFD models, and AuditLog
  keep `companyId/clubId/legalEntityId` as bare strings (schema comment: "scalar ids, like
  AuditLog"). For these, **zero FK enforcement** — tenant consistency is application-only (DATA-007,
  DATA-025).

## Money fields
97 money fields across 39 models — **all `Int` kopeks**, 0 non-integer, 0 unsuffixed
(`docs/audits/data/money-fields.json`). Money typing is clean; the risks are in *relationships and
caches*, not field types. JSON-embedded money exists in `totalsJson` / `schemeSnapshotJson` /
`detailsJson` / `proposedValueJson` (snapshots, not live truth).

## Soft-delete / archive posture
- **Present:** Club (`isActive`/`archivedAt`), LegalEntity (`isActive`), ClubLegalEntity, ClubEmployee (`status`/`dismissedAt`), User (tombstone `deletedAt` — never physically deleted), Invoice/Expense/Refund (status `canceled`/`rejected`), BalanceSnapshot (`cancelled`), documents (`removedAt`).
- **Absent — the one dangerous case: `Company` has no soft-delete.** A hard delete cascades all
  relational financial history and orphans every scalar-id payroll/cash/OFD/audit row (DATA-008).

> Status vocabularies per model → `state-machines.md` (Audit 1) + `status-matrix.json`. Financial
> truth sources → `financial-source-of-truth.md`. Relationships → `entity-relationships.md`.
