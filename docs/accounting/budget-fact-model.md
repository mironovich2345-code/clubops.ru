# CLUB-OPS — Budget-Fact Model

Every definition of budget "fact"/"used" at `d161c15`, and where they disagree (DATA-018/019 →
FIN-003). Money = kopeks. Plan = `Σ Budget.limitAmountKopeks` for the scope's clubs in the month
(agreed by all functions). Cancelled/rejected excluded everywhere.

## Budget-fact comparison (one row per function)
| Function | Expense statuses | Invoice statuses | Refund statuses | Invoice period | Refund date | Reader |
|---|---|---|---|---|---|---|
| `computeUsedKopeks` (`budgets.ts:76`) | **confirmed+verified** (`:98`) | approved-unpaid **+ paid** (`:91`) | approved-unpaid+paid (`:104`) | `expensePeriod` | `refundDate??createdAt` | budgets "Использовано" + `evaluateExpenseBudget` gate |
| `computeBudgetOverruns` (`budgets.ts:162`) | **confirmed ONLY** (`:182`) | approved-unpaid+paid (`:185`) | approved-unpaid+paid (`:190`) | `expensePeriod` | `refundDate??createdAt` | overrun alerts |
| `computeBudgetFactReport` (`budgets.ts:280`) | **confirmed ONLY** (`:306`) | **paid ONLY** (`:310`) | **paid ONLY** (`:315`) | `expensePeriod` | `paidAt??refundDate??createdAt` | budgets Plan/Fact tab + analytics block 7 |

## The disagreements (FIN-003)
1. **v2 `verified` expenses dropped by Plan/Fact + overruns.** `computeBudgetFactReport` (`:306`) and `computeBudgetOverruns` (`:182`) filter `status==="confirmed"` (v1 only); `computeUsedKopeks` (`:98`) and analytics (`analytics.ts:204`) count `confirmed`+`verified`. → a v2 verified expense is in "Использовано" and in analytics spend/profit, **but invisible** in "План/Факт" and overrun alerts. Aggravating: `getBudgetFactReportForScope` (`:355`) **loads** verified rows that `computeBudgetFactReport` then **discards** (FIN-017 — latent trap + wasted query).
2. **Invoice fact = committed vs realized.** `computeUsedKopeks`/`computeBudgetOverruns` treat an **approved-unpaid** invoice as used; `computeBudgetFactReport` counts **paid only**. A `partially_paid` invoice is in **neither** (not approved-unpaid, not paid) → invisible to all three until fully paid (FIN-002).
3. **Refund period source differs.** `refundDate??createdAt` (used/overruns) vs `paidAt??refundDate??createdAt` (fact-report). v2 refunds never set `refundDate`, so the same paid refund lands in **different months** across reports (DATA-021 / FIN-015).

## Refund in budgets — single-effect
A refund is counted once, under the **`refunds` category limit** (`budgets.ts:103,314,189`), as "used"/
"fact". It is **not** a revenue reduction and creates **no** Expense row. The only nuance is the
committed-vs-realized stage difference above — never a double count within one report.

## What "budget fact" should mean — business decision (BD-04)
Three definitions coexist. The owner/accountant must decide: **is budget "fact" approval-committed or
paid-realized, and does it include v2 verified expenses?** Until fixed, the budgets page ("Использовано")
and the Plan/Fact tab / overrun alerts can show **different fact numbers for the same period** — so
overrun decisions may be made on a figure that excludes a chunk of real (verified) spend.

**Can budget fact be trusted?** Not as a single number — it has three definitions that disagree on
v2 verified expenses and on committed-vs-paid invoices. Reconcile (FIN-003, P1) before launch.
