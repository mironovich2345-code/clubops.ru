# Risk register — 2026-08 release

Severity: **S1** critical (money/data loss/security) · **S2** high · **S3** medium.
Status: OPEN · MITIGATING · VERIFY-ON-PROD · CLOSED. Owner = Miron (product/dev) unless noted.
Deadline: before 2026-08-18 unless stated.

| # | Risk | Sev | Evidence | Mitigation | Status | Deadline |
|---|---|---|---|---|---|---|
| RK-1 | Financial formula / scope mismatch (card vs list, cash formula terms) | S1 | Card «Расходы ИП на проверке» is intentionally a narrower set than the list; earlier `submitted`-invisible gap fixed | Shared `expense-status` predicate; ИП formula single source `cash-balances.ts`; `audit:expense-summary-consistency` reconciles by ID | VERIFY-ON-PROD (R1) | 18 Aug |
| RK-2 | Cross-tenant / IDOR (documents, cash ops, transfers) | S1 | Doc routes 404 on scope mismatch; actions scope by companyId + clubId ∈ allowed | Server-side re-checks everywhere; A5 security audit; add IDOR test matrix | OPEN (A5) | audit stage |
| RK-3 | Payroll calculation error (accrual/payment/advance/debt) | S1 | Payroll pilots green; complex multi-stage engine | A4 payroll audit; recompute a real period vs manual | OPEN (A4) | audit stage |
| RK-4 | Production migration failure / drift | S1 | New additive migration (dev applied, prod `ADD COLUMN`+`CREATE TABLE`) | Backup before deploy (RK-5); `prisma migrate deploy` (never `db push`); staging dry-run (P1-2) | MITIGATING | before deploy |
| RK-5 | Backup / restore not proven | S1 | No tested restore documented yet | Document + rehearse restore of a prod snapshot before any migration | OPEN (P1-3) | before deploy |
| RK-6 | Files / PDF / storage (viewer, Cyrillic names, ranges) | S2 | Framing fixed (SAMEORIGIN for doc routes), RFC 6266 filename, range support added | G4 real-device gate; verify storage provider (local/S3) in prod | VERIFY-ON-PROD (G4) | 18 Aug |
| RK-7 | Role mismatch / privilege escalation | S1 | Transfer confirm = explicit club manager only; invite RBAC = manager-only club scope | A6/A7 role audits; regional-cannot-self-confirm + cross-club tests | OPEN (A6/A7) | audit stage |
| RK-8 | Mobile-only blockers (viewer scroll, invitation control) | S2 | Fixed structurally; not yet device-verified | G4/G5 on a real iPhone (Safari + PWA, both orientations) | VERIFY-ON-PROD | 18 Aug |
| RK-9 | Integration data gaps (OFD cash net, missing legalEntity) | S2 | Cash formula depends on OFD daily summaries + active ИП link | `preflight:balance-snapshots` (orphan LE / archived clubs); verify OFD sync coverage on prod | VERIFY-ON-PROD (R2) | 18 Aug |
| RK-10 | New-company hardcoding | S2 | Multi-company flows exist; risk of hardcoded ids/first-run assumptions | P1-1 clean-setup audit: create a fresh company end-to-end | OPEN (P1-1) | audit stage |
| RK-11 | Legacy dead code confusion (CashWallet ledger) | S3 | Old transfer ledger models remain but unused by the formula | Documented in cash audit; A1 decides keep-dormant vs remove post-release | OPEN (A1) | after audit |
| RK-12 | Deploy executed without gate sign-off | S2 | This program requires manual gates before release | No auto-deploy; gates G1–G5 + backups must be signed off first | MITIGATING | ongoing |

## Review cadence
Re-review at: end of live-gate closure, and at the start of the FULL CODE AND DATA LOGIC AUDIT stage.
Any S1 must be CLOSED or explicitly accepted (with rationale) before the 18 Aug release.
