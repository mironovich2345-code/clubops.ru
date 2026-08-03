# CLUB-OPS — New-Company Onboarding

Read-only trace at `9c43548` of standing up a brand-new company. **Verdict: mostly self-serve in-app**
for the owner; platform secrets are operator/env; a few company-specific hardcodes matter for a
non-fitness tenant. One real **operator trap** (the demo-company bootstrap).

## Self-serve vs operator (per step)
| Step | Self-serve UI? | Role | Route / evidence | Operator dependency |
|---|---|---|---|---|
| Register account | ✅ `/register` | anyone | `auth-actions.ts:65` | SMTP (OTP delivery) |
| Create company + 1st club | ✅ `/onboarding` | new owner | `onboarding/actions.ts:11` (tx: company→club→owner grants) | — |
| More clubs | ✅ Settings | owner | `settings/actions.ts:121` | — |
| Legal entities ООО/ИП | ✅ Settings | owner/GD | `legal-entity-actions.ts:58` (INN user-entered, ≤1 active ООО+ИП/club) | — |
| Invite users/roles | ✅ `/users` | owner/GD/regional | `users/actions.ts:61` (`getInvitableRoles`) | **`APP_URL`** (invites un-mintable without it) + SMTP |
| Expense categories | system auto-seeded + custom | chief_accountant | `expense-categories.ts:38` (lazy-seeded on first expense page) | — |
| Budgets | ✅ `/budgets` | owner/GD/regional | `budgets/page.tsx` | categories fixed to the taxonomy |
| Payroll schemes | via employee card / change-request (no standalone "new scheme" page) | regional/GD/owner/chief | `payroll/schemes/page.tsx:90` | — |
| OFD (Такском/Astral) | ✅ Settings | owner/GD | `settings/integrations/ofd/page.tsx` | **`OFD_INTEGRATIONS_ENABLED` + `OFD_SECRET` + `CRON_SECRET`** |
| Storage / email / AI / secrets | ❌ env only | operator | `.env.example` | global platform config |

## The operator trap (P1 onboarding finding — UX-ONBOARD)
**The first-ever registrant is auto-attached to a hardcoded "Демо компания"** (`seed.ts` +
`auth-actions.ts:107-109`, `setupDemoCompanyForOwner`) with fixed IDs (`demo-company`/`demo-club`/
`demo-legal-entity`) and never sees onboarding. On a real production deploy, **company #1 becomes the
demo tenant** unless the operator first registers a throwaway user. **This must be handled in the
production runbook** (register + discard a first user, or disable the demo bootstrap for prod).

## Company-specific hardcodes (multi-company / non-fitness risk)
1. **Demo seed constants** (`seed.ts`) — the trap above; dev bootstrap is `NODE_ENV`-guarded but the first-registrant path is not.
2. **OFD sales classification = fitness vocabulary** (`ofd/revenue.ts:7-90`): membership/personal_training/group_training/extra_services/other + Russian keyword matchers ("абонемент/тренер/групповая…"). A **non-fitness** tenant's sales fall almost entirely to "Иное/other". (DEFERRED white-label item, not a launch blocker for a fitness network.)
3. **Fixed expense/budget taxonomy** (`expenses.ts:46-62`, `budgets.ts:9`) — companies **may add custom expense categories** (chief-accountant), but **budget lines are limited to the taxonomy**.
4. **Brand "CLUB-OPS" + Russian copy** — product branding, not a per-tenant hardcode (white-label = DEFERRED).
No customer INN / real legal-entity names / production company IDs are hardcoded in business logic —
only the `demo-*` seed constants.

## Operator mistake vectors (for the runbook)
1. Not discarding a throwaway first user → real customer gets the demo company.
2. Deploy without `APP_URL` → invitations silently un-mintable (`users/actions.ts:173`).
3. Deploy without SMTP → login OTP dead-ends at `/login/verify`; invites undelivered.
4. Enable OFD without `OFD_SECRET`/`CRON_SECRET` → secrets won't save, auto-import 503s.
5. Expect OFD auto-categorization for a non-fitness business → everything lands in "other".
6. `system-admin` is account-restore only — **not** a "create company" console.

## Estimated onboarding time
For a fitness network with the platform env already configured: **owner self-serve ~30–60 min** to
create company + clubs + legal entities + invite the core roles + set categories/budgets; **+ operator
time** for SMTP/APP_URL/S3/AI/OFD secrets (one-time platform setup). Payroll scheme setup per employee
adds time. **No SQL is required for tenant data** — all through the UI — but the **demo-company trap and
the env prerequisites must be in the deploy runbook** (see `support-process.md` / `implementation-plan.md`).

## Readiness
**PARTIALLY READY** — the in-app onboarding is solid and SQL-free, but production onboarding is not safe
without (a) handling the demo-company bootstrap and (b) the env prerequisites checklist. Both are
documentation/runbook items, not code blockers.
