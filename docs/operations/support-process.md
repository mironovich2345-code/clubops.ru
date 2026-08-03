# CLUB-OPS — Support Process (beta)

How a user reports a problem and how support diagnoses it, read-only. Pairs with the incident runbooks
(`incident-runbooks.md`) and the diagnostic scripts.

## How a user reports a problem
1. **What to send:** what they were doing (role + page/route), the exact on-screen message, the time, and the **entity** involved.
2. **Find the entity ID:** it is in the URL of the detail page (`/invoices/<id>`, `/refunds/<id>`, `/payroll/periods/<id>`). Ask the user to copy the URL.
3. **Find the company/club:** the active scope is shown in the header scope switcher; ask which company/club.
4. **Screenshot** the error and the record.

## How support diagnoses (read-only, never mutate)
- **Deployment version:** `GET https://<domain>/api/health` → `commit` / `deploymentId` / `environment` — confirm which build the user is on.
- **Health/readiness:** `/api/health` (liveness) + (once added) `/api/health/ready` (DB).
- **Data integrity (prod read replica):** `npm run audit:data-integrity -- --company=<id>` → tenant mismatches, orphans, duplicate snapshots, ledgerless paid, overpayment.
- **Financial reconciliation:** `npm run audit:financial-reconciliation -- --company=<id> --club=<id> --month=YYYY-MM` → invoice/payroll equation violations, phantom/orphan payments, dual-contour presence.
- **Audit trail:** the `/activity` log (owner/GD/regional/accountant/chief) shows who/when for actions. **Note:** authorization **denials are not logged yet** (SEC-009/REM-07) — a "why can't I access this" report can't be traced from the log until that lands.
- **Never** run a write, a migration, or a deploy to diagnose. Use the incident runbooks for containment.

## Escalation & who decides
| Issue type | First responder | Decides recovery |
|---|---|---|
| App down / DB down / migration hung | ops | ops |
| **Double payment / cash divergence** | ops + finance | chief accountant (reversal is chief-only) |
| Cross-tenant suspicion | security + ops | owner |
| Backup/restore | ops | owner |
| Product/workflow confusion | support | product owner |

## SLA (beta — set with the owner)
- **P0 (money distortion, data loss, access breach):** immediate; contain first (write-freeze / stop the container), then diagnose read-only.
- **P1 (blocked daily work):** same business day.
- **P2 (usability / confusion):** next release.
- Beta expectation: a single-developer team (Audit-1 single-dev risk) — set realistic response windows and a backup contact.

## What support must NOT do
Edit the DB directly to "fix" a record; run a migration to patch data; deploy an untested build; delete
an audit row; share a secret value. All corrections go through the **append-only** in-app flows (reverse,
not delete) so the audit trail stays intact.

## Known limitations to tell users (beta)
- Cash figures may show competing numbers until REM-02 lands (UX-005) — trust the collections page fact balance.
- Payroll "Выплачен" may not reconcile to remaining until UX-004 — verify per-employee remaining.
- Refund correction and payroll obligation reversal may need support to complete until UX-001/003 land.
- Documents are lost on redeploy if storage is `local` — production must be S3 (REM-04).
