# CLUB-OPS — Final Live Acceptance Checklist (master)

Every manual GATE from Audits 1–6 in one place. **All are OPEN at `9c43548`.** Machine list:
`docs/audits/data/live-gates.json`. Each GATE must be executed on a real instance/device/replica (not
in this sandbox) with evidence recorded before launch. Format: environment · role · setup · steps ·
expected · evidence · status · blocker · owner.

## Money / finance flows (from Audits 1–3, prior epics)
- [ ] **G1 — Regional cash transfer.** Real instance · manager/regional · a club with an active ИП. Create transfer → confirm as the club manager → **ИП reduces only on confirmed**; a pending transfer does not move money. Evidence: cash figures before/after. **Blocker if:** pending reduces ИП, or regional can self-confirm.
- [ ] **G2 — Backdated control snapshot.** Real instance · finance-write role. Set a snapshot dated earlier than an existing one → the later checkpoint still governs; balances recompute correctly. **Blocker if:** a backdated point silently overrides the latest.
- [ ] **G3 — Snapshot correction / cancellation.** Real instance. Correct then cancel a snapshot → append-only history; **dashboard, analytics, collections all agree** after a cancel (REM-02). **Blocker if:** dashboard shows a cancelled snapshot's balance.
- [ ] **G6 — Invoice partial payment + reversal + already-paid.** Real instance · accountant + chief. Record a partial payment → `partially_paid`; reverse (chief-only) → prior status restored; add an already-paid historical invoice. **Blocker if:** a non-chief can reverse, or a `paid` invoice has `paidTotal=0`.
- [ ] **G7 — Invoice AI review + payment guard.** Real instance · accountant. Upload → AI extracts → the payment-block reason shows until reviewed; editing a financial field voids approval. **Blocker if:** pay proceeds on unreviewed/low-confidence data.
- [ ] **G8 — Regional dashboard review tasks.** Real instance · regional. The 3 cards count only the right statuses, own clubs only, correct sums/nearest-due. **Blocker if:** cross-club leakage or wrong counts.
- [ ] **G9 — Payroll forecast → proposal → obligation → advance/payment/reversal.** Real instance · manager/regional/accountant/chief. Run a full period; **double-submit a payment → exactly one effect** (REM-01); reverse an obligation (UX-003); "Выплачен" reconciles to remaining (UX-004). **Blocker if:** double-charge, or no reversal path.

## Profit / budget fact (REM-05, BD-03/04)
- [ ] **G-FIN-1/7 — Canonical profit adopted (REM-05 + REM-05A).** Real month. Accountant ratifies `calculateProfit` (OFD net − recognized breakdown); dashboard club-card "Результат" = analytics "Прибыль" = export. **Status: services + ALL live readers migrated (analytics card/KPI + dashboard club-card); reader-equivalence proven 12/12 + 31/31 + golden 330,000 ₽; on-instance ratification (real data) PENDING.** **Blocker if:** two profit numbers shown as equal, or a card diverges from `calculateProfit`.
- [ ] **G-FIN-8/9 — Budget fact = Plan/Fact = "Использовано"** incl. v2 verified + partially_paid (in FULL) + payroll accrual. **Plan/Fact + overruns + used migrated ✅; budgets-page payroll row PENDING.**
- [ ] **G-FIN-11/12 — Production reconciliation + golden on PostgreSQL.** `reconcile:profit-budget-fact` on a replica (0 unexplained diffs); reproduce the golden scenario exactly. **Status: NOT EXECUTED (dev sqlite only).**

## Product / UX (Audit 6)
- [ ] **G4 — PDF viewer on a real iPhone.** iPhone Safari + PWA standalone. Open an invoice/refund PDF; scroll/pinch; same-origin framing works, cross-origin blocked. **Blocker if:** the document can't be opened.
- [ ] **G5 — Invitation flow.** Real instance + SMTP. Invite each role; accept via the email link; email-bound, single-use, correct scope. **Blocker if:** invite un-mintable (no APP_URL) or accepted by the wrong email.
- [ ] **UX-001 — Refund correction loop.** Real instance · manager. Return a refund → re-upload a corrected document → resubmit. **Blocker if:** the document step is unreachable.

## Recovery / storage / ops (Audit 4)
- [ ] **G10 — Backup + restore rehearsal (Postgres).** Disposable Postgres. Restore a `pg_dump`; verify counts + reconciliation; record RPO/RTO. **Status: NOT EXECUTED. Blocker if:** restore fails or RPO/RTO unknown.
- [ ] **G11 — Staging migration rehearsal.** Disposable Postgres. Apply pending migrations; row counts + money checksums unchanged; no long write-lock. **Status: NOT EXECUTED.**
- [ ] **G12 — File durability under redeploy (REM-04).** Staging with S3. Upload a document; redeploy; the document survives; a SECOND instance downloads it; downloaded bytes hash == metadata sha256. Production **fails fast** on `local` storage. **Status: NOT EXECUTED (no S3 in sandbox).** Full gate set **G-FILE-1..14** (`docs/testing/rem-04-file-storage-checklist.md`) + the DB+blobs full-system rehearsal (`rem-04-file-restore-rehearsal.md`). **Blocker if:** files lost, cross-instance download fails, or hash mismatch.
- [ ] **G13 — DB readiness under DB-down (REM-06).** Staging PostgreSQL. `/api/health/live`=200 while `/api/health/ready`=503 with the DB down; recover → ready=200 (no restart); pending migration → ready=503; provider mismatch → ready=503. Deploy waits for `/ready`. **Status: endpoints + startup fail-fast + deploy gate shipped; 28/28 mock-client tests; real PostgreSQL rehearsal (`rem-06-postgres-readiness-rehearsal.md`) NOT EXECUTED.** **Blocker if:** the app serves 200/accepts traffic with no DB, or a pending migration is served.
- [ ] **G14 — OFD scheduler + fresh sync.** Staging with `CRON_SECRET`. The daily import runs on schedule; revenue is fresh; double-run is idempotent. **Blocker if:** the job never runs.

## Security (Audit 5)
- [ ] **G15 — Proxy & header checks.** Staging/prod. Confirm **Caddy strips inbound `X-Forwarded-For`** (SEC-002); review production OFD `serverBaseUrl` values (SEC-004, no internal/metadata host). **Blocker if:** XFF spoofable or an internal OFD base URL.
- [ ] **G16 — Preflight on a production read replica.** Prod replica. `audit:data-integrity` + `audit:financial-reconciliation` → reconcile any S0/S1 anomaly. **Blocker if:** unresolved anomalies.
- [ ] **G17 — Denied-authz logging (REM-07).** Real instance/two tenants (G-SECLOG-1..10). A wrong-role + a synthetic cross-company access each create ONE `SecurityEvent` (no mutation); the `requestId` in the user's «Код обращения» resolves via `trace:request`; events carry no secrets/PII; with the SecurityEvent write forced to fail the action is STILL denied; owner A cannot read company B's events. **Status: infrastructure + central page/cron integration + 19/19 tests shipped; per-branch adoption + live 2-tenant proof PENDING.** **Blocker if:** a denial leaks a foreign object, a secret is logged, or a logger outage allows the action.

## Sign-off
Launch (Conditional-Go) requires the **pilot-scope GATEs passed with recorded evidence**: for a Phase-1
single-club core-finance pilot that is **G1–G8, G4, G5, UX-001, G10–G13, G15–G16**. Payroll/budget GATEs
(G9, G14) gate **Phase 2**. A GATE marked **NOT EXECUTED** is never counted as passed.
