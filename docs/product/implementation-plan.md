# CLUB-OPS — Implementation Plan (phased rollout)

Phased introduction into a real fitness-club network, gated by the P0/P1 remediation
(`final-remediation-backlog-to-2026-08-18.md`) and the live GATEs (`live-gates.json`). **Do not run a
phase until its predecessor's acceptance passes.**

## Phase 0 — Staging & training (prereq for everything)
- **Scope:** staging environment with a **test company** (handle the demo-company trap, UX-006); seed a realistic club + roles.
- **Roles:** all 7 exercised on staging.
- **Data migration:** none (fresh test company).
- **Acceptance:** `pilot:full` + `build:prod` green; `audit:data-integrity` + `audit:financial-reconciliation` clean on staging; the P0 fixes (REM-01/02/03/04) merged; role training delivered (`docs/training/*`).
- **Rollback:** n/a (non-production).
- **Duration:** overlaps the P0/P1 work. **Owner:** dev + ops.

## Phase 1 — One club, core finance (the realistic first launch)
- **Scope:** **expenses · invoices · refunds · cash (collections)** in ONE real club. NOT payroll/budgets yet.
- **Roles:** manager + regional_director + accountant (+ owner watching the dashboard).
- **Data migration:** create the company/club/legal-entities via the UI (no SQL); optionally backfill a few historical paid invoices (with the ledger backfill).
- **Acceptance:** the first-day scenario passes live (manager creates expense → regional approves → accountant pays partial → refund → cash count → transfer to regional); **cash figures reconcile** across dashboard/collections (REM-02 done); no double-payment (REM-01 done); documents survive a redeploy (REM-04 done); backup+restore proven (REM-03/G10).
- **Rollback:** app rollback ready; restore rehearsed; a **money-incident write-freeze** available (REM-18).
- **Duration:** 1–2 weeks of real use. **Owner:** ops + the pilot club's staff.

## Phase 2 — Payroll · budgets · payment planning
- **Scope:** add payroll (schemes → calc → approve → pay → close), budgets, salary-budget proposals, obligations, the payment calendar.
- **Roles:** + chief_accountant (reversal, month-close), GD (plans/budgets).
- **Data migration:** set up pay schemes per employee; first budget month.
- **Acceptance:** the first-month scenario passes (forecast → proposal → obligations → advance/payment/reversal → close); payroll payout idempotency verified live (REM-01/G9); obligation reversal + per-occurrence settle available (UX-003 fixed); "Выплачен" reconciles to remaining (UX-004 fixed); one profit + one budget-fact number (REM-05, BD-03/04).
- **Rollback:** month-close is controlled-reopen; app rollback; restore proven.
- **Duration:** 2–3 weeks. **Owner:** ops + accounting.

## Phase 3 — Full network
- **Scope:** all clubs + all roles + OFD auto-sync + analytics/network dashboards.
- **Data migration:** onboard remaining clubs/legal-entities; connect OFD per KKT (REM-17 scheduler running).
- **Acceptance:** OFD daily sync fresh (G14); network dashboards reconcile; capacity holds (Audit-4 §23); all pilot-scope live GATEs (G1–G9) passed.
- **Rollback:** full backup/restore + write-freeze; per-tenant export/restore (REM-09) for isolation.
- **Duration:** phased club-by-club. **Owner:** ops.

## Per-phase gate (must pass before advancing)
1. The phase's live GATEs (`final-live-acceptance-checklist.md`) signed off.
2. `audit:data-integrity` + `audit:financial-reconciliation` clean on the real data.
3. No open P0 in the phase's scope; documented workarounds for any open P1.
4. Owner accepts known limits (Conditional-Go, `go-no-go-criteria.md`).

## Realistic timeline vs 18 Aug
**Phase 0 + Phase 1 (single club, core finance) is the realistic 18-Aug deliverable** (Conditional-Go).
Phases 2–3 (payroll/budgets, full network) land in the weeks after — they depend on REM-05/14/16/17
and the payroll live GATEs, which won't all close by 18 Aug with one developer.
