# CLUB-OPS — Tenant Isolation Review (reads + writes + mass-assignment)

Read-only at `eb8a8f6`. Machine data: `security-read-scope.json`, `security-write-scope.json`,
`idor-results.json`. **Verdict: the tenant boundary holds** — no confirmed cross-tenant read or
unguarded cross-tenant write. Isolation is **application-enforced** (ARCH-005): every read/write must
add `companyId` + intersect `clubId` with `allowedClubIds`; the DB has no composite-FK backstop
(DATA-007/025).

## The isolation primitive (executed proof — `audit:idor-matrix`)
On a disposable 2-tenant sqlite copy (deleted after): the scoped `findFirst({id, companyId:A})` on B's
row returns **null**; `updateMany({id, companyId:A})` on B's row affects **0 rows**; `club.findMany({id
in allowedClubIds=[A]})` never contains B. The **unscoped** `findUnique({id})` / `updateMany({id})`
return/match B's row — the intentional control proving the scope filter is **load-bearing**: isolation
exists only where the app adds it. The scanners below inventory whether each real site does.

## Reads — verdict SAFE
Scanner counted **192 id-keyed reads**; 75 have no `companyId` in the immediate window. Agent review of
the representative + high-risk set (invoices/expenses/refunds/collections/payroll/budgets/dashboard/the
35 page.tsx) found **no reader that trusts a client companyId/clubId or leaks cross-tenant**:
- All scoped loaders (`getInvoiceForContext`, `getExpenseForContext`, `getRefundForContext`,
  `getSalesReportForContext`, `getEmployeeForScope`, `getPeriodForScope`, …) enforce `companyId ===
  selectedCompanyId` + `allowedClubIds.includes(clubId)` + manager-own-only.
- `dashboard/strategic-actions.ts`: the client-supplied `companyId` is validated (`canAccessCompany`)
  **and** the object is cross-checked (`rec.companyId !== companyId → redirect`) — the safe pattern.
- Detail pages reach child rows only through a scope-validated parent (calc via scoped period, doc via
  scoped expense). Display-only `user.findUnique({id})` lookups expose name/email for an id already
  sourced from a scoped row — low, not cross-tenant.

## Writes — verdict SAFE (manual scope, consistently applied)
Scanner counted **112 id-keyed writes**; 67 lack a guard in the immediate window (expected — the guard
is a preceding scoped `findUnique`+companyId check per ARCH-005). Agent review of expenses/collections/
balances/payroll/invoices/refunds/budgets/users found **no genuinely unguarded id-keyed write**: every
`.update/.delete/.updateMany` by id is preceded by a scope-checked load or carries scope in the `where`,
and transitions re-assert `status` in the `where` (TOCTOU-safe). Exceptions (all LOW):
- **SEC-012** `removeClubAssignment` (`payroll/actions.ts:148`) checks company+employee but not `clubId ∈ allowedClubIds`.
- **Defense-in-depth:** lib helpers `cash-wallets.confirmInternalTransfer/confirmOtherCashIncome/recordExpenseMovement`, `salary-expense.cancelSalaryExpense`, `payment-obligation.generateObligationsForPeriod`, `scheme-service.materializeApprovedSchemeChange` mutate by id without their own tenant check — safe **because** every action-layer caller pre-validates scope; none is a directly-invokable server action.
- **Scope-check inconsistency (LOW):** a few sites scope by `clubId ∈ allowedClubIds` only (no explicit `companyId`) — safe today because `allowedClubIds ⊂ selectedCompanyId`, fragile if that invariant changes.

## Mass assignment — verdict SAFE (privileged columns server-controlled)
No spread of raw client `body`/FormData into a Prisma create/update reaches a **privileged** column.
`companyId` = `ctx.selectedCompanyId`; `clubId` validated against the accessible set; `status`/
`entryVersion`/timestamps = server literals; `*ByUserId` = `ctx.user.id`. The `data: parsed.data` sites
(expenses/refunds) spread a **validated, whitelisted** typed object, not raw input. Residual client-trusted
fields (all bounded / low): **file `storageKey`** on expense v1 + payroll statement (SEC-006 — a user can
bind their own record to a foreign blob key, bounded by 128/256-bit key unguessability + the download
route scoping the parent), client **`idempotencyKey`** on regional transfer (SEC-015, dedupe nuisance),
client **`confidence`** on invoice/refund (SEC-007, defeats a review nudge only).

## Bottom line
**No cross-tenant read or write was found.** The isolation is correct but **manual** (ARCH-005) — its
safety depends on every one of ~112 id-keyed writes and ~192 reads carrying the scope filter, which the
review confirms they do today, with a DB tenant-scope extension recommended as defense-in-depth so a
single future omission cannot become an IDOR.

## Update (REM-07)
Tenant isolation stays application-enforced (ARCH-005, NOT closed by REM-07). REM-07 adds OBSERVABILITY:
a cross-tenant/scope denial now records a `SecurityEvent` (high severity for company-scope/cross-tenant-key)
so probing is detectable. The external response is unchanged (generic; object existence not leaked). A DB
tenant-scope backstop remains a separate remediation (REM-20). See `docs/remediation/rem-07-final-report.md`.
