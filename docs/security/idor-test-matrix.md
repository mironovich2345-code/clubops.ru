# CLUB-OPS — IDOR Test Matrix

Read-only at `eb8a8f6`. Combines an **executed** synthetic negative-authorization test
(`npm run audit:idor-matrix`, `idor-results.json`) with a static per-object review. **No production IDs
were used; the executed test ran on a disposable copy of the dev sqlite DB (deleted after).**

## Executed synthetic test (the isolation primitive)
Two synthetic companies A/B + clubs in a throwaway DB. Result:
| Check | Result | Meaning |
|---|---|---|
| A reads B's row via `{id, companyId:A}` | **null (ISOLATED)** | scoped read blocks cross-tenant |
| A writes B's row via `updateMany({id, companyId:A})` | **0 rows (ISOLATED)** | scoped write blocks cross-tenant |
| A's list `{id in allowedClubIds=[A]}` | **excludes B (ISOLATED)** | club intersection blocks cross-tenant |
| raw `findUnique({id})` on B | **returns B (control LEAK)** | proves the scope filter is load-bearing (ARCH-005) |
| raw `updateMany({id})` on B | **matches B (control LEAK)** | an unguarded id-keyed write would cross tenants |

The two "LEAK" lines are the **intended control** — they demonstrate that isolation exists only where
the app adds the `companyId`/`allowedClubIds` filter, motivating the per-site verification below. They
are **not** an application leak.

## Per-object substitution review (id swapped to a foreign tenant's object)
For each object, the app path that loads it (detail/update/approve/pay/reverse/cancel/download/export)
was checked for the scope guard. Verdict = does substituting a foreign id succeed?
| Object | read detail | mutate (update/approve/pay/reverse/cancel) | download/export | Verdict |
|---|---|---|---|---|
| Company / Club / LegalEntity | scoped (`canAccessCompany`/allowedClubIds) | scoped | n/a | **BLOCKED** |
| Invoice / InvoicePayment | `getInvoiceForContext` | payment=acct/chief scoped; reverse=chief; CAS | `invoices/[id]/file` scoped | **BLOCKED** |
| Expense / ExpenseDocument | `getExpenseForContext` | scoped + status guards | `expenses/[id]/file` + `documents/[docId]` cross-checked | **BLOCKED** |
| Refund / RefundDocument | `getRefundForContext` | scoped workflow | `refunds/[id]/file` (`?key` cross-checked) | **BLOCKED** |
| BalanceSnapshot / CashRegionalTransfer | scoped `findFirst` | CAS + scope | n/a | **BLOCKED** |
| PayrollPeriod/Calc/Payment/Advance/Obligation | `getPeriodForScope`/`resolvePeriodScope` | scoped + role | n/a | **BLOCKED** |
| Budget / BudgetChangeProposal | scoped | owner/GD, `p.companyId` re-check | n/a | **BLOCKED** |
| Employee (ClubEmployee) | `getEmployeeForScope` | scoped; `removeClubAssignment` clubId gap | n/a | **BLOCKED** (1 LOW: SEC-012) |
| User | display-only lookup by scoped-sourced id | `assertCanManageUser` | n/a | **BLOCKED** |
| File / Document (by storageKey) | download route scopes the **parent entity**, then streams its key | — | key cross-checked to the parent | **BLOCKED** (weak bind: SEC-006) |

## Result
**No IDOR that crosses the company boundary was found** on any object's read, mutate, download, or
export path. The only related weaknesses are LOW: the `storageKey` bind (SEC-006, bounded by key
unguessability + parent-entity scoping) and `removeClubAssignment`'s missing clubId check (SEC-012).
The executed test + the per-object review together verify the isolation the app relies on (ARCH-005).
Production verification: run the scoped loaders against a production read replica with two real tenants
to reconfirm at scale.
