# CLUB-OPS — Role / Capability Matrix (verified against server guards)

Read-only at `eb8a8f6`. Authorization = `ROLE_PAGE_ACCESS` + `ROLE_CAPABILITIES` (`src/lib/auth.ts`),
resolved from live `CompanyUserAccess`/`ClubUserAccess` per request (`access.ts`). `chief_accountant`
inherits `accountant`. Owner/GD are **strategic (read-only on operational records)** — enforced by
capability, not just page access. Marketer is view-limited. This matrix records **intended vs the
actual server guard** for the security-critical actions.

## Money / approval actions — actual server guard
| Action | Server guard (file:line) | Who can | Self-approval blocked? |
|---|---|---|---|
| Invoice record payment | `canAddPaidInvoice` accountant/chief (`invoices.ts:559`) | accountant, chief | n/a |
| Invoice **reverse** payment | `canReverseInvoicePayment` **chief only** (`invoices.ts:566`) | chief_accountant | n/a |
| Invoice approve (regional) | `applyInvoiceAction` (`invoices.ts:195`) | regional (self-approve **allowed** — documented invoice-only rule) | **NO (intentional, invoices only)** |
| Expense approve (regional/owner) | `expense-simplified.ts:200-217` | regional/owner per level | **YES** — regional can't approve own (`:203`) |
| Expense verify | accountant | accountant | n/a |
| Refund approve/pay v2 | `refund-workflow` + role | regional→accounting; pay = accountant/chief | YES |
| Cash transfer confirm | **explicit club manager only** (`collections/actions.ts:436`) | that club's manager | **YES** — regional can't self-confirm |
| Balance snapshot set/correct/cancel | `canManageControlSnapshot` | finance-write roles | n/a |
| Budget-overrun approve | `canApproveBudgetOverrunForCategory` (advertising = **GD-only**) | owner/regional; ads→GD | **YES** (`budgets/actions.ts:118`) |
| Budget-change proposal approve | owner/GD (`proposal-actions.ts:56`) | owner, GD | INFO (owner/GD is top authority) |
| Payroll record payment/advance | cash=operational, bank=accounting | manager/regional (cash), accountant (bank) | n/a |
| Payroll regional payment | `canViewRegionalPayroll`, **manager excluded** (`regional/actions.ts:101`) | regional/owner | n/a |
| Obligation settle/write-off | `canSettle`/`canWriteOff` | chief/accountant | n/a |
| Invite user | `getInvitableRoles` (`access.ts:560`) | owner→owner/chief/GD; GD→regional/…; regional→manager | inviter can't exceed own authority ✅ |
| Change role | `assertCanManageUser` | owner/GD/regional (scoped) | can't elevate above self ✅ |
| OFD sync trigger | `ofd.sync.trigger` (5 roles) — **but collections sync actions omit this check** | owner/GD/regional/accountant/chief | SEC-011 (collections surface) |

## Vertical escalation checks (all NEGATIVE unless noted)
- Manager: **cannot** approve own expense (regional gate), **cannot** reverse payment (chief-only), **cannot** confirm a cash transfer they didn't manage, **cannot** touch another club (scope), **cannot** create a control snapshot for another club (scope). Manager **can** see own-club data only (`managerOwnFilter`).
- Regional: **cannot** self-confirm a receipt (`:436`), **cannot** reverse (chief-only), **cannot** approve own expense, **cannot** cross to another company (scope). Can invite **manager only**.
- Accountant: **cannot** reverse (chief-only), **cannot** approve in place of a regional (workflow), **cannot** change payroll schemes (role gate), **cannot** reach another company (scope).
- Chief accountant: inherits accountant + reversal; **cannot** reach another company; **no** owner-level company/role management.
- Owner/GD: **cannot** bypass «reversal = chief-only» (the reverse action gate is chief, independent of owner), **cannot** reach another company (scope), **cannot** use a global id to cross tenants (scoped queries). Advertising overrun is **GD-only** even for the owner.

## Intended-vs-actual mismatches found
| Rule | Intended | Actual | Finding |
|---|---|---|---|
| OFD sync gated by `ofd.sync.trigger` | capability-gated | **collections** `syncIpCashAction`/`syncOooCashAction` check only company, not the capability | **SEC-011 (P3)** |
| Club-assignment removal scoped to accessible clubs | clubId ∈ allowedClubIds | `removeClubAssignment` checks company+employee, not clubId∈allowed | **SEC-012 (P3)** |
| Manager invite for an **active** club | active-club only | `createInvite` club lookup lacks `isActive` | **SEC-014 (P3)** |
| Confidence gates the review nudge | server-derived | client-supplied `confidence` trusted | **SEC-007 (P2)** — defeats a nudge, not the pay chain |

**No mismatch grants a lower role a higher-privilege money operation.** UI gating and server guards
agree on the money path (verified against the actual guards, not just the UI).
