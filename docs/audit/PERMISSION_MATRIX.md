# CLUB-OPS — Permission Matrix

Roles are derived from `src/lib/auth.ts` (`ROLE_PAGE_ACCESS`, capabilities) and `src/lib/access.ts` (`ROLE_IMPLICATIONS`, `assertCanManageUser`, `getInvitableRoles`). Effective roles come ONLY from `CompanyUserAccess`/`ClubUserAccess` for the selected scope — the global `User.role` never grants in-app permission. Unknown roles fail closed.

Actual roles in code: `owner`, `general_director`, `regional_director`, `manager`, `chief_accountant`, `accountant`, `marketer`. Plus a code-only platform `superadmin` (no UI; bypasses Company isolation — must only be set during bootstrap, never via user-facing flows).

## Page access (`ROLE_PAGE_ACCESS`)

| Page | owner | gen.dir | regional | manager | chief acct | accountant | marketer |
|---|---|---|---|---|---|---|---|
| dashboard | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| analytics | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓(scoped) |
| expenses | ✓(RO) | ✓(RO) | ✓ | ✓ | ✓ | ✓ | – |
| invoices | ✓(RO) | ✓(RO) | ✓ | ✓ | ✓ | ✓ | – |
| refunds | ✓(RO) | – | ✓ | ✓ | ✓ | ✓ | – |
| payments / calendar | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| budgets | ✓ | ✓ | ✓ | – | ✓ | ✓ | – |
| sales | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| employees | ✓ | ✓ | ✓ | ✓ | – | – | – |
| users | ✓ | ✓ | ✓(own clubs) | – | – | – | – |
| settings (Company/Club/LegalEntity) | ✓ | ✓(profiles RO on assignment) | – | – | – | – | – |
| activity (audit) | ✓ | ✓ | ✓ | – | ✓ | – | – |
| security (own sessions) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

"RO" = page visible but mutations blocked server-side (strategic read-only). The matrix is enforced by `requirePageAccess`/`canAnyRoleAccessPage` on pages AND by capability checks in every server action — UI visibility is never the authorization.

## Capability / action authority

| Capability | Who | Enforcement |
|---|---|---|
| Create/edit operational records (expense/invoice/refund/sale) | regional, manager, accountant, chief_accountant | `canCreateOperational` / `canMutateOperationalRecords` (excludes owner/GD/marketer) |
| Invoice/refund approve | regional (if active) else chief_accountant fallback | `applyInvoiceAction` / `applyApprovalAction` |
| Mark paid | accountant / chief_accountant | `applyInvoiceAction` `pay` (owner explicitly excluded) |
| Sales plans | general_director | capability `sales_plan.manage` |
| Budget limits / overrun approval | owner, general_director (advertising/salary overrun) | capability `budget.manage` |
| Month close | chief_accountant | month-close service |
| Month reopen request / approve | requester chain → owner approve | month-reopen workflow |
| Manage users (revoke access / deactivate / revoke sessions) | owner→any; GD→non-owner/GD; regional→managers in own clubs | `assertCanManageUser` + `isLastActiveOwner` |
| Invite roles | owner→owner/chief/(GD if none); GD→regional/chief/accountant/manager/marketer; regional→manager | `getInvitableRoles` (cannot grant above own authority or outside scope) |
| Club create/archive/restore; LegalEntity ASSIGN to club | owner only | `requireOwnerOf` / owner-only assignment actions |
| LegalEntity profile create/edit | owner, general_director | `requireManager` |
| Download documents (attachment) | accounting contour (`canDownloadDocuments`) | file route; others view inline only |
| Strategic multi-Company analytics | owner, general_director | `isStrategicRole` |

## Verified intended behaviors (Phase 5)

1. Owner & GD are strategic **read-only** for operational records — every operational mutation excludes them. ✓ (pilot:sessions/club + code review)
2. GD performs only planning/budget actions explicitly granted (sales plans, budget limits, advertising/salary overrun approval). ✓
3. Manager cannot reach network analytics/strategic records (no `analytics` strategic, no settings/users). ✓
4. Accountant/Chief see only assigned Companies/Clubs (scope-filtered). ✓
5. Chief accountant owns month-close; reopen requires the request/approval chain. ✓
6. Regional approval with chief-accountant **fallback** when no active regional approver. ✓ (and the fallback status is now counted in budgets/debt — F-001)
7. Owner is NOT returned to operational approval (`pay`/approve exclude owner). ✓
8. UI restriction == server restriction (capabilities checked in actions). ✓
9–10. Direct server-action / route-handler calls re-check access (no UI-only gating). ✓
11. Unknown roles fail closed (`isKnownRole`, default-deny in `assertCanManageUser`). ✓
12. Removed/inactive users lose access immediately (access change & deactivation revoke all sessions; `getValidSession` re-checks every request). ✓

## Regression coverage

Authorization boundaries are exercised by `pilot:sessions` (revocation, deactivation, manage-authority), `pilot:club` (owner-only assignment, GD denial via view gate), and the financial fallback by `pilot:financial`. A dedicated allow/deny matrix harness for every (role × action) pair is recommended as a follow-up (P3) — current coverage proves the high-risk boundaries.
