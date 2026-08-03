# CLUB-OPS — Go / No-Go Criteria (2026-08-18 launch)

The objective gate for launching CLUB-OPS in a real fitness-club network. Ties to the consolidated
backlog (`final-remediation-backlog-to-2026-08-18.md`) and the live GATEs (`live-gates.json`).

## GO — all must be true
- **P0 closed:** REM-01 (payroll payout tx+idempotency), REM-02 (one cash contour), REM-03 (proven off-site backup+restore), REM-04 (S3 enforced + uploads backed up).
- **Required P1 closed:** REM-05 (one profit/budget-fact def), REM-06 (DB readiness + URL validation), REM-07 (failed-authz logging), REM-08 (no ledgerless paid), REM-11 (rate-limit hardening), REM-12 (SSRF allowlist), REM-13 (build client), REM-14 (real money-engine tests).
- **Backup restore PROVEN** (G10) with recorded RPO/RTO; **staging migration rehearsed** (G11).
- **S3/file durability PROVEN** across a redeploy (G12); **DB readiness** verified under DB-down (G13).
- **Production preflight clean or reconciled:** `audit:data-integrity` + `audit:financial-reconciliation` on a prod replica show no unresolved S0/S1 (G16).
- **Money integration tests green** (REM-14 executes the real engines).
- **Manual GATEs passed** for the pilot scope (G1–G9 for the flows in use).
- **Role training complete** (`docs/training/*`), **rollback ready** (`rollback-runbook.md`).
- **The 5 blocking business decisions ratified:** BD-03 (profit), BD-04 (budget fact), BD-09 (cash contour), BD-13 (tax), BD-02 (refund).

## CONDITIONAL GO — launch a limited pilot with documented limits
- All P0 closed **and** the pilot-scope P1 closed, but some non-pilot P1/P2 remain.
- Remaining items have **documented workarounds** and the owner **accepts the known limits in writing**.
- Example: launch **Phase 1 (one club: expenses/invoices/refunds/cash)** while payroll/budgets (Phase 2)
  finish — provided REM-01/02/03/04 + REM-06/07 are done and the cash figures reconcile.
- The demo-company onboarding trap is handled in the deploy runbook; OFD scheduler configured.

## NO-GO — any one blocks launch
- **Double-payment risk** open (REM-01 not done) — payroll payouts can double-charge.
- **Competing cash balance** shown to users (REM-02 not done) — dashboard vs collections disagree.
- **Unknown/unproven restore** (REM-03/G10 not done) — cannot recover from data loss.
- **Local file storage in production** (REM-04 not done) — documents lost on redeploy.
- **Unresolved cross-tenant risk** — (Audit 5 found none; re-confirm on a prod replica, G16).
- **Unexplained production anomalies** in the preflight (data-integrity/reconciliation) not reconciled.
- **A financial formula not ratified** (profit / budget-fact / cash contour / refund / tax business decisions open).

## Current status (at `9c43548`, 2026-08-03)
**NO-GO today** — REM-01/02/03/04 (all P0) are open, restore is unproven, and the 5 blocking business
decisions are unratified. **No access-control or code-quality blocker** — the gate is money-consistency
+ recovery + ratified accounting rules, not security or architecture. A **Conditional-Go for a
single-club Phase-1 pilot** becomes reachable once the P0 set + REM-06/07 land and the cash figures
reconcile (see `roadmap-to-2026-08-18-final.md`).
