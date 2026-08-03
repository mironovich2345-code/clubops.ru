# CLUB-OPS — Accounting Recognition Matrix

When each transaction becomes a P&L expense, a cash event, a budget-fact event, and a profit event,
and by which date. Commit `d161c15`. `machine-readable: docs/audits/data/formula-matrix.json`.

## Recognition matrix
| Transaction | Recognition event (→ P&L) | Recognition date | Cash event / date | Budget event | Profit event | Accrual method |
|---|---|---|---|---|---|---|
| **cash Expense (v2)** | `verify` (status→`verified`) | `expenseDate` | ИП wallet(A) + fact(B) at verify / `expenseDate` | used=confirmed+verified; fact-report=confirmed-only | included (confirmed+verified) | by `expenseDate` |
| **Invoice (unpaid)** | **none** — obligation only | — | none | committed (used) only | none | — |
| **Invoice paid** | status→`paid` | `expensePeriod` | InvoicePayment ledger / `paymentDate` | fact by `expensePeriod` | included by `expensePeriod` | **accrual (expensePeriod)** |
| **Invoice partially_paid** | *(none — excluded)* | `expensePeriod` | InvoicePayment | **NEITHER used nor fact-report** | **EXCLUDED** | expensePeriod |
| **historical paid Invoice** | created already `paid` (+ ledger backfill) | `expensePeriod` | ledger row (`legacy:<id>`) | fact | profit | accrual |
| **PayrollCalculation** | accrual = **liability, not P&L** | period year/month | none | payroll budget module only | **NOT counted** | period |
| **PayrollPayment** | the salary **Expense** it creates | payment `expenseDate` | Expense(B)+CashMovement(A) | as an Expense | as the salary Expense | expenseDate |
| **Refund (v2)** | status→`paid` | `paidAt` | chosen legalEntity / `paidAt` | category `refunds` (single-effect) | added to SPEND (no revenue reduction, no Expense row) | `paidAt` |
| **tax** | as Expense category `taxes` | `expenseDate` | as expense | category `taxes` | as expense | **no tax model (BD-13)** |
| **mandatory payment** | via its resulting expense/invoice | dueDate → expense date | when paid | — | via expense | — |
| **correction / reversal** | status flip + compensating row | event date | reverses A & B independently | drops from fact | reverses | — |

## The §4 questions — proven answers (file:line)
1. **Is an Invoice an expense or only an obligation?** Only an **obligation** until `status=paid`; analytics counts `status:"paid"` invoices only (`analytics.ts:205`); it hits P&L by `expensePeriod` (accrual), not payment date. **FIN-002:** `partially_paid` is in neither the paid set nor the approved-unpaid set → invisible to profit/budget-fact.
2. **Does InvoicePayment create a new expense?** No — **only a money movement**. Analytics/budgets read `Invoice` (by `expensePeriod`), **never** `InvoicePayment` (`invoice-payments.ts:1-3`). So no double count between accrual and payment.
3. **Do partial payments double-count the expense?** No (the expense is the invoice, recognized once by `expensePeriod`; payments only move cash).
4. **Post-factum invoice double-count?** No — a historical invoice is one invoice recognized once by `expensePeriod`; backfill adds a ledger row without a second expense.
5. **Are payroll accrual AND payment both counted as expense?** **No** — the accrual (`PayrollCalculation`) is a **liability**, absent from every profit reader; only the salary **Expense** created by `PayrollPayment` is the P&L expense. (Caveat FIN-001: because payroll is absent from profit entirely, profit **understates** labor cost unless a salary Expense exists.)
6. **Is a client refund counted once?** Yes — single-effect: a separate expense (category `refunds`), no Expense row, not a revenue reduction (`refund-document-actions.ts:668,729`). (FIN-009 asks whether single-effect is the *intended* rule.)
7. **Does reversal restore the correct fact?** Invoice-payment reversal (chief-only, CAS) and salary-expense cancellation restore the derived figures — **except** when a payroll payment's `expenseId` is null (phantom), where `cancelSalaryExpense(null)` no-ops (ARCH-002/DATA-016).
8. **Rejected/cancelled excluded from expense?** Yes — cancelled/rejected are never in the counted status sets.

## Reconciliation equations (checked by `npm run audit:financial-reconciliation`)
- **Invoice:** `amountKopeks == Σ confirmed InvoicePayment + remaining` — violated by ledgerless paid (DATA-005) and overpay. (REC-INV-1)
- **Payroll calc:** `netPayableKopeks == paidKopeks + remainingKopeks` — dev DB has **1 violating row** (REC-PR-1); recompute-gated cache (FIN-013).
- **Payroll paid:** `paidKopeks ⊇ Σ confirmed PayrollPayment (+ active tranches)` — a paid < confirmed-payments would be a recompute bug. (REC-PR-2)
- **Obligation:** `remainingKopeks == max(0, amount − paid)` (REC-OBL-1); may **lag** the calc after a swallowed refresh (FIN-012 / DATA-016).
- **Payroll payout integrity:** every confirmed PayrollPayment → an existing salary Expense (REC-ORPH-1) — phantom (null expenseId) / orphan (missing Expense) are ARCH-002 symptoms.
- **Cash:** contour A (wallet) vs contour B (fact) diverge by construction (REC-CASH-1 presence; numeric divergence in `cash-dual-contour-impact.md`).

**A mathematically-balancing equation is NOT proof of an accounting-correct rule** — the recognition
method (accrual vs cash), the refund treatment, and the profit/budget-fact definitions are
**business decisions** (`business-decisions-required.md`), not settled by the code balancing.

## Synthetic scenarios — expected vs current effect (§20, read-only; numbers illustrative)
| # | Scenario | Expected accounting effect | Current effect | Finding |
|---|---|---|---|---|
| 1 | Invoice paid fully | expense once by expensePeriod; cash out | ✅ as expected | — |
| 2 | Invoice paid across two months | one expense (accrual month); two cash dates | ✅ expense by expensePeriod, cash by paymentDate | — |
| 3 | Invoice partially paid then reversed | expense visible; on full reversal restore prior status | partial: **invisible to profit/budget**; reversal restores prePaymentStatus | FIN-002 |
| 4 | Post-factum (historical) invoice | one expense by expensePeriod + backfilled ledger | ✅ (backfill adds ledger, no 2nd expense) | — |
| 5 | Payroll accrual + advance + final payment | accrual=liability; advance+payment=cash; net=adv+pay+rem | ✅ net==adv+pay+rem; accrual not in P&L | — |
| 6 | Payroll payment submitted twice | one payment/expense/movement | **duplicate payment+expense+movement** (no idempotency) | FIN-005 |
| 7 | Cash expense after snapshot | −ИП fact once | −fact(B) **and** −wallet(A) | FIN-004 |
| 8 | Cancelled snapshot | opening drops to next active | with date=null recounts all history → jump | FIN-004 |
| 9 | Other income from regional | +ИП cash, not income | ✅ not in profit; but split across A/B tables | FIN-011 |
| 10 | Transfer to regional + return | −ИП on confirm; +ИП on return | ✅ confirmed-only; return via «Иное» | BD-08 |
| 11 | Refund reducing revenue | (if that were the rule) revenue−refund | **NOT** applied — refund is a separate expense | FIN-009/BD-02 |
| 12 | Refund as expense | expense once (category refunds) | ✅ single-effect, no Expense row | — |
| 13 | Shared employee | cost allocated per rule | no rule → company-level fallback | FIN-014/BD-06 |
| 14 | Legal-entity mismatch | blocked / same-entity | DB-possible (no composite FK); refund LE not tied to sale | FIN-014 |
| 15 | Budget fact with v2 verified expense | counted in fact | in "Использовано"+analytics, **not** in Plan/Fact/overruns | FIN-003 |
| 16 | Legacy paid invoice without payment row | expense + recorded payment | expense recognized, `paidTotal=0` (ledgerless) | FIN-006 |

