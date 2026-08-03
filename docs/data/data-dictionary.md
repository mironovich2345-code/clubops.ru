# CLUB-OPS — Data Dictionary (critical fields)

Meaning, unit, temporal reference, null semantics, and truth status of the fields that drive money
and scope. Commit `66bc9e3`. Money = integer kopeks unless noted.

## Money fields
| Field | Model | Unit | Refers to | Derived/stored | Truth? | Notes |
|---|---|---|---|---|---|---|
| `amountKopeks` | Invoice/Expense/Refund/InvoicePayment/PayrollPayment/Cash* | kopeks | the transaction | stored | ✅ for its row | invoice/expense/refund = the document total |
| `limitAmountKopeks` | Budget | kopeks | month limit | stored | ✅ | only mutated via approved proposal (salary) |
| `grossAccruedKopeks` | PayrollCalculation | kopeks | accrual for period | **cache** (recompute) | ✅ | **net == gross** (no withholding, `calc.ts:275`) |
| `netPayableKopeks` | PayrollCalculation | kopeks | owed after adjustments | cache | ✅ | = gross here |
| `paidKopeks` | PayrollCalculation | kopeks | actually paid | **cache** of Σ confirmed payments + active tranches | ledger is truth | drift if recompute skipped |
| `remainingKopeks` | PayrollCalculation / PayrollPaymentObligation | kopeks | still to pay | cache (net − paid) | derived | lives in **two** places (double cache) |
| `actualBalanceKopeks` | BalanceSnapshot | kopeks | control checkpoint | stored (manual) | ✅ | never edited (append-only) |
| `expectedCashBalanceKopeks` | DailyCashReconciliation | kopeks | fact at submit | frozen snapshot | attestation | can drift from live fact |
| `refundResultAmountKopeks` | Refund (v2) | kopeks | calculated refund | stored | competes with `amountKopeks` | v2 sets `amountKopeks := result` at calc |

## Date / period fields (which date drives what)
| Field | Model | Type | Drives | Timezone | Null semantics |
|---|---|---|---|---|---|
| `expensePeriod` | Invoice | "YYYY-MM" string | **analytics / budget / profit** (accrual month) | server-local key | null → fallback `invoiceDate→paidAt→createdAt` |
| `paymentDate` | InvoicePayment | DateTime | payment history; sets `paidAt` when full | local | required |
| `paidAt` | Invoice | DateTime? | paid-invoice reporting date | local | null = **not yet fully paid** |
| `invoiceDate` | Invoice | DateTime? | overdue; period fallback | local | null = unknown |
| `dueDate` | Invoice | DateTime? | payment-calendar date **and** reporting month for approved-unpaid (dual use) | local | null = «Без срока» |
| `snapshotDate` | BalanceSnapshot | DateTime | control-point boundary | **local midnight** (written), but audit string uses `toISOString().slice(0,10)` = **UTC** (DATA-022) | required |
| `expenseDate` | Expense | DateTime | fact-balance dating; CashMovement `occurredAt`; budget-route month | local; current-month-only guard | required |
| `operationDate` | CashCollection/Withdrawal/OtherIncome/RegionalTransfer | DateTime | fact-balance date | local | required |
| `businessDate` | DailyCashReconciliation | DateTime | reconciliation day | **local start-of-day** | required |
| `effectiveFrom`/`effectiveTo` | EmployeePayScheme | DateTime | which scheme version applies (`from ≤ t < to`) | **local midnight** | `effectiveTo` null = the live tail |
| `year`/`month` | PayrollPeriod | Int | payroll accrual identity | n/a | required (month 1–12; not DB-checked — DATA-CHK-19) |
| `createdAt` | all | DateTime | recorded-at | `@default(now())` | **last-resort** business-date fallback for refunds/invoices (flagged) |

**No per-club timezone anywhere** (`cash-reconciliation.ts:60`, payroll pay-date all server-local).
The only UTC usage in money paths: `snapshotDate.toISOString().slice(0,10)` audit strings
(collections/actions.ts:99,103) and `excel-import` `Date.UTC` midnight — both can shift a local day
across midnight on a positive-offset server (DATA-022). The invoice fingerprint uses UTC by design
(non-financial).

## Tenant / scope fields
| Field | Meaning | Enforcement | Null semantics |
|---|---|---|---|
| `companyId` | owning company | relational models: FK to Company; scalar models: **none** | never null on financial rows |
| `clubId` | owning club | FK on relational; scalar on payroll/cash/OFD | null = company-level (rare) |
| `legalEntityId` | ИП/ООО attribution | Invoice/Expense: FK+SetNull; Refund/payroll/cash-B: **scalar, app-only** | null = **overloaded**: unknown / not-yet-assigned / SetNull-orphaned after LE delete (DATA-009) |
| `employeeId` | ClubEmployee | scalar, no FK | on `EmployeeFinancialObligation` can hold a **RegionalCityPayroll.id** when `regionalEmployeeId` null (DATA-010) |
| `entryVersion` | 1=legacy / 2=current | Int default 1 | discriminates Expense/Refund v1 vs v2 workflows |

## Status / lifecycle fields
| Field | Meaning | Truth | Notes |
|---|---|---|---|
| `status` | lifecycle state | see `state-machines.md` | `Invoice.status` is a **cache** of the payment ledger; 40 models carry `status` |
| `idempotencyKey` | replay guard | `@unique` on InvoicePayment/PayrollAdvancePayment/PayrollPaymentObligation/CashRegionalTransfer | **PayrollPayment has none** (DATA-003) |
| `prePaymentStatus` | approved status before first payment | canonical snapshot | null on legacy → reversal falls back to current |
| `supersedesSnapshotId` / `supersedesSchemeId` | version chain | app-maintained | broken chain possible if same-date races (DATA-012/013) |

## Overloaded-null fields (null means >1 thing — findings)
- `legalEntityId` — unknown vs not-yet-assigned vs SetNull-orphan (DATA-009).
- `paidAt` (Invoice) — not-yet-paid vs partially-paid (one `paidAt` for many payments).
- `expensePeriod` — genuinely unknown vs legacy-null-fallback.
- `PayrollPaymentObligation.sourceCalculationId` / `PayrollPayment.cashMovementId`/`sourceId` — **always null** (never written; dead fields, DATA-023) — a reader can't distinguish "no source" from "not populated."
