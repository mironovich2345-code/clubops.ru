# CLUB-OPS — Payroll module audit & implementation plan

**Date:** 2026-07-23 · **Base commit:** `8cc9e74` (main) · **Author:** payroll module design.
**Scope:** audit the existing financial + HR contours and design a full payroll (ФОТ) module, then implement it stage by stage without breaking or duplicating existing logic.

Legend: **[ФАКТ]** verified in code · **[ВЫВОД]** inference · **[РИСК]** risk · **[?]** open business question · **[ДОПУЩЕНИЕ]** assumption taken (no explicit rule found).

---

## 1. What already exists (and can be reused)

### 1.1 Employees — `ClubEmployee` [ФАКТ]
`prisma/schema.prisma model ClubEmployee`: `id, companyId, clubId, fullName, position (manager | administrator | gym_trainer | group_trainer | night_manager), status (active | dismissed), dismissedAt, comment`, relation `salesReports: SalesReport[]`. Managed by `src/lib/club-employees.ts` + `src/app/(app)/employees/*`.
- **Single club only** (`clubId`), **no** hire date, **no** pay scheme, **no** payment method, **no** legal entity, **no** official/managerial flag.
- Position list is a SUBSET of the payroll spec (missing: `head_gym_trainer`/старший тренер, `senior_group_trainer`/старший групповой, `regional_director`). Regional director is a **User role**, not a `ClubEmployee`.
- **Reuse:** yes — extend `ClubEmployee` additively; add a many-to-many club assignment; do NOT create a second employee model.

### 1.2 Existing payroll = document (ведомость) flow [ФАКТ]
`PayrollStatement` + `PayrollStatementRow` (schema) + `src/lib/payroll.ts` + `src/app/(app)/expenses/payroll-actions.ts`:
- Upload a **signed payroll statement** (Excel/scan) → AI extracts rows → `payrollRowHash` dedup → newly-signed rows are counted **once** (`countedAt`) into **one** `Expense{category:"salary"}` (`payroll-actions.ts:341`).
- Signature detection (`isSigned`, `signatureDetectedConfidence`), `@@unique([companyId, clubId, rowHash])`.
- **This is "record what was already paid", NOT a calculation engine.** [ВЫВОД] It maps to the NEW module's *payment statement attachment* (§3.8 of the spec): the signed ведомость becomes the document proving a `PayrollPayment`. It must **not** be deleted; the new payment flow should be able to reference/replace it over time.

### 1.3 Trainer / session math already in code [ФАКТ]
`src/lib/refund-personal-training.ts` + `src/lib/refund-membership.ts`:
- `ceilToRubleKopeks(kopeks)` — round UP to whole rubles (used across all money results). **Reuse verbatim.**
- Session price = `contractAmount / sessionCount`; trainer income concepts (paid vs used sessions) partly exist for refunds. **Reuse the pattern** for trainer payroll (`sessionPrice × rate`) and the **trainer credit** (paid-but-not-provided) calculation.
- `DateOnly`, `computePlannedRefundDate` (10-day + weekend shift) — reusable date helpers.

### 1.4 Finance contour to integrate with [ФАКТ]
- **Salary → expense:** today one lump `Expense{category:"salary", entryVersion, paymentMethod}` per statement. Cash-paid v2 expenses create an idempotent `CashMovement` (`cash-wallets.ts recordExpenseMovement`) and reduce the ИП fact balance; analytics counts realized expenses. **"salary" is a system ExpenseCategory** (post the category-isolation change).
- **Cash:** balances are DERIVED (never stored) from `BalanceSnapshot` + OFD cash + `CashCollection`/`CashWithdrawal`/`CashOtherIncome` − ИП expenses (`cash-balances.ts`, `cash-collections.ts`). "Приход Иное" = `CashOtherIncome`.
- **Legal entity:** resolved per club via `ClubLegalEntity` (`getActiveClubLegalEntities`); one active ООО + one active ИП per club.
- **Reuse:** the single-source rule (§8) — accrual = obligation, payment = the money movement; a cash payment must reduce the wallet exactly once via the existing expense/cash-movement plumbing.

### 1.5 Workflow / approval / month-close / audit / roles [ФАКТ]
- **Approval routing:** `src/lib/approval.ts applyApprovalAction` (draft→needs_review→approved_*→paid) + `hasActiveRegionalApproverForClub` (regional vs chief-accountant fallback). Compare-and-set on status is the standard concurrency guard. **Reuse the pattern** for a dedicated payroll status machine (longer chain).
- **Month close:** `src/lib/month-close.ts` (`monthClosedError`, `isMonthClosed`, `makeMonthCloseChecker`, `MonthClose @@unique[companyId,clubId,month]`). Payroll writes must respect it.
- **Audit:** `recordAudit({action, entityType, entityId, companyId, clubId, userId, metadata})` — masked payloads only. **Reuse.**
- **Roles:** owner, general_director, regional_director, manager, chief_accountant, accountant, marketer. `canMutateOperationalRecords`, `canAnyRoleAccessPage`, `getInvoiceForContext`-style scope loaders, `userHasDirectClubRole` (added last task). **Reuse for permissions.**
- **Notifications:** durable outbox `notifyRegionalReview`/`notifyAuthor`. **Reuse** for the manager→regional→accountant chain.
- **Sales/revenue base:** `SalesReport`(+`SalesReportLine` revenue/subs/PT keys) confirmed reports, `Sale`, OFD daily/category summaries (`OfdDailySalesSummary`, `OfdRevenueCategoryDailySummary`). Manual shift-report entry is disabled; OFD is the live source.

### 1.6 Tests / rounding conventions [ФАКТ]
- No JS test runner (`package.json` has no `test`/vitest/jest). The real suite is `scripts/pilot-*.mjs` + `pilot-full.mjs`. New behavioural tests follow this pattern (pure mirrors + real-DB where relevant + static source guards).
- Money is integer **kopeks**; `ceilToRubleKopeks` rounds results up to whole rubles (matches the manager plan-fact example 36 000 / 28 800).

---

## 2. What is missing (the payroll module)

[ФАКТ] None of the following exist: pay schemes with history, a per-club payroll period, per-employee calculation with breakdown, advances, structured payments, employee/company debts, final settlement, plan-fact manager scheme, revenue/profit % schemes, regional-director payroll, employee↔multiple-clubs, hire date, per-employee payment method/legal entity, the calculation engine, the payroll UI, owner ФОТ aggregates.

**Business-data gaps (need input, see open questions):**
- **[РИСК/?] Per-manager personal sales during a shift** and **per-trainer package sales** are NOT structured today (only club-level `SalesReport` lines + OFD aggregates + free-text `managerName`). The spec needs manager personal net sales and trainer package amounts. **[ДОПУЩЕНИЕ]** v1: these sales bases are **entered as structured input on the payroll calculation** (like trainer "sessions provided" is manual), pending a future sales-attribution feature. The calculation engine takes them as inputs and never invents them.
- **[?] Manager shifts** and **group-trainer hours** have no source table → entered by the manager / senior group trainer (spec §5.1, §4.3).

---

## 3. Conflicts & how they are resolved

| Existing | New | Resolution |
|---|---|---|
| `ClubEmployee` single-club | employee in many clubs with per-club scheme | Add `EmployeeClubAssignment` (M:N) + extend `ClubEmployee` additively (hireDate, paymentMethod, isOfficial, defaultLegalEntityId). Keep `clubId` as the "home club" for back-compat. |
| `PayrollStatement` (signed ведомость → lump salary Expense) | per-employee `PayrollPayment` with statement attachment | Keep the statement flow. New payments may attach a statement; over time the lump flow is superseded, not deleted. **No destructive change.** |
| `Expense{category:"salary"}` lump | payment = obligation settled | A `PayrollPayment` (cash) reuses the SAME cash-movement plumbing so the wallet is reduced ONCE; salary is NOT double-counted. (See §8 single-source rule.) |
| `refund-personal-training` PT math | trainer payroll + trainer credit | Reuse `ceilToRubleKopeks` + session-price pattern; the calc engine is a NEW pure module (does not touch refunds). |

---

## 4. Target data model (additive; names adapted to the codebase)

New models (all `companyId`+`clubId` scoped, kopeks, nullable where legacy-safe):
- **`EmployeeClubAssignment`** — employee↔club M:N: `clubId, position, startDate, endDate?, earningShareBasisPoints?, isActive`.
- **`EmployeePayScheme`** — historical scheme: `employeeId?/position?, clubId, schemeType, paramsJson (validated), effectiveFrom, effectiveTo?, createdByUserId`. Immutable snapshots; a change opens a new row (closed months keep their snapshot).
- **`PayrollPeriod`** — per club+month: `companyId, clubId, year, month, status, submittedAt, regionalApprovedAt, accountingApprovedAt, closedAt, createdBy, version, totalsJson`. `@@unique([clubId, year, month])`.
- **`PayrollCalculation`** — per employee in a period: all snapshot + result fields from spec §3.5 (roleSnapshot, schemeSnapshotJson, base, shifts, hours, sales/revenue/profit base, plan, actual, completion, automaticAmountKopeks, bonuses/deductions/advances totals, grossAccruedKopeks, netPayableKopeks, paidKopeks, remainingKopeks, employeeDebtKopeks, companyDebtKopeks, status, detailsJson, manualOverrideKopeks?, manualOverrideReason?, calculatedAt, approvedAt).
- **`PayrollAdjustment`** — bonus/penalty/…: `payrollCalculationId, employeeId, type, direction, amountKopeks, reason (required), comment, createdBy, approvedBy, status`.
- **`PayrollAdvance`** — `employeeId, clubId, periodYear/Month, earnedToDateKopeks, amountKopeks, paymentMethod, cashSource, status, requestedAt, approvedBy, paidBy, documentKey?`.
- **`PayrollPayment`** — `payrollCalculationId, employeeId, clubId, legalEntityId?, amountKopeks, paymentDate, paymentMethod (cash|bank), sourceType (club_cash|regional_cash|bank_account), sourceId?, paidBy, status, documentKey?, statementId? (→PayrollStatement), bankTransactionId?, comment`.
- **`EmployeeFinancialObligation`** (debt) — `employeeId, clubId?, payrollPeriodId?, direction (employee_owes_company|company_owes_employee), reason, originalAmountKopeks, outstandingAmountKopeks, status, createdBy, approvedBy, dueDate?, closedAt?`. Repayments via `PayrollAdjustment`/`PayrollPayment` references — a repayment is NOT `CashOtherIncome`.

Extend **`ClubEmployee`** (nullable additive): `hireDate?, dismissalDate?(alias of dismissedAt), preferredPaymentMethod?, isOfficial? Boolean, defaultLegalEntityId?`.

All enums live in code (`src/lib/payroll/enums.ts`), stored as TEXT (SQLite has no enums), validated server-side.

---

## 5. Formulas (from spec §4 — all parameters configurable per club/employee)

Implemented in a **pure** engine `src/lib/payroll/calc.ts` (no `eval`; structured params; every result returns a human breakdown):
- **Manager:** `salaryByShifts = base × actualShifts / shiftNorm` (norm param, default 15) `+ netPersonalSales × rate` (rate = belowPlanRate default 3% / atPlanRate default 4%) `+ bonuses − deductions`.
- **Gym trainer:** per package: `sessionPrice = contractAmount/sessionCount`; `trainerIncome = sessionPrice × rate` where rate = `lowRate` (default 40%) if `contractAmount ≤ threshold` (default 20 000 ₽) else `highRate` (default 50%); returns net of client refunds. **Payout gate:** prior-month sales paid this month only if trainer met ≥ `planThreshold` (default 70%) of THIS month's sales plan — a SEPARATE flag from trainer credit. **Trainer credit** = paid-sessions vs provided-sessions (`providedSessions` manual): `allowedPayout = providedSessions × sessionPrice`, `overpaid = paid − allowed`.
- **Group trainer:** `hours × hourlyRate` (rate per club/employee/format). Clients count irrelevant.
- **Senior group trainer:** `fixedSalary + salesPercent × sales` (default 10%).
- **Manager plan-fact (Scheme A):** two parts (subscriptions, PT); each: `completion = fact/plan`; `deviation = 100% − completion`; adjustment step per the scale (0–1%→2%, 1–2%→4%, 2–3%→6%, then +2% per 1%, cap ±40%, >20% deviation → manual flag); `partSalary = base × (1 + signedAdjustment)`. Sales do NOT add a separate percent — they set the salary. (Verified vs examples: 68.78%→−40%→36 000; 98.90%→−4%→28 800.)
- **Manager revenue-% (Scheme B):** `fixed + subsPercent × subsRevenue + ptPercent × ptRevenue` (net of refunds). Only one manager scheme per period. **Streak bonus** (2m→10k, 3m→15k, 4m+→20k, configurable) added when consecutive plans met.
- **Regional director (owner-chosen):** `cityRevenue × percent` OR `cityProfit × percent` (profit = revenue − club expenses − shared − taxes − distributed). Computed per **city**, no guaranteed base; paid in parts from multiple clubs.

---

## 6. Workflow, permissions, finance link, audit (design)

- **Status machine** (`src/lib/payroll/period.ts` pure table): `draft → manager_submitted → regional_review → (needs_correction) → regional_approved → accounting_review → approved → partially_paid → paid → closed`. No illegal transitions.
- **Permissions** (mirror existing helpers): manager = own club (add employees, shifts, hours, bonuses/penalties, advances, form + submit, cash payments, final settlement); regional = all region clubs (review, return, approve, edit until accounting approval, payments, close jointly); accountant/chief = manual corrections (comment required), approve, bank payments, close, prior-period corrections; owner = read ФОТ aggregates only. **Employees never see others' salary; no employee cabinet in v1.**
- **Finance single-source (§8):** accrual = obligation (no money); a **cash `PayrollPayment`** creates the wallet reduction via the SAME idempotent expense/cash-movement path (reduced once); advance = part of the payment (never double-counted at final calc); unpaid remainder = `company_owes_employee` obligation; overpayment = `employee_owes_company`; canceling a payment restores the balance; closed period is immutable.
- **Audit:** every scheme change, calc, override, bonus, penalty, advance, payment, payment-cancel, debt create/repay, approval, return, close, final settlement (masked; server-side permission checks, not UI-only).

---

## 7. Migrations & risks

- **Non-destructive:** only `ADD COLUMN` (nullable) on `ClubEmployee`, `CREATE TABLE` for the new models, indexes + unique constraints. No DROP/TRUNCATE/DELETE; dev SQLite + prod PostgreSQL mirrored. No change to existing financial rows' meaning.
- **[РИСК]** Salary double-counting between the legacy lump-`Expense` flow and new per-employee payments → mitigated by making cash payments reuse the existing expense/cash-movement single-source and NOT auto-creating a second expense.
- **[РИСК]** Manager/trainer sales bases are not structured today → v1 takes them as validated inputs (documented assumption), never invented.
- **[РИСК]** Regional profit needs city-wide expense/tax allocation → v1 computes revenue-% cleanly; profit-% is flagged for the shared-expense allocation model (business decision).

---

## 8. Open business questions ([?] — require a decision, not invented)

1. **Manager/trainer sales attribution:** should personal-sales-during-shift and per-trainer package sales become a structured feature, or stay manual inputs on the calculation? (v1 = manual input.)
2. **Regional profit-%:** exact definition of "shared/distributed expenses" and tax allocation per city. (v1 = revenue-% implemented; profit-% deferred.)
3. **Group-trainer timesheet approver:** spec §4.3 says "manager or regional" — v1 uses the **existing manager→regional review contour** (the timesheet is part of the period the manager submits). Confirm.
4. **Legal entity of a salary payment:** default to the club's active ИП (matches cash expenses) unless the employee has `defaultLegalEntityId`. Confirm.
5. **Advance cap** = "earned to date" — earned by which basis (accrued salary-by-shifts pro-rata?)? v1: `min(requested, currentAccruedToDate)`. Confirm.

---

## 9. Staged implementation plan (each stage = its own commit)

- **Stage 1 (this PR):** audit doc, enums, scheme param validators, the **pure calculation engine** + breakdowns, and the **data model** (schema + non-destructive migrations dev+prod). Behavioural tests for the calculation core (the 40 scenarios' math). ← *delivered here.*
- **Stage 2:** employees (extend), club assignments, pay schemes with history (server actions + minimal UI).
- **Stage 3:** payroll period + per-employee calculation persistence wired to the engine; breakdown rendering.
- **Stage 4:** manager→regional→accountant workflow, permissions, lock-after-approval, corrections.
- **Stage 5:** advances, payments (partial, cash/bank), documents, cash-wallet link (single-source).
- **Stage 6:** debts/overpay/underpay/repayments, final settlement.
- **Stage 7:** UI (main ФОТ page, club page, employee card, scheme settings), owner aggregates, filters, notifications, activity.
- **Stage 8:** sales/OFD integration for the preliminary ФОТ, one-club pilot (`docs/testing/payroll-pilot-scenarios.md`).

## 10. Files added/changed by Stage 1

- **Added:** `src/lib/payroll/enums.ts`, `src/lib/payroll/scheme.ts` (params + validators), `src/lib/payroll/calc.ts` (engine + breakdowns), `src/lib/payroll/period.ts` (status machine), `scripts/pilot-payroll.mjs`, migrations `*_add_payroll_module` (dev+prod), `docs/testing/payroll-pilot-scenarios.md`.
- **Changed (additive only):** `prisma/schema.prisma` + `prisma/production/schema.prisma` (new models + `ClubEmployee` nullable fields), `scripts/pilot-full.mjs`, `package.json`.
- **Not touched:** refunds, invoices, cash balances math, OFD import, existing `PayrollStatement` flow, auth model.
