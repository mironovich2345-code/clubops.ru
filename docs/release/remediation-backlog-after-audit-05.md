# Remediation Backlog — after FULL AUDIT 5/6 (Security)

From `docs/audits/full-audit-05-security.md` (SEC-###), linked to ARCH-/DATA-/FIN-/OPS-. Target: before
**2026-08-18** for P1. Nothing fixed during the audit. Effort XS/S/M/L. **No P0 — no cross-tenant breach
or privilege escalation into money was found;** the P1 set is replay-idempotency + detection + hardening.

## P1 — before 18 Aug
| ID | Task | Ties | Route/module | Test | Live gate | Effort |
|---|---|---|---|---|---|---|
| SEC-001 | Add idempotency key + `$transaction` to `recordPayment`/`recordAdvance`/`recordRegionalCityPayment` (mirror the invoice-payment ledger) | ARCH-002/003/004, FIN-005 | payroll payouts | DB-backed double-submit test | **yes** (staging double-click) | M |
| SEC-009 | Log denied authorization (page-access, company/club access, capability) with actor+target+object; add request id | OPS-006 | access.ts + recordAudit | assert a denied attempt writes an AuditLog row | no | M |
| SEC-002 | Derive client IP from a trusted proxy hop; **verify Caddy replaces inbound X-Forwarded-For** | — | request-ip.ts + Caddyfile | XFF-spoof test | yes (staging) | S |
| SEC-003 | Add the `ai_analyze` rate limiter to `uploadAndAnalyzeRefund` (and payroll AI upload) | — | refunds/actions.ts, payroll-actions.ts | limiter test | no | XS |
| SEC-004 | Host allowlist (`*.taxcom.ru`) for OFD `serverBaseUrl` at save + before fetch (mirror `assertSabyHost`); same for Astral override | — | ofd/taxcom/client.ts, settings ofd actions | SSRF-attempt test | yes (prod value review) | S |

## P2 — after launch (or before if time permits)
| ID | Task | Effort |
|---|---|---|
| SEC-005 | Idempotency key + CAS on obligation settle/write-off | S |
| SEC-006 | Server-issued, company-scoped upload token binding `storageKey` (extend the invoice `PendingInvoiceUpload` pattern to expense v1 + payroll) | S |
| SEC-007 | Derive/clamp `confidence` from the stored extraction (not client) | S |
| SEC-008 | Bounded local fallback / fail-closed rate limiting on the auth endpoints | S |
| SEC-010 | Neutralize CSV formula prefixes (`= + - @`) in `csv.ts:escapeCell` **before** re-enabling any export | XS |
| SEC-011 | Add `can(roles,"ofd.sync.trigger")` to collections sync actions | XS |
| SEC-013 | Generic registration message; dummy bcrypt on the login user-miss path | S |

## P3 — hardening
| ID | Task | Effort |
|---|---|---|
| SEC-012 | Add `clubId ∈ allowedClubIds` to `removeClubAssignment` | XS |
| SEC-014 | Add `isActive:true` to the manager-invite club lookup | XS |
| SEC-015 | Server-derive `idempotencyKey` on regional transfer | XS |
| SEC-016 | Batch: bcrypt cost→12, HSTS `preload`, Telegram `update_id` dedupe, OFD amount sanity cap, defensive self-scope assertions in `cancelSalaryExpense`/`confirm*` helpers, plus a **standing lint/test invariant** that every `*ForContext` loader keeps its `companyId`+`allowedClubIds` guard (the single-point-of-failure guard for the manual-isolation scheme) | M |

## Defense-in-depth (recommended, not a specific finding)
A **Prisma tenant-scope extension** (auto-inject companyId / assert scope on by-id reads+writes) would
turn the manual isolation (ARCH-005) into a DB-layer backstop, so a single future omission cannot become
an IDOR. Large but high-value; sequence after the P1 set.

## Production verification (before sign-off)
- Confirm **Caddy strips inbound `X-Forwarded-For`** (SEC-002).
- Review production OFD `serverBaseUrl` values (SEC-004).
- Re-run `audit:idor-matrix` / scoped loaders against a production read replica with two real tenants (SEC verdict at scale).

## Coupling to prior audits
SEC-001→ARCH-002/003/004+FIN-005+DATA-003 (same payroll payout fix); SEC-009→OPS-006 (security-event
logging); the tenant-scope extension complements ARCH-005/DATA-007/025. Fix the payroll payout write-path
**once** (idempotency + transaction) to close SEC-001, FIN-005, ARCH-002/003/004, and DATA-003 together.
