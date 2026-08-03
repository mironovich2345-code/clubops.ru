# CLUB-OPS — Product Readiness Map

Code-based readiness at `9c43548` (no live browser; live-only items marked UNVERIFIED). Statuses:
**READY · READY-WITH-LIVE-GATE · PARTIALLY-READY · BLOCKED · DEFERRED.** Machine data:
`docs/audits/data/product-readiness.json`. Money = integer kopeks; every server action re-checks role
+ company/club scope (UI hiding is never the only gate).

| Module | Entry / primary role | Readiness | Justification |
|---|---|---|---|
| **Dashboard** | `/dashboard` owner/GD/regional/manager/marketer | READY-WITH-LIVE-GATE | complete; cash cards need OFD import + control checkpoints (else "от 0 ₽") |
| **Workspace (рабочий стол)** | `/workspace` accountant/chief | READY | task queues; accountant/chief land here (not the strategic dashboard); chief month-close |
| **Analytics** | `/analytics` owner/GD/regional/marketer(sales-only) | READY | financial blocks gated; but competing profit/budget-fact definitions (FIN — REM-05) |
| **OFD sales** | `/analytics/ofd-sales` owner/GD/regional | READY-WITH-LIVE-GATE | needs `OFD_INTEGRATIONS_ENABLED`; Taxcom-only view |
| **Expenses (cash)** | `/expenses/simple` manager/regional | PARTIALLY-READY | v2 flow works; **dead owner-budget branch (UX-002/E2)**, stuck-draft if no regional (E3), orphan `submitted` (E1) |
| **Invoices** | `/invoices` manager/regional create; accountant/chief pay | READY-WITH-LIVE-GATE | full lifecycle + partial-payment ledger + chief reversal; `partially_paid` unlabeled in list (UX-007); AI UNVERIFIED; legacy ledgerless pay (REM-08) |
| **Refunds** | `/refunds/new` manager | PARTIALLY-READY | v2 wizard works; **returned-refund correction loop UI-unreachable (UX-001/R3)**, regional direct-URL dead-end (R2) |
| **Collections / cash** | `/collections` manager/regional | PARTIALLY-READY | complete, but on the unresolved **cash dual-contour (REM-02/P0)**; confirmed transfer can't be undone in UI (UX-009) |
| **Payments (calendar)** | `/payments` (read-only) | READY | display-only aggregator (invoice+mandatory+payroll); no mutation |
| **Mandatory payments** | `/mandatory-payments` owner/GD | PARTIALLY-READY | CRUD + pause/cancel; **no per-occurrence "paid" → perpetual "overdue" dead-end (UX-003)** |
| **Balances (Остатки)** | `/balances` | DEFERRED | redirects to `/collections`; legacy snapshot create disabled |
| **Budgets** | `/budgets` owner/GD set; regional view | READY | plan/fact/forecast/accrual/payment kept separate; append-only proposals |
| **Payroll (ФОТ)** | `/payroll` role-adaptive | PARTIALLY-READY | deep, working end-to-end; but **payout idempotency gap (REM-01/P0)**, obligation reversal has no UI (UX-003), "Выплачен" is an unreconciled attestation (UX-004) |
| **Employees** | `/employees` owner/GD/regional/manager | READY | 2-state lifecycle, soft-delete |
| **Users** | `/users` owner/GD/regional | READY-WITH-LIVE-GATE | invite-only; needs SMTP; role/club mgmt + owner hard-delete |
| **Companies** | admin/seed only | admin/seed-only (by design) | no tenant-create UI; owners rename only; **demo-company onboarding trap (UX-008)** |
| **Clubs** | `/settings` owner | READY | full CRUD + invariants + audit |
| **Legal entities ООО/ИП** | `/settings` owner/GD | READY | full CRUD; attach/detach owner-only |
| **OFD integration** | `/settings/ofd/*` owner/GD | READY-WITH-LIVE-GATE / DEFERRED | Taxcom live-gated; Astral ready-for-creds; Saby flagged; scheduler = external cron (REM-17) |
| **Activity / Audit** | `/activity` owner/GD/regional/accountant/chief | READY | rich journal; but auth **denials** not logged (REM-07/SEC-009) |
| **Documents / Files** | `/documents` | DEFERRED (stub) | placeholder; real storage used inline in finance modules; local files lost on redeploy (REM-04/P0) |
| **Sales** | `/sales` | READY (read-only/deprecated) | manual entry retired (OFD-sourced); historical detail actionable |
| **Backup / Restore** | — | DEFERRED / not in-product | only account/club archive-restore; DB restore never proven (REM-03/P0) |

## Readiness summary
- **READY (11):** Workspace, Analytics, Payments, Budgets, Employees, Clubs, Legal entities, Activity, Sales, + Dashboard/OFD/Users/Invoices as READY-WITH-LIVE-GATE.
- **PARTIALLY-READY (5):** Expenses, Refunds, Collections, Mandatory payments, Payroll — each has a **concrete workflow dead-end or a P0 money-integrity dependency**, not day-to-day UX breakage.
- **DEFERRED (4):** Balances (redirect), Documents (stub), Backup/Restore (not in-product), Saby/white-label.

## Bottom line
**The product is genuinely built, not scaffolded** — every role can do its essential daily work
in-product. The gating issues for a "working product" verdict are: (1) the **P0 money-integrity** items
(payroll payout idempotency REM-01, cash dual-contour REM-02); (2) three **workflow dead-ends**
(refund correction R3/UX-001, expense owner-budget E2/UX-002, payroll & mandatory obligation
reversal/settlement UX-003); (3) the **payroll "paid" attestation** that can misstate financial state
(UX-004); and (4) **operational gaps** (backup/restore, file durability, Documents stub) — not UX
blockers. See `role-journeys.md` and `full-audit-06-product-ux.md`.
