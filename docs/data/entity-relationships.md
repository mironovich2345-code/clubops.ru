# CLUB-OPS — Entity Relationships

Factual ER map at commit `66bc9e3`. Relation/onDelete data: `docs/audits/data/relation-risks.json`.
**Key structural fact:** the DB provider is SQLite (dev) / Postgres (prod) with **no composite
foreign keys** — a `@relation` FK only proves the referenced row *exists*, never that it shares the
same tenant. So on every denormalized tenant scalar (`companyId`/`clubId`/`legalEntityId`), a
cross-tenant mismatch is **DB-possible**; consistency is application-enforced (DATA-007).

## Relation enforcement summary
| Group | FK style | onDelete | Tenant consistency |
|---|---|---|---|
| Invoice, InvoicePayment, Expense, Refund, Budget, BalanceSnapshot, CashWallet, CashMovement, Sale, MandatoryPayment, documents | **relational** (`@relation`) | mostly **Cascade** to Company/Club; **SetNull** to LegalEntity; **Restrict** to createdBy User | composite not enforced → mismatch possible |
| **All payroll models, CashCollection/Withdrawal/OtherIncome/RegionalTransfer, all OFD, AuditLog** | **scalar-only, NO relations** | **none** | entirely app-enforced; delete leaves orphans |

## Delete/cascade risk (from relation-risks.json — 56 Cascade, 11 SetNull)
- **Company → Club/LegalEntity/Invoice/Expense/Refund/Budget/BalanceSnapshot/CashWallet/CashMovement/Sale/… = Cascade**, and **Company has no soft-delete** → a hard delete wipes relational financial history **and** orphans the scalar-id payroll/cash/OFD/audit rows (partial, inconsistent destruction). **DATA-008 (P0/P1).**
- **LegalEntity → BalanceSnapshot = Restrict** (protective). **LegalEntity ← Invoice/Expense/Sale/MandatoryPayment = SetNull** → historical rows silently lose ИП/ООО attribution. **DATA-009.**
- **createdBy = Restrict** everywhere + User soft-tombstone → relational creators never orphan. But reviewer/approver/paidBy ids on scalar-only models are unenforced. **DATA-025.**

---

## Diagram 1 — Company / Club / LegalEntity / User
```mermaid
erDiagram
  Company ||--o{ Club : "cascade"
  Company ||--o{ LegalEntity : "cascade"
  Club ||--o{ ClubLegalEntity : "cascade"
  LegalEntity ||--o{ ClubLegalEntity : "cascade"
  Company ||--o{ CompanyUserAccess : "cascade"
  Club ||--o{ ClubUserAccess : "cascade"
  User ||--o{ CompanyUserAccess : "cascade"
  User ||--o{ ClubUserAccess : "cascade"
  Company ||--o{ Invite : "cascade"
  Club ||--o{ ClubEmployee : "cascade"
  Company ||--o{ ClubEmployee : "scalar companyId (no FK)"
```

## Diagram 2 — Invoices / InvoicePayments / Expenses
```mermaid
erDiagram
  Company ||--o{ Invoice : "cascade"
  Club ||--o{ Invoice : "cascade"
  LegalEntity |o--o{ Invoice : "SetNull (attribution loss)"
  Invoice ||--o{ InvoicePayment : "cascade; ledger (idempotencyKey)"
  Invoice }o--|| User : "createdBy Restrict"
  Company ||--o{ Expense : "cascade"
  Club ||--o{ Expense : "cascade"
  LegalEntity |o--o{ Expense : "SetNull"
  Expense ||--o{ ExpenseDocument : "cascade; companyId scalar"
  InvoicePayment }o..|| Invoice : "companyId scalar (mismatch possible)"
```

## Diagram 3 — Refunds
```mermaid
erDiagram
  Company ||--o{ Refund : "cascade"
  Club ||--o{ Refund : "cascade"
  Refund ||--o{ RefundDocument : "cascade; companyId/clubId scalar"
  Refund }o--|| User : "createdBy Restrict"
  Refund }o..o| LegalEntity : "legalEntityId SCALAR, no relation (app-scoped)"
  Refund }o..o| User : "paidBy/regionalReviewedBy scalar (unenforced)"
```

## Diagram 4 — Cash / Collections / Snapshots (two contours)
```mermaid
erDiagram
  Company ||--o{ BalanceSnapshot : "cascade"
  Club ||--o{ BalanceSnapshot : "cascade"
  LegalEntity ||--o{ BalanceSnapshot : "RESTRICT (protective)"
  BalanceSnapshot }o..o| BalanceSnapshot : "supersedesSnapshotId (chain)"
  Company ||--o{ CashWallet : "cascade (LEGACY contour A)"
  CashWallet ||--o{ CashMovement : "fromWallet/toWallet SetNull"
  Club ||..o{ CashCollection : "SCALAR only (contour B, no FK)"
  Club ||..o{ CashWithdrawal : "SCALAR only"
  Club ||..o{ CashOtherIncome : "SCALAR only"
  Club ||..o{ CashRegionalTransfer : "SCALAR only (payer LE + recipient unenforced)"
  Club ||..o{ DailyCashReconciliation : "SCALAR only; unique(club,LE,businessDate)"
```

## Diagram 5 — Payroll / Budget / Obligations / Payments (all scalar links)
```mermaid
erDiagram
  PayrollPeriod ||..o{ PayrollCalculation : "payrollPeriodId scalar; unique(period,employee)"
  PayrollCalculation ||..o{ PayrollPayment : "payrollCalculationId scalar; NO idempotency"
  PayrollCalculation ||..o{ PayrollAdvance : "matched by (emp,club,year,month) NOT id"
  PayrollAdvance ||..o{ PayrollAdvancePayment : "tranche; idempotencyKey"
  PayrollPeriod ||..o{ PayrollPaymentObligation : "generated; idempotencyKey; sourceCalculationId NEVER set"
  PayrollPayment }o..o| Expense : "expenseId scalar (may be null → phantom/unreversible)"
  Expense }o..o| CashMovement : "sourceType/sourceId string polymorphic (contour A)"
  PayrollCalculation ||..o{ EmployeeFinancialObligation : "employeeId scalar (may hold a payroll-row id!)"
  Company ||--o{ Budget : "cascade; unique(club,category,month)"
  Budget }o..o{ BudgetChangeProposal : "append-only, superseded never set"
```

## Diagram 6 — OFD / Revenue / Analytics
```mermaid
erDiagram
  OfdConnection ||..o{ OfdReceiptImport : "scalar companyId"
  OfdReceiptImport ||..o{ OfdReceiptItem : "itemKey unique"
  OfdReceiptImport ||..o{ OfdDailySalesSummary : "recomputed cache (recompute-gated drift)"
  OfdDailySalesSummary ||..o{ OfdRevenueCategoryDailySummary : "category split"
  OfdFiscalDrive ||..o{ OfdCashRegisterMapping : "KKT ↔ legalEntity"
  OfdCashRegisterMapping }o..o| PayrollOfdCashier : "cashier identity map"
```

## Diagram 7 — Files / Documents / AI
```mermaid
erDiagram
  Invoice }o..o| StoredFile : "originalFileName/Mime on-row; blob on disk/S3 (no DB row)"
  Expense ||--o{ ExpenseDocument : "cascade; storageKey unique; sha256 NOT unique"
  Refund ||--o{ RefundDocument : "cascade; 4 slot docs"
  ExpenseDocument }o..o| AiAnalysis : "AI extraction fills fields, not a linked row"
  note "Blobs live on disk/S3; a row without blob or blob without row is possible (orphan file/blob) — DATA (files)"
```

## Cardinality / ownership / delete table (audit-relevant)
| Relation | Card | Nullable | Enforced | onDelete | Mismatch/orphan risk | Finding |
|---|---|---|---|---|---|---|
| Invoice→club | N:1 | no | DB | Cascade | club.companyId may ≠ invoice.companyId | DATA-007 |
| Invoice→legalEntity | N:1 | yes | DB+app | SetNull | LE of another company; attribution loss on delete | DATA-007/009 |
| InvoicePayment→invoice | N:1 | no | DB | Cascade | `companyId` scalar may mismatch invoice | DATA-007 |
| Refund→legalEntity | scalar | yes | **app-only** | — | LE cross-company; unenforced | DATA-007 |
| PayrollPayment→calc/employee/LE | scalar | mixed | **none** | — | any mismatch; orphan on delete | DATA-007/025 |
| EmployeeFinancialObligation→employee | scalar | yes | **none** | — | **can hold a RegionalCityPayroll.id** | DATA-010 |
| BalanceSnapshot→legalEntity | N:1 | no | DB | **Restrict** | protective | — |
| Company→(all relational children) | 1:N | no | DB | **Cascade** | wipes financial history; no soft-delete | DATA-008 |
| LegalEntity→BalanceSnapshot | 1:N | no | DB | Restrict | protective | — |
| LegalEntity←Invoice/Expense/Sale | 1:N | yes | DB | **SetNull** | orphan attribution | DATA-009 |
