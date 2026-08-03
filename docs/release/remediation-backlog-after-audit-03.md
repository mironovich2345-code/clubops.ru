# Remediation Backlog — after FULL AUDIT 3/6 (Accounting Model)

From `docs/audits/full-audit-03-accounting-model.md` (FIN-###), linked to ARCH-/DATA- findings and
the business decisions (BD-##). Target: before **2026-08-18**. Nothing fixed during the audit.
Effort XS/S/M/L/XL. **A code fix that depends on a business decision must NOT ship until the decision
is ratified** — implementers do not pick accounting rules unilaterally.

## Ordering principle
Business decision → then code. Many FINs are gated on a BD (profit BD-03, budget-fact BD-04, cash
contour BD-09, tax BD-13, refund BD-02). Ratify these first (a short accountant/owner session), then
implement. Run `audit:financial-reconciliation` on a **production read replica** before AND after any
data-affecting fix.

## P0 — release blockers (double money / untrustworthy core numbers)
| ID | Task | BD | Deps | Schema? | Data migration? | Live gate | Effort |
|---|---|---|---|---|---|---|---|
| FIN-005 | `PayrollPayment.idempotencyKey @unique` + wrap payout in `$transaction` (double salary payment → double expense) | — | ARCH-002, DATA-003 | **yes (additive)** | no | **yes** (staging double-click) | M |
| FIN-004 | One cash resolver; collapse to contour B; stop expense/payroll double-writing contour A; add ООО cash-expense term if BD-16 says ООО pays cash | BD-09/08/16 | ARCH-001/006, DATA-001/002 | maybe | **yes (reconcile A vs B first)** | yes (compare all cash screens) | L |

## P1 — before 18 Aug (numbers can't be trusted until fixed)
| ID | Task | BD | Deps | Effort |
|---|---|---|---|---|
| FIN-001 | One profit definition; **include payroll cost**; retire dead `dashboard.ts` profit | **BD-03** | — | M |
| FIN-003 | One budget-fact definition; include v2 `verified` in Plan/Fact + overruns | **BD-04** | DATA-019 | M |
| FIN-002 | Declare `partially_paid`; count its paid portion (or accrual) consistently across profit/budget/calendar | — | ARCH-008 | S |
| FIN-006 | Verify invoice `pay` UI; retire/convert the ledgerless legacy pay | — | ARCH-010, DATA-005 | S |
| FIN-012 | Fold `refreshPeriodObligations` into the payment transaction (no stale "к выплате") | — | ARCH-002, DATA-016 | S |
| FIN-010 | Confirm `Sale` vs `SalesReport` never overlap (no double-counted revenue); reconcile on prod | **BD-14** | — | S |
| FIN-013 | Reconcile `PayrollCalculation` net==paid+remaining (fix the 1 dev row source; add recompute guard) | — | — | S |
| FIN-014 | Fix DATA-010 (obligation.employeeId); ratify LE attribution for refund/regional/shared payroll | BD-06/07/11 | DATA-010 | M |
| FIN-016 | Decide whether ООО pays cash expenses; if yes add the ООО cash-expense term to the fact formula | BD-16 (new) | FIN-004 | S |
| FIN-007 | BUSINESS DECISION on tax/VAT model before any tax feature (no invented rates) | **BD-13/05** | — | S (decision) |
| FIN-008 | Unify payroll bp-rounding across the two engines (one confirmed rule) | BD (rounding) | — | M |

## P2 — after launch
| ID | Task | Effort |
|---|---|---|
| FIN-009 | Ratify refund single-effect (BD-02); align v1/v2 stage + refund date basis | S |
| FIN-011 | Converge the two «Приход Иное» stores | M |
| FIN-015 | One fact-date policy (BD-12); local-date formatting (UTC drift) | S |
| FIN-017 | Align `getBudgetFactReportForScope` query with `computeBudgetFactReport` filter | XS |

## Business decisions to ratify FIRST (blockers on the above)
BD-03 (profit), BD-04 (budget fact), BD-09 (official cash contour), BD-13 (tax model), BD-02 (refund
treatment) — see `docs/accounting/business-decisions-required.md`. Without these, FIN-001/003/004/007/009
cannot be implemented correctly.

## Production verification (run BEFORE any fix)
`npm run audit:financial-reconciliation` on a **production read replica** (`--company/--club/--month`):
REC-INV-1 (ledgerless/overpay), REC-PR-1 (payroll cache), REC-ORPH-1 (phantom/orphan payments),
REC-CASH-1 (dual-contour), plus `audit:data-integrity`. A clean dev result proves nothing about prod.

## Coupling to prior audits
FIN-004→ARCH-001/006+DATA-001/002; FIN-005→ARCH-002+DATA-003; FIN-006→ARCH-010+DATA-005;
FIN-012→ARCH-002+DATA-016; FIN-002→ARCH-008; FIN-003→DATA-018/019; FIN-014→DATA-010. Sequence the
write-path (ARCH) fix before the data (DATA) backfill before the accounting-definition (FIN) change.
