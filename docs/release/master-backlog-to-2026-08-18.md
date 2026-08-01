# Master backlog → 2026-08-18

Baseline: `b755603` (see `release-baseline-2026-08-01.md`). Statuses: **DONE** ·
**LIVE GATE** (needs production/device verification) · **AUDIT REQUIRED** · **FIX REQUIRED** ·
**BLOCKED** · **DEFERRED AFTER 18 AUG**. Closed mobile-visual passes and finished technical
stages are not re-listed.

## P0 — LIVE GATE (feature complete in code; needs prod/device sign-off)
| ID | Item | Status | Verify with |
|---|---|---|---|
| G1 | Transfer to regional (balance −exactly, RBAC, idempotent, cancel) | LIVE GATE | `diag:regional-transfer`, checklist §G1 |
| G2 | Backdated control snapshot (later fact preserved, interval correct) | LIVE GATE | `diag:snapshot-chain`, checklist §G2 |
| G3 | Correction chain (append-only, one active per date, balance unchanged) | LIVE GATE | `diag:snapshot-chain`, checklist §G3 |
| G4 | Owner document viewer (multipage PDF scroll; Safari/PWA; restore; download; Cyrillic) | LIVE GATE | real iPhone, owner checklist |
| G5 | Owner invitation flow per role (manager active-club; company-scope roles; dark theme) | LIVE GATE | real device, owner checklist |

## P0 — AUDIT REQUIRED (next stage: FULL CODE AND DATA LOGIC AUDIT)
| ID | Area | Status | Notes |
|---|---|---|---|
| A1 | Code / architecture audit | AUDIT REQUIRED | module boundaries, server/client split, dead legacy (CashWallet ledger) |
| A2 | Data relationships / referential integrity | AUDIT REQUIRED | FKs, cascade/restrict, orphan rows, tenant scoping on every query |
| A3 | Accounting / math correctness | AUDIT REQUIRED | cash formula, ИП/ООО, budgets, kopeks exactness, no float money |
| A4 | Payroll calculation | AUDIT REQUIRED | ФОТ engine, accrual/payment/advance/debt invariants, cash-once |
| A5 | Security review | AUDIT REQUIRED | IDOR/cross-tenant, RBAC gaps, document access, CSP/headers, rate limits |
| A6 | Manager role end-to-end | AUDIT REQUIRED | own-only visibility, club scope, confirm rights (incl. transfer confirm) |
| A7 | Accountant role end-to-end | AUDIT REQUIRED | review/verify scope, download rights, no auto-elevation |

## P1 — release readiness
| ID | Item | Status | Notes |
|---|---|---|---|
| P1-1 | New-company clean setup | AUDIT REQUIRED | no hardcoded company/club/legal-entity ids; first-run flow |
| P1-2 | Deployment rehearsal | FIX REQUIRED | dry-run `prisma migrate deploy` (prod) + `build:prod` on a staging DB copy |
| P1-3 | Backup / restore | FIX REQUIRED | documented, tested restore of a prod snapshot before migration |
| P1-4 | Runbooks | FIX REQUIRED | deploy, rollback, incident, data-fix runbooks |

## DEFERRED AFTER 18 AUG
| ID | Item | Status |
|---|---|---|
| D1 | Telegram relay/notifications hardening | DEFERRED AFTER 18 AUG |
| D2 | Saby (СБИС) OFD provider (behind `OFD_SABY_ENABLED`) | DEFERRED AFTER 18 AUG |
| D3 | Bank / acquiring automation | DEFERRED AFTER 18 AUG |
| D4 | New large modules | DEFERRED AFTER 18 AUG |

## Recently DONE (context, not to re-open)
- Cash regional transfer + backdated/versioned snapshots (this baseline).
- Expense/document/total consistency (Other-Income docs removed; PDF viewer framing/filename/range;
  shared expense-status predicate).
- Owner cabinet acceptance structural fixes (scope filter, analytics cards, users cards, invitation
  RBAC control, inactive-entity contrast, OFD date stacking) — G4/G5 remain the live gates.
- Mobile/PWA waves, navigation + multi-account, finance/OFD finalization, payroll stages.
