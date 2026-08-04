# CLUB-OPS — Roadmap to 2026-08-18

From **2026-08-03** (today) to the **2026-08-18** target = **~15 calendar days / ~10–11 working days**.
Sequenced so dependent tasks are never parallel. Assumes ~1 developer (single-dev risk, Audit 1). Ties
to `final-remediation-backlog-to-2026-08-18.md`. **Honest read: a full-network launch by 18 Aug is not
realistic; a single-club Phase-1 pilot is.**

## Sequenced groups (each starts only when its predecessor is done)
### 1 — Business decisions (Days 0–1, owner/accountant session)
Ratify **BD-03 profit · BD-04 budget-fact · BD-09 cash contour · BD-13 tax · BD-02 refund** (+ BD-06/07/11
LE attribution). These unblock REM-02/05/15/16/19. **Blocking; nothing money-definitional ships before this.**

### 2 — P0 money fixes (Days 1–5)
- **REM-01** payroll payout tx + idempotency (closes ARCH-002/003/004+DATA-003+FIN-005+SEC-001). ~M.
- **REM-02** one cash resolver + collapse to contour B (needs BD-09; data reconcile A vs B). ~L.
- **REM-08** retire ledgerless invoice `pay` + declare `partially_paid`. ~S.

### 3 — P0 recovery / storage (Days 2–5, parallel-safe with group 2 — different surface)
- **REM-03** scheduled off-site encrypted backup + **rehearsed restore** (G10) with RPO/RTO. ~M.
- **REM-04 ✅ TOOLING DONE** durable object storage: prod fail-fast on local (ARCH-017 CLOSED), S3 service + SSE + immutable tenant-scoped keys (SEC-006 CLOSED), inventory/manifest/migration/recovery. OPS-002 PARTIALLY CLOSED — the real S3 upload/download/restore rehearsal (**G-FILE-1..14**) is the gate (NOT EXECUTED: no S3 in sandbox). ~S.

### 4 — P1 security / ops (Days 5–8)
- **REM-06 ✅ CORE DONE** live/ready/dependencies split + `DATABASE_URL`/provider validation + startup fail-fast + deploy gate; 28/28 tests; ARCH-015/OPS-013 CLOSED; OPS-003 + ARCH-013/OPS-004 PARTIAL (real PostgreSQL gate G-READY-12). **REM-07 ✅ CORE DONE** SecurityEvent + requestId correlation + fail-safe denied-authz logging + CLIs; 19/19 tests; OPS-006/SEC-009 CLOSED (ARCH-005/SEC-002 unchanged); call-site adoption = G-SECLOG-1/2.
- **REM-11** rate-limit hardening (verify Caddy XFF). **REM-12** OFD SSRF allowlist.
- **REM-13** dev-client restore in CI. **REM-17** OFD scheduler + minimal alerts. **REM-18** write-freeze.

### 5 — Financial-formula unification (Days 6–9, needs group 1)
- **REM-05 ✅ CORE DONE** canonical recognized-expense + profit + budget-fact services; Plan/Fact readers migrated (v2 verified + partially_paid in FULL); 31/31 DB tests + golden scenario; FIN-002/003 + DATA-018/019 + FIN-007 CLOSED; FIN-001/UX-005 PARTIAL (dashboard profit-card adoption = G-FIN-1/7). **REM-10** obligation refresh in tx.
- **REM-16** obligation.employeeId fix + LE attribution. **REM-15** tax model per BD-13.

### 6 — True integration tests (Days 8–11, needs groups 2 & 5)
- **REM-14** DB-backed behavior tests executing the real money engines (compute / invoice-payments /
  cash-balances / obligation / budget-linkage) — replaces the false-green source-string coverage.

### 7 — Production preflight (Days 10–12)
- **G11** staging migration rehearsal; **G16** `audit:data-integrity` + `audit:financial-reconciliation`
  on a prod read replica — reconcile any anomaly. **G13/G14/G15** readiness / OFD scheduler / Caddy+OFD-URL.

### 8 — Training (Days 10–13, parallel with 7)
- Deliver `docs/training/*` (5 role guides) + a walkthrough with the pilot club's staff.

### 9 — Staging (Days 12–14)
- Full flow on staging with a test company (handle the demo-company trap); run `pilot:full` + build.

### 10 — Pilot club (Days 14–16)
- **Phase 1** in one real club: expenses / invoices / refunds / cash — 3 roles (manager + regional +
  accountant). Owner watches the dashboard. Daily reconciliation. **This is the realistic 18-Aug deliverable.**

### 11 — Final deploy (18 Aug, conditional)
- Go/No-Go review (`go-no-go-criteria.md`). If the P0 set + pilot-scope P1 are closed and cash reconciles
  → **Conditional-Go for the single-club pilot.** Full-network + payroll/budgets = **after** launch (Phase 2–3).

## Realistic outcome
- **Achievable by 18 Aug (1 dev):** business decisions → P0 money + recovery → the pilot-scope P1 →
  staging → **a single-club Phase-1 pilot**.
- **Not achievable by 18 Aug:** all 14 P1 + REM-14 full test rebuild + payroll/budgets pilot + full
  network. These land in the **weeks after** launch (Phase 2–3).
- **Risk:** ~10 working days for 4 P0 + ~8 P1 + rehearsals + training is aggressive for one developer;
  cutting REM-14 (real tests) or the restore rehearsal would be a false economy — both are the reason
  the audits exist.

> Slack: keep 1–2 buffer days before 18 Aug for the Go/No-Go and any preflight reconciliation. If the
> P0 set slips, **hold the launch** — a double-payment or an unproven restore is a NO-GO by policy.
