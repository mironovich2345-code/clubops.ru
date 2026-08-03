# REM-02 — Cash Source Live Acceptance Checklist

Run on staging (disposable PostgreSQL) then production per club. Automated proof done (13/13 DB tests +
preflight + reconciliation). This covers PostgreSQL + real screens + accountant sign-off.

## PostgreSQL gates (BLOCKER)
- [ ] `DATABASE_URL=<disposable-pg> node scripts/rem-02-cash-source-integration.mjs` → 13/13 on PostgreSQL.
- [ ] Concurrent snapshot create for one (club, LE, date) → at most one active (G-CASH-8) — with the future
      active-uniqueness constraint; until then, verify the compare-and-set correction path holds.
- [ ] REM-01 payroll concurrency suite green on PostgreSQL.

## Official-figure gates
- [ ] **G-CASH-1** Dashboard, /collections and /analytics show the SAME ООО and the SAME ИП number for one club.
- [ ] **G-CASH-2** A cash payroll payment reduces the official ИП balance by exactly the amount (once).
- [ ] **G-CASH-3** Replaying the same payment (same key) changes the balance by zero more.
- [ ] **G-CASH-4** Reversing the payment restores the balance exactly.
- [ ] **G-CASH-5** The legacy wallet figure is shown ONLY in diagnostics, labelled "Legacy, не текущий баланс".
- [ ] **G-CASH-6** After setting `cashCanonicalCutoverAt`, a new cash expense/payroll creates NO CashMovement
      (`preflight:cash-cutover` CC-09 = 0) and the balance is unchanged.
- [ ] **G-CASH-7** An accountant reconciles the ООО/ИП formula on a REAL club and confirms it matches reality.
- [ ] Cancelled snapshot: cancel a control point → dashboard/collections both drop it and use the prior active.

## Carry-over
- [ ] G1 transfer-to-regional, G2 backdated snapshot, G3 correction+cancellation (from the master checklist)
      re-verified with the unified resolver.

**Sign-off:** accepted when G-CASH-1..7 pass on a real club, the PostgreSQL gates are green, and an accountant
ratifies the ООО/ИП formula.
