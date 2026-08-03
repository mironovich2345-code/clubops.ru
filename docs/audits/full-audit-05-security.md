# FULL AUDIT 5/6 — Security, Tenant Isolation, IDOR, Auth, File Access (Findings)

Commit `eb8a8f6`. Read-only; **no production targeted, no data mutated, no RBAC/schema changed, no
destructive testing, no real email/money op.** Evidence is file:line. Severity S0→S3; confidence
proven / likely / needs-live-verification; CWE noted; release blocker yes/no/conditional. Priorities in
`docs/release/remediation-backlog-after-audit-05.md`. Supporting docs: `docs/security/*`,
`docs/audits/data/{security-read-scope,security-write-scope,file-access-results,idor-results,security-findings}.json`.

## Headline verdicts (corroborated across 4 independent streams + an executed IDOR test)
- **Cross-company READ: NOT FOUND.** **Cross-company WRITE: NOT FOUND.** **Vertical escalation into pay/reverse: NOT FOUND.** **Unauthenticated sensitive route: NONE** (only `/api/health`, names-only, by design).
- Tenant isolation is **manual but consistently enforced** (ARCH-005) across ~192 reads / ~112 writes; privileged columns are server-controlled (no exploitable mass-assignment).
- The real exposure is **replay/idempotency on the payroll payout family** (confirms ARCH-002/003/004/FIN-005) plus **hardening + detection** gaps.

## Severity roll-up
| Severity | Count | IDs |
|---|---|---|
| **S1 high** | 2 | SEC-001, SEC-009 |
| **S2 medium** | 7 | SEC-002, 003, 004, 005, 006, 007, 008 |
| **S3 low** | 7 | SEC-010, 011, 012, 013, 014, 015, 016 |
| **S0 critical** | 0 | — |
**Priority:** P0:0 · P1:5 · P2:7 · P3:4.

---

## SEC-001 — Payroll payout family: no idempotency + no transaction → replay = double money
- **Severity:** S1 · **CWE-799/837 (replay)** · **Confidence:** proven · **Blocker:** conditional (P1) · **Ties:** ARCH-002/003/004, FIN-005, DATA-003
- **Evidence:** `recordPayment` (`payroll/periods/actions.ts:735-768`), `recordAdvance` (`:877-910`), `recordRegionalCityPayment` (`payroll/regional/actions.ts:143-154`) each: create payment row → `createSalaryExpense` (new `Expense` + cash `recordExpenseMovement`) → link `expenseId`, **with no `idempotencyKey` and no `$transaction`**. Each call mints a **fresh** Expense (movement is idempotent per Expense.id, but a new id each time).
- **Impact / financial:** double-click / retried POST / concurrent request → **two payments + two salary expenses + two cash deductions**. `recordAdvance`'s "one/month" `findFirst` and the regional overpay guard are read-then-write (racy). No role escalation — a **replay** double-effect.
- **Repro (safe):** two concurrent submits of the same payout in staging. **Mitigation:** none (contrast the invoice ledger's `idempotencyKey`+P2002). **Remediation:** idempotency key + wrap in `$transaction`. · **Effort:** M.

## SEC-009 — Failed authorization is never audited or logged
- **Severity:** S1 · **CWE-778 (insufficient logging)** · **Confidence:** proven · **Blocker:** no (P1) · **Ties:** OPS-006
- **Evidence:** `requirePageAccess` (`access.ts:351`) silently redirects; `canAccessCompany`/`canAccessClub` return false silently; scoped loaders return null — **no `recordAudit` on denial.**
- **Impact:** an ID-probing attacker, a former employee's stale-session attempt, or a role trying a forbidden money op leaves **no trail** → cross-tenant probing / escalation attempts are invisible; incident forensics impossible. **Remediation:** log denied page-access/company-access/club-access/capability with actor+target+object (see `security-events-spec.md`). · **Effort:** M.

## SEC-002 — X-Forwarded-For trust → per-IP rate limits bypassable
- **Severity:** S2 · **CWE-290/307** · **Confidence:** proven (deployment-dependent) · **Blocker:** no (P1)
- **Evidence:** `getClientIp` (`request-ip.ts:11`) takes XFF index 0 with no trusted-proxy validation → a client-set XFF mints unlimited IP buckets, defeating `login:ip` (30/15m) + `register:ip` (5/h). Vectors: mass-registration, OTP-email amplification, credential-stuffing breadth (single-account brute force still bounded by `login:email` + OTP lock). **Remediation:** derive the client IP from a trusted proxy hop; **verify Caddy replaces inbound XFF.** · **Effort:** S.

## SEC-003 — Refund (and payroll) AI upload not cost-capped
- **Severity:** S2 · **CWE-770** · **Confidence:** proven · **Blocker:** no (P1)
- **Evidence:** `uploadAndAnalyzeRefund` (`refunds/actions.ts:142`) has no `isRateLimited` (invoice/expense siblings do); payroll AI upload (`expenses/payroll-actions.ts:136`) also uncapped. **Impact:** AI-cost + storage abuse by one authenticated user. **Remediation:** add the `ai_analyze` limiter to both. · **Effort:** XS.

## SEC-004 — SSRF via Taxcom OFD `serverBaseUrl` (no host allowlist)
- **Severity:** S2 · **CWE-918** · **Confidence:** proven · **Blocker:** no (P1)
- **Evidence:** `ofd/taxcom/client.ts:152` builds the URL from user-supplied `cfg.serverBaseUrl` (set at `settings/integrations/ofd/actions.ts:64`), validated only as `^https://` (no host allowlist, unlike Saby's `assertSabyHost`). **Impact:** an OFD admin (owner/GD + settings PIN) can point it at internal HTTPS services / `https://169.254.169.254` and the server issues an authenticated request there → internal reachability + **OFD credential exfil**. `https://`-only blocks `file://`/plain-http metadata. **Remediation:** host allowlist (`*.taxcom.ru`) at save + before fetch; same for Astral's override. · **Effort:** S.

## SEC-005 — Obligation settle/write-off: no idempotency/CAS → replay
- **Severity:** S2 · **CWE-799** · **Confidence:** proven · **Blocker:** no (P2)
- **Evidence:** `settleObligation` (`obligations/actions.ts:84`) posts a cash inflow/outflow then a plain `update`, no idempotency key, `sourceId` time-based. **Impact:** double-settle posts the cash movement twice (bounded by outstanding). **Remediation:** idempotency key + CAS on status/outstanding. · **Effort:** S.

## SEC-006 — Client-trusted file `storageKey` (weak upload binding)
- **Severity:** S2 · **CWE-639** · **Confidence:** proven · **Blocker:** no (P2)
- **Evidence:** expense v1 `saveExpense` (`expenses/actions.ts:343`) + payroll `savePayrollStatement` persist `originalFileStorageKey` verbatim from FormData with no proof-of-ownership (invoices use a server-owned single-use `PendingInvoiceUpload` consume). **Impact:** a user can bind their own record to another tenant's blob key; the scoped download route then streams it. Bounded by 128/256-bit key unguessability. **Remediation:** server-issued, company-scoped upload token. · **Effort:** S.

## SEC-007 — Client-supplied `confidence` bypasses the review nudge
- **Severity:** S2 · **CWE-807** · **Confidence:** proven · **Blocker:** no (P2)
- **Evidence:** `confidence` is submitted, not re-derived server-side (`invoices/actions.ts:376`, refunds `:192`). A crafted `confidence:"high"` skips the low-confidence review nudge. **Defeats a nudge, not the human approve→fingerprint→pay chain.** **Remediation:** derive/clamp from the stored extraction. · **Effort:** S.

## SEC-008 — Rate limiter fails open on DB error
- **Severity:** S2 · **CWE-703** · **Confidence:** proven · **Blocker:** no (P2)
- **Evidence:** `rate-limit.ts:92-95` returns `allowed:true` on any DB error → limits vanish exactly under DoS load. **Remediation:** a bounded local fallback / fail-closed on the auth endpoints. · **Effort:** S.

## SEC-010 — CSV formula injection in exports (latent)
- **Severity:** S3 · **CWE-1236** · **Confidence:** proven · **Blocker:** no (P2)
- **Evidence:** `csv.ts:6 escapeCell` doesn't neutralize a leading `= + - @`; user free-text flows into `exports.ts`. **Latent** — CSV export routes are currently hard-404; exposed the moment one is re-enabled. **Remediation:** prefix risky cells with `'`. · **Effort:** XS.

## SEC-011 — Collections OFD sync actions skip the `ofd.sync.trigger` capability
- **Severity:** S3 · **CWE-862** · **Confidence:** proven · **Blocker:** no (P2/P3) · **Evidence:** `syncIpCashAction`/`syncOooCashAction` (`collections/actions.ts:494-510`) check only company, not the capability that gates the dashboard trigger. **Impact:** any collections-page role can trigger a company OFD sync (bounded: own-company, idempotent). **Remediation:** add `can(roles,"ofd.sync.trigger")`. · **Effort:** XS.

## SEC-012 — `removeClubAssignment` omits `clubId ∈ allowedClubIds`
- **Severity:** S3 · **CWE-639** · **Confidence:** proven · **Blocker:** no (P3) · **Evidence:** `payroll/actions.ts:148` checks company+employee, not the assignment's club scope → a same-company, same-employee assignment for a non-accessible club can be soft-deactivated. **Remediation:** add the club-scope check. · **Effort:** XS.

## SEC-013 — Registration enumeration + login timing side-channel
- **Severity:** S3 · **CWE-204/208** · **Confidence:** proven · **Blocker:** no (P2/P3) · **Evidence:** register returns "уже существует" (`auth-actions.ts:87`); login skips bcrypt on a user-miss (`auth.ts:382`) → timing distinguishes account existence. **Remediation:** generic register message; dummy bcrypt on the miss path. · **Effort:** S.

## SEC-014 — Archived club assignable via manager invite
- **Severity:** S3 · **Confidence:** proven · **Blocker:** no (P3) · **Evidence:** `createInvite` club lookup lacks `isActive` (`users/actions.ts:91`) → dangling (inert/hidden) `ClubUserAccess`. `role-actions.ts` filters `isActive` — inconsistent. **Remediation:** add `isActive:true`. · **Effort:** XS.

## SEC-015 — Client-supplied `idempotencyKey` on regional transfer
- **Severity:** S3 · **Confidence:** proven · **Blocker:** no (P3) · **Evidence:** `createRegionalTransfer` stores a client `idempotencyKey` (`collections/actions.ts:399`) → pre-claim/dedupe nuisance if globally unique. **Remediation:** server-derive the key. · **Effort:** XS.

## SEC-016 — Grouped low hardening
- **Severity:** S3 · **Blocker:** no (P3) · **Items:** bcrypt cost 10; HSTS no `preload`; residual `style-src 'unsafe-inline'`; Telegram `update_id` no dedupe; OFD amount no sanity cap; OFD dedupe query not company-scoped; internal lib helpers (`cancelSalaryExpense`, `confirmInternalTransfer`, …) lack a self-scope assertion (safe by caller); scope-check inconsistency (clubId-only, safe today). **Remediation:** batch hardening. · **Effort:** M (aggregate).

## What is sound (explicitly)
- **Tenant boundary holds** — no confirmed cross-company read/write (executed IDOR test + 4 stream reviews).
- **Auth is the strongest area** — 2FA, HMAC 256-bit tokens, fresh per-request authz (no snapshot), atomic revocation, single-use email-bound invites (no mass-assignment).
- **Money guards hold** — reversal chief-only; self-approval blocked (expense/cash-transfer/budget); manager excluded from regional payroll; invoice payment ledger + cash transfer are idempotent+transactional (the template for SEC-001).
- **Files** — scoped download routes, validated uploads, no traversal, no XSS.
- **AI cannot authorize/pay** — human approve→fingerprint→pay chain intact; prompt-injection defended.
- **Integrations** — AEAD-encrypted OFD creds, tenant-bound import, constant-time fail-closed cron secrets, nonce CSP + context-aware framing.
- **No SQL/command injection** (parameterized advisory locks only); **no privilege escalation into money.**

## Production verification required
Re-run `audit:idor-matrix` / the scoped loaders against a production read replica with two real tenants;
confirm Caddy strips inbound `X-Forwarded-For` (SEC-002); verify the OFD `serverBaseUrl` values in prod.
