# REM-02 — Legacy Cutover Plan

The canonical contour is already the official source (no cutover needed to make it authoritative).
`cashCanonicalCutoverAt` only controls when the **legacy double-write stops** for a company. It is set
manually per company, never automatically, after preflight + reconciliation pass on a replica.

## Per-company rollout steps
1. `preflight:cash-cutover --json` on a production read replica → 0 S1 offending rows (fix any duplicate
   active snapshot / cross-tenant / correction-chain first, via the safe plan below).
2. `reconcile:cash-contours --company=<id> --json` → review canonical vs legacy differences (canonical is
   authoritative; differences are historical and explained, not corrected by overwrite).
3. Staging: set `cashCanonicalCutoverAt` on a test company; run `test:rem-02-integration` + `test:rem-01-
   integration` against a disposable PostgreSQL (concurrency gate).
4. Production: set `cashCanonicalCutoverAt = now` for the company. New expense/payroll flows write **no**
   legacy CashMovement; the official balance is unchanged (driven by the Expense/source row).
5. Verify `preflight:cash-cutover` CC-09 (no legacy movement after cutover) stays 0.

## Safe reconciliation classes (never destructive)
duplicate legacy write · missing canonical source · missing legacy write · cancelled-snapshot bug · wrong
status · wrong date · wrong entity type · orphan · historical ambiguity. For each: read-only report →
accountant confirms → a **correction record** (a new snapshot/adjustment) — never a wallet-balance overwrite,
never a legacy-row delete.

## Legacy write guard (§19)
After cutover, `recordExpenseMovement` (and, by extension, the payroll/expense flows that call it) skip the
CashMovement write. Historical reads (`/expenses/cash`, reconciliation) still work. A future REM adds the
same guard to the remaining legacy actions (opening/transfer/other-income on the retired `/expenses/cash`
page) and a hard defect-log if a business flow attempts a legacy write post-cutover.
