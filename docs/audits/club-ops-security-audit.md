# CLUB-OPS — Security Audit

**Commit:** `2f4d211` (main) · **Date:** 2026-07-21 · **Type:** READ-ONLY security audit.
**Changed files:** only this report. Code, Prisma schema, migrations, DB, dependencies, env and production were NOT modified. No commit/push/merge/deploy performed. No real secret value is printed anywhere in this report.

**Evidence tags:** `[ФАКТ]` = verified in code/config · `[ВЫВОД]` = inference · `[РИСК]` = risk · `[?]` = unknown / needs infra confirmation.

---

## 1. Executive summary

CLUB-OPS is a multi-tenant financial management app (Next.js 15 App Router + Prisma; prod PostgreSQL, dev SQLite) with a deliberate, consistent security posture. Six parallel domain audits plus first-hand static analysis were performed.

**No P0 confirmed.** Specifically **NOT found**: cross-tenant financial/PII data leak, SQL injection, RCE, arbitrary file read/write, authentication bypass, committed production secret, or an internet-exposed database.

**Strengths (confirmed):**
- **[ФАКТ] Tenant isolation is strong and uniform.** Every scoped single record routes through a canonical `getXForContext` guard (companyId===selected + allowedClubIds + manager-own) before any mutation; no form-supplied tenant id is trusted on existing records; file routes verify parent+child ownership; background jobs scope to the connection's own company. Scope cookies are server-validated against accessible entities.
- **[ФАКТ] Authentication is robust.** Mandatory email OTP (a Session is created ONLY after OTP consume), 256-bit CSPRNG session tokens stored as HMAC only, httpOnly/secure/sameSite cookie, per-request re-derivation of effective roles (immediate de-scoping), session revocation on access/role/password/email change and deletion. OTP is HMAC-keyed, salted, constant-time compared, 5-attempt + 5/hour capped, single-use.
- **[ФАКТ] No SQL injection surface** (zero `$queryRaw`/`$executeRaw`), **no SSRF** (all outbound URLs hardcoded/env, none user-controlled), **no XSS sink** (only a static theme `dangerouslySetInnerHTML`; React auto-escaping elsewhere; download Content-Type from a key-extension allowlist + `nosniff` + attachment).
- **[ФАКТ] Crypto is sound.** OFD credentials + recovery emails use AES-256-GCM (random IV, auth-tag verified, prod fail-closed). All tokens (session/invite/telegram/OTP) stored as keyed HMAC only.
- **[ФАКТ] The commit-2f4d211 financial defenses all HOLD** (approved-data fingerprint, AI-review invalidation on edit, owner removed from review, v1↔v2 refund isolation, calculation-hash staleness, manager Activity closed) — verified by focused re-audit.
- **[ФАКТ] Container/infra baseline is good:** non-root user, security-patched base, DB has no published port (internal Docker network), Caddy is the sole TLS ingress with HSTS + 40MB body cap, secrets are env-only and git-ignored, sanitized logging (no PII/secrets/OCR/raw-JSON in logs or audit metadata; bank accounts masked to last-4).

**Most important weaknesses:**
- **[РИСК P1] No hard production block on the OpenAI AI provider** — a single env flip (`AI_PROVIDER=openai`) sends invoice/expense document images + OCR text to `api.openai.com` (data leaves RU jurisdiction); guarded only by a `console.warn`.
- **[РИСК P1] Data-loss readiness:** app connects as the **DB superuser/owner**; `Company`/`Club` delete **cascades wipe all financial history**; **no scheduled/tested/offsite/encrypted backups** (only pre-deploy dumps on the same host; repo runbook states restore is unverified).
- **[РИСК P2] Cross-tenant integrity/availability via the global `ExpenseCategory` model** (no `companyId`) — a chief_accountant of one tenant can rename/disable categories affecting all tenants.
- **[РИСК P2] Two separation-of-duties gaps** in cash-transfer confirmation and invoice self-approval by a regional director.
- **[РИСК P2] No rate limiting anywhere** (login/registration/OTP-send/AI-analyze/OFD-sync) — brute-force, resource and external-API-cost abuse.

**Verdict:** The application layer (tenant isolation, authZ, IDOR, injection, crypto, financial-action integrity) is production-grade. The residual high risks are **operational/infra** (data-residency config, DB privileges, backups) and a handful of hardening items. **Safe for a controlled single-operator production; before onboarding multiple external companies, close P1 data-loss + data-residency items and the P2 cross-tenant `ExpenseCategory` gap.**

**Risk counts:** **P0 = 0 · P1 = 4 · P2 = 11 · P3 = 18.**

---

## 2. Scope and methodology

**In scope (all read-only):** dev + prod Prisma schema and migrations; auth/session/OTP; access/scope/RBAC; invoices, expenses, refunds, cash, sales, plans/budgets; OFD/Taxcom; notifications/Telegram; AI; file storage; all API/cron/internal routes; next.config; Dockerfile/compose/Caddy/systemd/CI; env handling; package.json/lockfile; pilot tests.

**Method:** (1) safe automated checks — `npm audit` (no fix), `npx prisma validate`, `npx tsc --noEmit`, `git ls-files`/`git status`; (2) first-hand reads of config/crypto/sinks; (3) six parallel domain sub-audits (tenant-isolation+IDOR; auth/session/OTP+CSRF; RBAC+escalation+business-abuse+2f4d211 verification; files+routes+rate-limit+XSS/CSV/SSRF; secrets+logging+AI+OFD+Telegram; DB+backups+deps+prod-config+test-quality). Every finding is anchored to `file:line`.

**Automated results:** `npm audit` = 4 vulns (0 critical, 2 high, 2 moderate). `prisma validate` = valid (dev + prod). `tsc --noEmit` = exit 0. No `.env` is git-tracked (only `*.example`).

**Not performed (prohibited):** no active attacks on production, no brute-forcing real SMTP/Telegram/Taxcom, no DAST, no dependency auto-fix, no writes.

---

## 3. Threat model

**Assets:** user PII (email/phone/name), company/club/legal-entity data, financial documents (invoice/refund/expense scans), bank requisites, invoices/refunds/expenses, OFD receipts, **Taxcom credentials**, **AI API keys**, **Telegram bot token**, **session/OTP/recovery HMAC secrets**, storage files, audit logs, **DATABASE_URL / Postgres superuser**, production backups, internal-service secrets (CRON/DRAIN/WEBHOOK).

**Trust boundaries:** browser → Caddy (public TLS ingress, 80/443 only) → Next.js app (internal :3000) → PostgreSQL (internal, no published port) / local disk or S3 → external APIs (Taxcom, Yandex/OpenAI, Telegram). Cron/drain/webhook are secret-gated boundaries. CI (GitHub Actions → Yandex Container Registry) and the developer workstation are separate trust zones.

**Adversary classes, entry points, residual risk:**

| Adversary | Entry points | Likely goal | Existing defense | Residual risk |
|---|---|---|---|---|
| Anonymous external | `/login`, `/register`, `/api/health`, file/webhook/cron routes | Auth bypass, enum, DoS, secret access | Mandatory OTP; secret-gated routes; CSP; no SQLi/SSRF | **No rate limiting** (brute/DoS/cost); enum via register; health fingerprint (P2/P3) |
| Ordinary user / manager | Server actions, own records, AI analyze, uploads | Cross-tenant access, IDOR, abuse | `getXForContext` guards; own-only visibility | AI/upload cost abuse; no throttle (P2/P3) |
| Regional director | Approve/confirm actions | SoD bypass, over-scope | Approver routing; club scoping | **Self-approve invoice**, **self-confirm own cash transfer** (P2) |
| Accountant / chief_accountant | Pay, review, categories, month-close | Redirect payment, cross-tenant taxonomy | Fingerprint/review guards; CAS | **Global ExpenseCategory** mutation affects all tenants (P2) |
| Owner | Full tenant admin, settings | Data destruction, escalation | Strategic read-only for ops; last-owner guard | Can soft-cancel/reject records; cannot hard-delete via app |
| Former employee | Old session, residual access | Continued access | Immediate de-scope + session revoke on access removal | None significant (strong) |
| Compromised email | OTP delivery, password reset | Account takeover | OTP to the user's own mailbox; 2FA | If email compromised, OTP is too (inherent) |
| Stolen session cookie | Any authed request | Impersonation until expiry/revoke | httpOnly/secure; revocation on security events | 30-day TTL; no device binding (P3) |
| Leaked bot token / cron / drain secret | Telegram send / cron / drain | Spoof notifications / trigger jobs | Env-only; webhook secret; least-data messages | Standing secrets, non-constant-time compare (P3) |
| Attacker with DB read | Session/OTP/recovery tables | Forge auth material | Only HMAC/AEAD stored; keys in env | Cannot forge without SESSION_SECRET; **but app role is superuser** (P1) |
| Attacker with backup/log access | pg_dump, container logs | Bulk data theft | Logs sanitized; DB unpublished | **Backups unencrypted, same-host, untested restore** (P1) |

---

## 4. Tenant isolation

**[ВЫВОД] Strong and consistently applied. No P0/P1 tenant-isolation defect.**

- **[ФАКТ]** Canonical guard everywhere: `getInvoiceForContext` (`src/lib/invoices.ts:434-449`), `getExpenseForContext` (`expenses.ts:117-135`), `getRefundForContext` (`refunds.ts:60-78`), `getSaleForContext` (`sales.ts:131`), `getSalesReportForContext` (`sales-reports.ts:124-142`), `getBudgetRequestForContext` (`budgets.ts:456-466`), `getMandatoryPaymentForContext` (`mandatory-payments.ts:86`), `getLegalEntityForContext` (`legal-entities.ts:191-199`) — each: `findUnique(id)` → reject `companyId !== selectedCompanyId` → reject `!allowedClubIds.includes(clubId)` → (operational) `managerCannotSeeRecord`.
- **[ФАКТ]** Scope is server-derived and validated: `getCurrentCompanyAndClub` intersects cookie values with `getUserCompanies`/`getUserClubs` (`access.ts:138-168, 313-344`); a forged cookie falls back to accessible entities. Scope enforced in DB queries, not UI.
- **[ФАКТ]** File download routes verify parent+child ownership and re-bind the object to the record (`api/invoices|expenses|refunds|sales-reports/[id]/file`, `api/expenses/[id]/documents/[docId]`); foreign/missing → generic 404 (no existence leak).
- **[ФАКТ]** Background jobs derive every tenant field from the `OfdConnection` + its mappings, never ambient scope (`ofd/importer.ts:76-77,101-109,228,285`); daily cron writes each connection in isolation; `runSyncNowForCompany` filters `companyId`.
- **[ФАКТ]** Prisma is a module singleton with no per-tenant mutable/global state (`prisma.ts:7-13`); no cross-tenant cache. Error/audit paths leak no other tenant's data; audit masks accounts to last-4.

**Cross-tenant findings:**
- **[РИСК P2] Global `ExpenseCategory` (no `companyId`)** — `schema.prisma:906-917`; mutations `expenses/category-actions.ts:31-85` gated only by `requireChiefAccountant`. A chief_accountant of Company A can `setExpenseCategoryActive(false)`/`rename`/`create` a category that is **shared by all tenants** → cross-tenant availability (blocks other tenants' expense submission via `isActiveExpenseCategoryKey`) + integrity + business-name leakage. **CWE-639/CWE-284.** (Register R-TEN-1.)
- **[?] AMB-1** `createSale` (`sales/actions.ts:69-77`) authorizes the club via `canAccessClub` but does NOT require `clubId ∈ allowedClubIds` like other creates — same-tenant scope deviation, not cross-tenant (P3, R-TEN-2).
- **[?] AMB-2** `createOrUpdateMandatoryPayment` validates `legalEntityId.companyId===companyId` but not the club↔LE `ClubLegalEntity` link (same-company; P3, R-TEN-3).
- **[?] AMB-3** Several `updateMany({where:{id,status}})` omit `companyId`/`clubId` in the write filter but are preceded by a scoped `findFirst`/`getXForContext` and `id` is a global cuid → TOCTOU-safe; defense-in-depth note only.

### Tenant-isolation table (representative)
| Route/action | Tenant source | Tenant validation | Object-ownership | Bypass | Sev |
|---|---|---|---|---|---|
| invoices (all mutations + file) | derived / clubId validated on create | ✅ | ✅ getInvoiceForContext + author + CAS | none | — |
| expenses v1/v2/cash/docs | derived | ✅ | ✅ + `doc.expenseId===id` | none | — |
| refunds v1/v2 + pay + file | derived | ✅ | ✅ + LE↔club validated on pay | none | — |
| cash collections/withdrawals | findFirst companyId+clubId∈clubIds | ✅ | ✅ | none | — |
| budgets / mandatory-payments | scoped loader + manageable clubs | ✅ | ✅ (LE↔club not checked, AMB-2) | none / P3 | — |
| users / invites / roles | bound to record's company/club | ✅ | ✅ assertCanManageUser | none | — |
| OFD admin / legal entities / settings | requireOfdAdmin/Owner(record.companyId) | ✅ | ✅ | none | — |
| **expense categories** | **none (global model)** | **NO** | n/a | cross-tenant mutate/disable | **P2** |
| sales create | canAccessClub (not allowedClubIds) | partial | ✅ on transition | same-tenant scope deviation | P3 |
| cron/drain/webhook | secret (no tenant param) | secret-gated | n/a | none | — |
| export/[type], analytics/export, templates | n/a | 404 unconditional | n/a | none | — |

---

## 5. Authentication

**[ВЫВОД] Robust. No P0/P1 auth bypass.** Findings are hardening (P2/P3).

- **[ФАКТ]** Registration (`auth-actions.ts:49-97`): global `User.role="owner"` (inert for in-app authZ), email-regex + password-min-8, **no Session created** (starts OTP). Existence check returns a distinct message (enumeration, R-AUTH-2).
- **[ФАКТ]** Login step 1 `verifyLoginPassword` (`auth.ts:350-360`): generic error for all failure modes; inactive/no-hash rejected pre-OTP; bcrypt cost 10 runs only for a valid active user (timing oracle, R-AUTH-5).
- **[ФАКТ]** OTP (`otp.ts`, `login-challenge.ts`): HMAC(OTP_SECRET, challengeTokenHash:otp), salted per challenge, `timingSafeEqual` after `/^\d{6}$/` guard; TTL 10 min, max 5 attempts (persist across resends), resend cooldown 60s, max 5 sends/hour/account; single-use via `consumedAt` CAS (`login-challenge.ts:239-245`). **A Session is created ONLY in `verifyCurrentChallenge`** (`:269`) — you cannot log in without OTP. Brute-force ≈25 guesses/hour/account = infeasible.
- **[ФАКТ]** Session (`session.ts`): token `randomBytes(32)` (256-bit), stored as `hashToken`=HMAC(SESSION_SECRET, token); cookie `club_ops_session` httpOnly, `secure` in prod, `sameSite:lax`, path `/`, 30-day expiry. Validity = not revoked + not expired + `user.isActive`. No cross-request caching; effective roles recomputed per request → **immediate de-scoping** on access removal (also explicitly revoked in the same tx, `users/actions.ts:528,555`). No session-fixation (post-OTP token; separate challenge cookie cleared on success).
- **[ФАКТ]** **DB (Session) leak → cannot forge a cookie**: only `tokenHash`/`challengeTokenHash`/`otpDigest`/`restoreTokenHash` stored; inversion needs env-side secrets. Deleted-account emails AES-256-GCM encrypted under a separate `ACCOUNT_RECOVERY_SECRET`.

**Cookie flags:** httpOnly ✅, secure (prod) ✅, sameSite lax ✅, path `/`, no explicit domain (host-only, good), 30-day maxAge.

**Findings:** no per-IP / global rate limiting on login/registration/OTP-send (R-AUTH-1, P2); registration enumeration (R-AUTH-2, P3); password policy length-only min-8, no complexity/breach check (R-AUTH-3, P3); login timing enumeration (R-AUTH-5, P3); dev fallback secrets for SESSION/OTP/RECOVERY (prod fail-closed; P3 unless a non-prod build is internet-exposed, R-SEC-3).

---

## 6. Authorization / RBAC

Seven tenant roles (owner, general_director, regional_director, manager, chief_accountant, accountant, marketer) + two dormant/global roles (`User.role="superadmin"`, `User.systemRole="system_admin"`).

- **[ФАКТ]** Effective roles derive ONLY from CompanyUserAccess/ClubUserAccess (`access.ts:293,313`); global `User.role` never grants app permissions. `operational.create` = manager + regional only; owner/GD strategic read-only.
- **[ФАКТ] No privilege escalation found:** `getInvitableRoles` forbids inviting a higher role (owner→{owner,chief,GD-if-none}; GD→{regional,chief,accountant,manager,marketer}; regional→{manager}), enforced server-side in `createInvite`. `assertCanManageUser` (`access.ts:596-642`) blocks managing owner/GD/equal, out-of-scope managers, self, and superadmin targets. Last-active-owner protection re-checked in-transaction (`account-deletion.ts:114`, `users/actions.ts:521,638`). Role changes GD-only, manager↔regional only, atomic `STALE_ROLE` re-check. Invite accept = email-match + single-use CAS (no redirection/reuse).
- **[ФАКТ] No UI-only authZ gaps** — every conditionally-rendered control's backing action re-checks authority.
- **[ФАКТ]** `superadmin` (cross-tenant bypass, `access.ts:37,139,294`) is **dormant** — set by no seed/migration/registration/CLI (registration→"owner", `seed.ts:106`). `system_admin` is CLI-granted (`scripts/security-system-admin.mjs:76`), surface limited to account recovery, no financial-data access.

**Findings (both separation-of-duties):**
- **[РИСК P2] R-RBAC-1 — Regional self-confirms own "Директор→Клуб" cash transfer.** `cash-actions.ts:204` requires `userHasClubRole(actor, club, ["manager"])`; via `ROLE_IMPLICATIONS` (`access.ts:49`) `regional_director→manager`, so the regional who **created** the transfer satisfies it and can confirm receipt themselves — contradicting the code's own comment ("a regional cannot confirm", `:203`). **CWE-863.**
- **[РИСК P2] R-RBAC-2 — Regional approves an invoice they created.** `applyInvoiceAction` approve branch omits the `isCreator` gate that `send_to_review` has (`invoices.ts:195-207`); the module's general docstring says the creator may never approve (`:171-173`) — a genuine ambiguity. Payment still needs a separate accountant, limiting impact. **CWE-863.**
- **[?]** Non-owners with the `settings` page (general_director) can `createCompany` and become owner of a NEW isolated tenant — not within-tenant escalation; confirm intent.

Effective-role expansion (`chief_accountant→accountant`) is intended and not over-broad; the only over-broad implication is the `regional_director→manager` at the one cash-confirm site (R-RBAC-1).

---

## 7. IDOR

**[ВЫВОД] No IDOR found.** Every id-taking action enforces ownership before mutation.

| id | actions | ownership before mutation? | bypass |
|---|---|---|---|
| invoiceId/expenseId/refundId/saleId/reportId | all mutations + file routes | ✅ getXForContext + CAS | none |
| documentId (expense/refund) | remove, download | ✅ `doc.<parent>Id===id` + tenant | none |
| cash op id | review/cancel/confirm | ✅ findFirst companyId+clubId | none |
| budgetRequestId / mandatoryPaymentId | approve/reject/update | ✅ scoped loader | none |
| clubId/companyId/legalEntityId | creates / admin | ✅ allowedClubIds/canAccessClub + companyId match; LE↔club on pay | none (LE↔club not on mandatory-payment, AMB-2, P3) |
| userId/accessId | manage/revoke/role | ✅ assertCanManageUser / row.companyId | none |
| inviteId | accept/manage | ✅ email-match gate; canManageInvite | none |
| ofdConnectionId/mappingId | OFD admin | ✅ findFirst companyId | none |
| categoryId | rename/setActive | ⚠ role-gated, **no company scope** (global model) | cross-tenant (R-TEN-1, P2) |

---

## 8. CSRF / XSS / SSRF / injection

**CSRF — [ФАКТ] no exploitable surface.** All state-changing mutations are Next 15 / React 19 Server Actions (POST-only, Origin↔Host check, non-enumerable action IDs), reinforced by `form-action 'self'` + `frame-ancestors 'none'` + `X-Frame-Options: DENY`. Custom state-changing routes (cron/drain/webhook) authenticate by **header secret, not cookies** → CSRF N/A. All other routes are read-only GET; **no state-changing GET**; no cookie-authed cross-origin JSON POST. Defense does not rely solely on SameSite.

**XSS — [ФАКТ] none found.** Only `dangerouslySetInnerHTML` is a static theme-init script (`layout.tsx:33-39`, no user data — this is why CSP keeps `script-src 'unsafe-inline'`). React auto-escapes all user fields (comments, counterparty, subject, client/club/company names, audit metadata, AI warnings, OCR item names). Content-Disposition filenames are `encodeURIComponent`/`safeFilename` sanitized. Uploaded HTML/SVG cannot execute (ext-allowlist content-type + `nosniff` + forced attachment).

**CSV/formula injection — [РИСК P3] latent.** `csv.ts:escapeCell` (`:6-8`) RFC-4180-quotes but does NOT neutralize leading `= + - @ \t`; consumers `exports.ts` write user-controlled names — but `exports.ts`/the CSV export route are **dead/404** → latent only. xlsx template builders (`budget-import.ts`, `plan-import.ts`) write `club.name` without formula-prefix sanitization (tenant-self download, low). OFD `itemName` stored raw (`importer.ts:368`) — latent if ever CSV-exported. (R-INJ-1.)

**SSRF — [ФАКТ] none.** All outbound URLs hardcoded (Yandex/OpenAI/Telegram) or env-only (`RU_AI_ENDPOINT`, operator-set); no user-controlled URL. `pdftoppm` spawned with fixed argv, stdin/stdout, no shell.

**SQL injection — [ФАКТ] none.** Zero `$queryRaw`/`$executeRaw`/`Unsafe` in `src/`; all access via parameterized Prisma. **Command injection — none** (only `spawn("pdftoppm", fixedArgs)`; no `exec`/shell). **No `eval`/`new Function`.**

---

## 9. File security

**[ВЫВОД] Strong.**
- **[ФАКТ]** Path guard `isSafeStorageKey` (rejects `..`,`\`,leading `/`,>256,charset) at write and every read; per-reader strict regex (e.g. `/^invoices\/[a-f0-9]{32}\.(jpg|png|webp|pdf)$/`). Keys are server-random hex (16–32 bytes), never the original filename.
- **[ФАКТ]** Upload validation: declared-MIME allowlist + size (10MB/file) + **magic-byte signature** (`sniffDocumentSignature`/`validateSignature`; HEIC rejected) for invoice/expense/refund/cash. Concurrency safe (expense-docs atomic `$transaction` re-count + orphan cleanup). File read fully into memory bounded by Caddy 40MB + 10MB logical cap. No archive extraction; PDF raster is first-page-only, 20s timeout, 8MB PNG cap → no zip/decompression bomb.
- **[ФАКТ]** Download authZ: every file route enforces `getXForContext` (tenant+club+manager-own) and re-binds key/docId to the record; Content-Type from a key-extension allowlist (`safeDownloadHeaders`), `nosniff`, `Cache-Control: private, no-store`, attachment for non-inline. Access re-checked per request (post role-removal/deletion → 404). Failure logs use a non-reversible `storageKeyHash`. No bank requisites in URLs/logs.
- **[ФАКТ]** `getSignedUrl` (S3 presign) is defined but called by **no route** (all access via authorized app routes).

**Findings:** sales-report upload lacks the magic-byte check (`sales-report-storage.ts:48-69`; mitigated at download, R-FILE-1 P3); no storage-object cleanup on entity cancel/delete → orphans (R-FILE-2 P3).
**[?] Unknown (infra):** S3 bucket public-access-block / bucket policy / SSE-at-rest — only `S3_*` env is in repo; cannot confirm objects are private/encrypted.

---

## 10. API / internal routes

| Route | Method | Auth | Tenant | Secret compare | Rate limit | Leakage | Sev |
|---|---|---|---|---|---|---|---|
| `*/[id]/file`, documents | GET | session + record-scope | ✅ | n/a | ❌ | none (hashed logs) | ok |
| `cron/ofd/daily` | POST | `CRON_SECRET` (Bearer/header) | global (per-connection) | `===` non-constant-time | ❌ | safe aggregates | P3 |
| `internal/notifications/drain` | POST | `NOTIFICATION_DRAIN_SECRET` | n/a | `!==` non-constant-time | ❌ | counts only | P3 |
| `telegram/webhook` | POST | `X-Telegram-Bot-Api-Secret-Token` | n/a | `!==` non-constant-time | ❌ | payload never logged | P3 |
| `health` | GET | none | none | n/a | ❌ | commit SHA + provider names/booleans (no secrets) | P3 info |
| `me/access` | GET | session | self-only | n/a | ❌ | own context only | ok |
| `budgets|sales-plans template` | GET | session + `canImportPlansAndBudgets` | ✅ | n/a | ❌ | xlsx, no secrets | ok |
| `export/[type]`, `analytics/expenses/export`, invoice/expense/sales-report templates | GET | — | — | — | — | **404 unconditional** | ok |

**[ФАКТ]** Missing `CRON_SECRET`/`DRAIN_SECRET`/`WEBHOOK_SECRET` → fail-closed (503/401/403; never runs). No dev/debug/preview routes shipped. `me/access` lacks `no-store` (minor). Non-constant-time secret compares (R-API-1, P3). Health info-disclosure (commit SHA + which integrations configured, R-API-2, P3).

---

## 11. Rate limiting and abuse

**[ФАКТ] There is NO general-purpose rate limiting** (no util, no per-IP/global limiter, no middleware). No code trusts `X-Forwarded-For` for decisions (so no XFF-spoof surface, but also no IP throttle).

| Surface | Limit | Gap |
|---|---|---|
| OTP verify | 5 attempts/challenge (per-account) | no per-IP |
| OTP send/resend | 60s cooldown + 5/hour (per-account) | per-account only |
| **Login password** | **none** (bcrypt cost only) | **no lockout/counter** |
| **Registration** | **none** | mass creation + email amplification |
| **File upload / AI analyze / OFD sync-now** | **none** | **external-API cost abuse** |
| webhook/drain/cron | secret only | no volume cap |

**Abusable:** password brute-force (yields the password; OTP still blocks takeover) + unauthenticated bcrypt CPU DoS + OTP-email spam (R-RATE-1, P2); registration abuse (R-RATE-2, P2); AI/OFD cost abuse by an authenticated user (R-RATE-3, P2). **[?]** Whether Caddy/nginx applies edge rate limiting — not confirmed from repo (app layer has none).

---

## 12. Secrets

**[ФАКТ] No secret committed** — `.env` is git-ignored (`.gitignore:5`); only `*.example` templates are tracked. All app secrets read lazily from `process.env` with domain-separated dedicated keys. Secrets never appear in responses/logs/audit (verified).

| Secret | Read at | Dev fallback | Prod fail-closed | Min-length | Note |
|---|---|---|---|---|---|
| SESSION_SECRET | tokens.ts:8-15 | yes (labelled dev-insecure) | yes (throw) | **NO** | R-SEC-1 |
| OTP_SECRET | otp.ts:14-21 | yes | yes | **NO** | R-SEC-1 |
| ACCOUNT_RECOVERY_SECRET | account-recovery.ts:12-19 | yes | yes | ≥32 ✅ | ok |
| OFD_SECRET | ofd/crypto.ts:8-15 | yes | yes (missing OR <32) | ≥32 ✅ | ok |
| CRON / DRAIN / WEBHOOK | daily.ts / telegram config | none→null | yes (503/401/403) | n/a | ok |
| TELEGRAM_BOT_TOKEN | telegram/config.ts:10 | none | no-op if unset | n/a | in URL path (infra log, P3) |
| OPENAI/YANDEX/SMTP/S3 keys | respective clients | none | error/mock/absent | n/a | ok |

**[ФАКТ]** Crypto sound: AES-256-GCM (random IV, tag verified, `v1:` versioned, returns null on tamper — no oracle) for OFD creds + recovery emails; HMAC-SHA256 for all tokens; OTP salted per challenge.
**[РИСК P2] R-SEC-1:** `SESSION_SECRET`/`OTP_SECRET` require presence but **not length/entropy** in prod (unlike OFD/RECOVERY which enforce ≥32). A weak SESSION_SECRET weakens every session cookie + Telegram link HMAC. **CWE-521.**
**[РИСК P3] R-SEC-3:** dev fallback secrets are forgeable if a non-prod build (not `NODE_ENV=production`) is ever internet-exposed.
**[?]** The `*.example` files were not printed; confirm via a manual/`git-secrets` scan that they contain only placeholders — if any real-looking token exists, **rotate it** (do not print).

---

## 13. Logging / data leakage

**[ВЫВОД] Strong; deliberate sanitization.** All ~40 `console.*` sites reviewed:
- **[ФАКТ]** AI logs only whitelisted technical fields (correlationId, stage, code, http status, coarse size bucket) — never base64/OCR text/prompt/response/requisites/storage key (`invoice-analyzer.ts:253-259`). OFD logs ids/counts/FN/date ranges — never credentials/session-token/fiscal JSON/buyer PII. Notifications log event+counts only. Email logs recipient DOMAIN + error code — never the OTP/full address/body. Taxcom logs only `apiErrorCode`+description (≤200 chars).
- **[ФАКТ]** `recordAudit` metadata carries only safe scalars; bank accounts masked to last-4 (`invoices/actions.ts` `maskAccount`), refund requisites via `maskDigits`. No full account / phone / document content / storage key / secret in any audit payload.
- **[ФАКТ]** Prisma errors reduced to `error.message` in logs and generic Russian strings to clients — no raw Prisma objects to the client.

**Findings:** dev OTP printed to console under `OTP_TEST_TRANSPORT` (double-guarded, misconfig-only, R-LOG-1 P3); health commit-SHA disclosure (R-API-2 P3). **[?]** Production log destination / retention / access / external log service — infra-only, unknown.

---

## 14. AI security

- **[ФАКТ]** Prompt-injection defense: system rules + document text wrapped in `"""…"""` labelled "ДАННЫЕ, не инструкции" + strict `mapInvoiceJson` output validation (unknown keys dropped, values typed/normalized, category whitelisted). Fallback runs once, never loops. Sizes bounded (10MB upload, 30k OCR, 20k model), per-request timeouts.
- **[ФАКТ]** A user **cannot** send another tenant's file to AI — `uploadAndAnalyzeInvoice` operates on a fresh upload scoped to a `clubId` the caller is verified to access (`invoices/actions.ts:176-186`), never an existing record id.
- **[ФАКТ]** Yandex sets `x-data-logging-enabled:false`; Yandex-path `rawTextOrModelOutput` forced to `""` (not persisted).
- **[РИСК P1] R-AI-1 — No hard production block on the OpenAI provider.** `selectedAiProvider` (`openai-client.ts:47-63`) will use OpenAI whenever `AI_PROVIDER=openai`+key are set, guarded only by a one-time `console.warn` (`:32-38`). In production this sends invoice/expense **document images + OCR text** (bank requisites, counterparty/payer names) to `api.openai.com` — **data leaves RU jurisdiction**. Compounded: expense/refund analyzers support only `openai`|`mock` (`expense-analyzer.ts:288-302`), so enabling real expense AI today *requires* OpenAI. **CWE-201.**
- **[РИСК P3] R-AI-2:** OpenAI-path raw model JSON is round-tripped through a client hidden field and persisted as `rawExtractedJson` (`InvoiceUpload.tsx:158`→`invoices/actions.ts:423`) — client-controllable stored field; only `parseInvoiceWarnings` reads it back and React escapes, so impact limited (CWE-602).
- **[РИСК P3] R-AI-3:** no per-user quota on analyze → cost abuse (CWE-770).

**[ВЫВОД]** The invoice AI-review + fingerprint pay guards are sufficient for payment integrity; the residual gap is the **data-residency control (R-AI-1)**, not the extraction logic.

---

## 15. OFD / Taxcom security

- **[ФАКТ]** Credentials AES-256-GCM at rest (random IV, tag verified, prod requires OFD_SECRET ≥32); masked/empty update fields preserve existing ciphertext. Decrypted creds used only server-side inside `createTaxcomClient`; view models expose only `hasLogin/hasPassword`/safe fields; Session-Token cached in-memory, never persisted/logged.
- **[ФАКТ]** All OFD admin actions gated `owner`/`general_director` (`requireOfdAdmin`) + `findFirst({id,companyId})`; no cross-company connection access. Sync-now company-scoped; cron secret-gated; one active run per connection (`already_running`); mapping selection by (companyId, provider, legalEntityId), not stale connectionId, so an ИП касса can't attach to an ООО connection.
- **[РИСК P3] R-OFD-1:** Taxcom `itemName` stored raw (`importer.ts:368`) and shown in the OFD UI (React-escaped, safe today) — **latent** CSV/formula-injection if item names are ever wired to a CSV/XLSX export (see R-INJ-1).
- **[ФАКТ]** ФПД/fiscalSign intentionally not stored on items; buyer PII / raw fiscal JSON never persisted.
- **OFD-reconciliation readiness (from prior audit):** cash/electronic split + fiscal fingerprints exist; no acquiring source yet.

---

## 16. Telegram security

- **[ФАКТ]** Bot token env-only, never logged/returned; appears in the `api.telegram.org/bot<token>/…` URL path (standard; infra-log exposure, P3). chatId never returned to client (`linking.ts:147-165`).
- **[ФАКТ]** Webhook checks `X-Telegram-Bot-Api-Secret-Token`, refuses all (403) if unset/mismatched; payload never logged; only `/start`/`/help`; no user enumeration.
- **[ФАКТ]** Link code: 24-byte random, shown once, HMAC stored, 10-min TTL, single active per user, single-use transactional CAS, max 5 attempts; failures generic.
- **[ФАКТ]** Messages minimal (title + club + rounded rubles only) — never comment/reason/requisites/PII. Outbox: pending→sending CAS lease, backoff honoring `retry_after`, 403→deactivate, attempt ceiling; counts-only return.
- **[РИСК P3] R-TG-1:** non-constant-time webhook/drain secret compare (shared with R-API-1).

**Future relay (RU → external relay → Telegram) minimal requirements (assessment only):** mutual auth (relay API key or mTLS, distinct from bot token); HMAC request signing + timestamp+nonce replay protection; least data (`{chatId, pre-rendered text, optional url}` only; bot token stays on the relay, never leaves RU app); stateless relay with no CLUB-OPS DB access; metadata-only logging with short retention; IP allowlist (RU egress → Telegram only); independent rotation of relay key vs bot token.

---

## 17. Database security

- **[ФАКТ] No Postgres RLS** anywhere (`RLS|POLICY|GRANT` grep across `prisma/**` = none) — tenancy is app-level only.
- **[ФАКТ] App connects as the DB superuser/owner** (`POSTGRES_USER=clubops`, same role in `DATABASE_URL`; `deploy/.env.production.example:22-24`) → **R-DB-1 P1** (CWE-250/269): any app bug/SQLi/RCE inherits full DDL/DELETE/TRUNCATE. (No SQLi exists today, so this is defense-in-depth over-privilege.)
- **[ФАКТ] `Company`/`Club` deletes cascade to all financial children** (Invoice/Expense/Sale/Refund/BalanceSnapshot/CashMovement/Budget/…; `schema.prisma:461,735,852,988,1056`) → **R-DB-2 P1** (CWE-1250): a single `DELETE FROM "Company"` wipes a tenant's entire financial history. No app path does this (club delete is soft-archive), so reachable only via direct DB / bad migration / `prisma migrate reset` — but the superuser role + no tested backup make it unrecoverable.
- **[ФАКТ]** User financial `createdBy` relations are `onDelete: Restrict` → users are tombstoned, never hard-deleted while authoring records. `AuditLog` uses decoupled scalar ids (no cascade in) and has **no delete path** in `src` (append-only, tamper-evident by convention only — no DB immutability).
- **[ФАКТ]** All financial tables are soft-delete/append-only; the only hard-deletes are OTP cleanup, access rows on deletion/demotion, superseded budget requests, and a recomputed OFD rollup — none on financial/audit tables. All `updateMany` are tightly `where`-bounded (id+status CAS); no blind mass-update.
- **[РИСК P3] R-DB-4:** `Refund.legalEntityId` is a bare scalar with no FK (`schema.prisma:449`) — integrity is app-only.
- **[РИСК P3] R-DB-5:** `DATABASE_URL` uses `sslmode=disable` (prod example) / `prefer` — mitigated because Postgres is on an internal Docker network with no published port; risk if topology changes.

---

## 18. Backups and deletion

- **[ФАКТ]** Account deletion (`account-deletion.ts:100-173`) is a correct idempotent tombstone (anonymize identity, clear credentials, revoke sessions+OTP, delete access, expire invites, sole-owner guard in-tx, encrypted recoverable email with hashed single-use token, 30-day window). Company/Club/LE = soft archive/deactivate only; **no accidental bulk delete via the app**.
- **[РИСК P1] R-BAK-1 — Backups are not production-ready.** Only a **pre-deploy** `pg_dump -Fc` (`deploy/deploy.sh:194-207`, mode 600, keep 7), triggered only when the image digest changes. **No scheduled/periodic backup, no WAL/PITR, no offsite, unencrypted at rest.** The repo's own `docs/audit/BACKUP_RESTORE_RUNBOOK.md:9`: "No automated backup job, retention policy, or tested restore is wired in the repository." Restore is manual and untested. **CWE-404/CWE-311.**

**Scenario readiness:** accidental single-record delete → covered (soft-delete). Tenant/Company delete → no app path but catastrophic at DB (R-DB-2). Owner compromise → OTP + last-owner guard, but owner can soft-cancel/reject records. Ransomware/host loss → **only same-host pre-deploy dumps** (R-BAK-1). Corrupt migration → `migrate deploy` is non-destructive + one-shot on the VM (auto-migrate on boot only in the single-container path). Storage/DB loss / partial restore → untested. **[?]** Volume snapshots / managed-DB backups / offsite / encryption — infra-only, unknown.

---

## 19. Dependencies

`npm audit` (no fix): **4 vulns — 0 critical, 2 high, 2 moderate.**

| Package | Installed | Advisory | In-context exploitability | Sev | Upgrade path (not applied) |
|---|---|---|---|---|---|
| **xlsx** | ^0.18.5 | Prototype pollution (CVE-2023-30533) + ReDoS (CVE-2024-22363), **no npm fix** | Reachable: `excel-import.ts:42-49` parses **user-uploaded** workbooks (owner/GD/accountant import). Worst case server DoS/pollution; requires authenticated privileged uploader | **P2** (R-DEP-1) | SheetJS vendor CDN `0.20.x` or migrate to `exceljs`; add size/complexity caps |
| **nodemailer** | ^6.10.1 | SMTP/CRLF injection, TLS-cert, SSRF, ReDoS (HIGH) | Low: transport fully server-configured from env; bodies templated; user-derived strings HTML-escaped; only invite-recipient address is user-typed (validated) | **P3** (R-DEP-2) | upgrade to `>=7`; keep addresses validated |
| next | ^15.0.3 | via postcss (moderate) | build-time transitive | P3 | keep next current |
| postcss | ^8.4.49 | CSS-stringify XSS (moderate) | **devDependency**, build-time only; not run on user input at runtime | negligible | — |

Others (bcryptjs ^3.0.3 pure-JS cost-10, unpdf ^1.6.2, @aws-sdk/client-s3 ^3.700.0, prisma ^5.22.0) — no blocking advisories noted. **[?]** No `npm audit`/Dependabot in CI (only a single hardcoded CVE pin check in `pilot-deploy-config.mjs`).

---

## 20. Security headers

- **[ФАКТ]** `next.config.mjs`: CSP (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `img/font data:`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. Caddy adds `Strict-Transport-Security max-age=31536000; includeSubDomains`, removes `Server`. Clickjacking: mitigated (DENY + frame-ancestors none).
- **[РИСК P2] R-HDR-1:** CSP `script-src 'self' 'unsafe-inline'` (`:19`) — `'unsafe-inline'` defeats much of CSP's XSS value (needed only for the static theme script; a nonce/hash would remove it). **Permissions-Policy absent**; `poweredByHeader` not disabled → `X-Powered-By: Next.js` leaked; HSTS has no `preload`. **CWE-1021/CWE-79/CWE-200.** (Given no XSS sink exists, real risk is defense-in-depth.)

---

## 21. Production configuration

- **[ФАКТ] Good:** non-root container user (`Dockerfile:71,91`), security-patched base each build, standalone output, node-based healthcheck (no shell); DB + app have **no published ports** in the hardened stack (`deploy/docker-compose.prod.yml`), Caddy is sole ingress; `.env` `chmod 600`, backups `700`/dumps `600`; no `curl|bash`; CI uses `--password-stdin` + keyless VM metadata token; migrate is a one-shot service on the VM.
- **[РИСК P2] R-CFG-1:** the alternate `docker-compose.production.yml:50-51` publishes `3000:3000` on all interfaces (bypasses Caddy TLS/HSTS/body-cap) and relies on boot-time auto-migrate — divergent from the hardened stack. **CWE-668.** [?] Which compose is canonical in prod is infra-dependent.
- **[РИСК P3] R-CFG-2:** no container runtime hardening (`read_only`, `cap_drop:[ALL]`, `security_opt: no-new-privileges`, `pids_limit`, CPU/mem limits) on any service.
- **[РИСК P3] R-CFG-3:** CI uses a long-lived static Yandex SA JSON key as a GitHub secret (`deploy-yandex.yml:50-51`) — standing credential; prefer short-lived/OIDC.
- **[?] Unknowns (infra):** host firewall, SSH access model, TLS at origin vs Caddy-only, backup/PITR/offsite, log retention, managed-vs-self Postgres patching, bcrypt cost verification in a live env.

---

## 22. Business-logic abuse — 2f4d211 defense verification

**[ФАКТ] All last-package defenses HOLD** (independently re-audited):

| Defense | Status | Evidence |
|---|---|---|
| approvedDataFingerprint bypass | **HOLDS** | written on approve (`invoices/actions.ts:1136-1141`), compared at pay (`invoices.ts:392-394`); no edit path mutates approved financial fields without invalidation |
| aiDataReviewed invalidation | **HOLDS** | reset on every edit path (updateInvoice/replaceFile/saveAndResubmit); reviewInvoiceData re-signs new values; payer/subject/LE not even parsed by the author path |
| owner write access to AI review | **REMOVED** | `canReviewInvoiceData = has(roles,"accountant")` (owner excluded, `invoices.ts:304`) |
| medium-confidence critical-gap guard | **PRESENT** | at pay only; catches empty critical fields (accepted limitation, R-BIZ-2) |
| double-pay / replay | **HOLDS** | CAS `updateMany where {id,status}` across invoices/refunds/expenses/cash |
| v1↔v2 refund isolation | **HOLDS** bidirectionally | v1 rejects entryVersion≠1 (`refunds/actions.ts:241,285`); v2 rejects ≠2; payRefundV2 accountant/chief + CAS + LE↔club + no Expense |
| stale calculationInputHash | **HOLDS** | operand fingerprint stored at calc, re-checked at submit (`refund-document-actions.ts:515`) |
| manager Activity access | **CLOSED** | absent from ROLE_PAGE_ACCESS + `buildActivityWhere` returns null for manager |

Other abuse: closed-month enforced on all money write paths; cross-club/company isolated; negative/zero amounts rejected; parallel-request races CAS-guarded.
**Residual:** **[РИСК P2]** regional self-approve invoice (R-RBAC-2) and self-confirm own cash transfer (R-RBAC-1); **[РИСК P3]** no upper-bound/overflow cap on amounts (R-BIZ-1); legacy null-fingerprint invoices skip the pay-time compare (theoretical, R-BIZ-3).

---

## 23. Security test quality

**[ВЫВОД] False-confidence risk: HIGH.** [ФАКТ] **No pilot imports production `src/**`** — every "behavioral" test re-implements (mirrors) the logic inline against a real dev-SQLite Prisma; the only tie to shipped code is `readFileSync + source.includes("…")` static grep (~150–250 string-guard asserts across 12 files).

- **Genuinely tested (DB invariants on mirrored logic):** OTP HMAC/lockout/one-time/session-gating (strongest), session revocation/expiry/tenant isolation, account-deletion tombstone + idempotency, manager IDOR sibling denial, refund slot-uniqueness + refundId-spoof rejection, cash-wallet atomicity/idempotency, invoice idempotent CAS, invite rate-limit.
- **Only string-guarded (never executed):** the real server actions + route handlers, **file-download authorization**, **month-close write-blocking** (asserted via precondition-row existence + a source `.includes("monthClosedError")`, not driven to a rejection), all deploy/container/header checks.
- **Consequences:** mirror drift (a regression in real `src` won't fail a test); `.includes()` proves presence not reachability; no HTTP/route/middleware layer ever executed.

**Missing security tests (do NOT add now):** concurrent double-pay/double-approve race; CSRF/origin on server actions; reflected/stored XSS output-encoding; login brute-force lockout; route-layer auth for unauth/wrong-role; dependency audit in CI; security-header assertions; endpoint rate-limiting; cross-tenant category mutation.

---

## 24. Risk register

Severity model per the task. **P0 = 0.** (No confirmed cross-tenant leak, RCE, SQLi, arbitrary file R/W, open DB, committed prod secret, or unauth mass data change.)

### P1 — High
| ID | Title | CWE | Asset | Attacker | Entry | Location | Exploit | Existing protection | Why insufficient | Remediation | Verify |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **P1-1 R-AI-1** | No hard prod block on OpenAI provider (RU data egress) | CWE-201 | invoice/expense docs+PII | Insider/misconfig operator | `AI_PROVIDER` env | `openai-client.ts:47-63` | Set `AI_PROVIDER=openai` in prod → documents+OCR sent to api.openai.com | one-time `console.warn` | Warning ≠ control; expense AI *requires* OpenAI today | Hard-fail/force-mock OpenAI in prod behind an explicit documented override | Attempt prod boot with `AI_PROVIDER=openai` → must refuse |
| **P1-2 R-DB-1** | App runs as DB superuser/owner | CWE-250/269 | entire DB | any app-compromise / SQLi / RCE | app→DB | `deploy/.env.production.example:22-24` | Full DDL/DELETE/TRUNCATE inherited | Postgres unpublished, internal net | Over-privilege turns any bug into total loss | Least-privilege DML app role (no DDL/DELETE on ledgers) + separate migration role | Confirm app role lacks DROP/DELETE grants |
| **P1-3 R-DB-2** | Company/Club delete cascades wipe all financial history | CWE-1250/212 | all financial rows | direct DB / bad migration / owner-at-console | DB | `schema.prisma:461,735,988,…` | `DELETE FROM "Company"` erases invoices/ledgers irreversibly | no app delete path; audit decoupled | cascade + superuser + no tested backup = unrecoverable | Restrict cascade on financial children (RESTRICT) or block at role; tested backups | Attempt cascade in a scratch DB; confirm restriction |
| **P1-4 R-BAK-1** | No scheduled/tested/offsite/encrypted backups | CWE-404/311 | full DB + files | host loss / ransomware / corruption | ops | `deploy/deploy.sh:194-207`; `BACKUP_RESTORE_RUNBOOK.md:9` | No recovery between deploys; dumps same-host, unencrypted | pre-deploy pg_dump (7, local) | Deploy-gated RPO; restore never validated | Scheduled encrypted offsite backups + WAL/PITR; test restore | Perform + validate a restore drill |

*Note:* P1-1 requires an operator misconfiguration (not remotely exploitable); P1-2/3/4 require DB-level access or a catastrophic event — none are remotely exploitable by an app user, but all are severe for a production multi-tenant financial system per the task's P1 taxonomy ("backup safety", "serious config error").

### P2 — Medium/High
| ID | Title | CWE | Location | Note |
|---|---|---|---|---|
| P2-1 R-TEN-1 | Global `ExpenseCategory` (no companyId) → cross-tenant availability/integrity + name leak | 639/284 | `schema.prisma:906`; `expenses/category-actions.ts:31-85` | chief_accountant of A affects all tenants; add companyId + scope |
| P2-2 R-RBAC-1 | Regional self-confirms own "Директор→Клуб" cash transfer (SoD) | 863 | `cash-actions.ts:204` + `access.ts:49` | check raw role / exclude creator |
| P2-3 R-RBAC-2 | Regional approves own invoice (SoD relaxation) | 863 | `invoices.ts:195-207` | confirm intent or add isCreator gate |
| P2-4 R-SEC-1 | SESSION_SECRET/OTP_SECRET lack ≥32 length enforcement | 521 | `tokens.ts:8-15`; `otp.ts:14-21` | enforce length as OFD/RECOVERY do |
| P2-5 R-RATE-1 | No login/password rate-limit or lockout | 307 | `auth.ts:350-360` | password brute + bcrypt DoS + OTP-spam (OTP blocks takeover) |
| P2-6 R-RATE-2 | No registration rate-limit/CAPTCHA | 799 | `auth-actions.ts:49-97` | mass account + email amplification |
| P2-7 R-RATE-3 | No cost throttle on AI-analyze / OFD sync-now | 770 | `ai/*-analyzer`, `ofd/daily.ts:170` | external-API cost abuse |
| P2-8 R-DEP-1 | xlsx 0.18.5 (prototype pollution + ReDoS) on authenticated uploads | 1321/1333 | `excel-import.ts:42-49` | no npm fix; move to CDN 0.20.x / exceljs |
| P2-9 R-HDR-1 | CSP `script-src 'unsafe-inline'`; no Permissions-Policy; X-Powered-By | 1021/79/200 | `next.config.mjs:19,33-46` | nonce-based CSP; add Permissions-Policy; poweredByHeader:false |
| P2-10 R-CFG-1 | Alt compose publishes 3000 on all interfaces + boot auto-migrate | 668 | `docker-compose.production.yml:50-51` | bind 127.0.0.1 / drop; keep one-shot migrate |
| P2-11 R-TEST-1 | Security-test false confidence (mirror + string-grep) | 1006/655 | `pilot-*.mjs` | test real modules/routes; add missing categories |

*(P2 count = 11 distinct, incl. R-TEST-1 test-quality process risk.)*

### P3 — Low
R-API-1/R-TG-1 non-constant-time secret compares (208); R-API-2 health commit-SHA info-disclosure (200); R-AUTH-2 registration enumeration (204); R-AUTH-3 weak password policy (521); R-AUTH-5 login timing enumeration (208); R-SEC-3 dev fallback secrets (798); R-FILE-1 sales-report no magic-byte (434); R-FILE-2 orphan files on cancel/delete (459); R-INJ-1 CSV formula injection latent (1236); R-AI-2 client-supplied rawExtractedJson persisted (602); R-AI-3 AI cost abuse (770 — also P2 theme); R-OFD-1 raw itemName latent CSV (1236); R-LOG-1 dev OTP console (532); R-DEP-2 nodemailer HIGH low-in-context (93); R-CFG-2 no container runtime hardening (250); R-CFG-3 CI static SA key (798); R-DB-4 Refund.legalEntityId no FK (1025); R-DB-5 DB TLS disabled/internal-only (319); R-BIZ-1 no amount upper-bound (20); R-BIZ-3 legacy null-fingerprint skip (345, theoretical). *(≈18 distinct low.)*

**Informational:** `superadmin` global role dormant (bypasses isolation only if ever set) — add a startup assertion that no user holds `role="superadmin"`.

---

## 25. Security scores (0–10)

| Dimension | Score | Basis |
|---|---|---|
| Tenant isolation | 8 | Uniform `getXForContext`; validated scope; only the global ExpenseCategory gap |
| Authentication | 8 | Mandatory OTP, CSPRNG, HMAC storage; minus login rate-limit & policy |
| Session security | 8 | httpOnly/secure, per-request re-scope, revocation on all security events; 30-day TTL, no device binding |
| Authorization/RBAC | 8 | Clean matrix, escalation blocked; two SoD gaps |
| IDOR resistance | 9 | No IDOR found; ownership before every mutation |
| File security | 8 | Magic bytes, scoped download, ext-allowlist; sales-report gap + orphans |
| Secret management | 7 | Env-only, AEAD, fail-closed; missing length checks + non-const compares |
| API security | 8 | Secret-gated routes, 404 exports; no rate limit, timing compares |
| Input validation | 8 | No SQLi/SSRF/XSS; strong Prisma+MIME validation; latent CSV |
| Financial-action integrity | 9 | Fingerprint/review/CAS defenses verified holding; SoD residuals |
| Auditability | 7 | Broad, masked; no IP/UA/before-after, no DB immutability, non-atomic |
| AI security | 6 | Strong injection defense/sanitization; **no prod OpenAI block** (residency) |
| OFD security | 8 | AEAD creds, scoped, no leakage; latent raw itemName |
| Telegram security | 8 | Least-data, webhook secret, single-use links; timing compare |
| Database security | 4 | App=superuser, cascade wipe, no RLS, TLS off (internal-only) |
| Backup readiness | 3 | Pre-deploy dumps only; no schedule/offsite/encryption/tested restore |
| Dependency hygiene | 5 | 2 HIGH (xlsx reachable), no CI audit |
| Production hardening | 6 | Non-root + Caddy-only good; missing runtime hardening + alt-compose |
| Incident response readiness | 3 | No tested restore, no IR runbook beyond an unverified backup doc, no alerting in repo |
| **Overall security maturity** | **6.5** | Production-grade app layer; operational/infra + data-residency are the gaps |

---

## 26. Unknowns / questions for infra & product owner

**Infra (cannot confirm from repo):** host firewall & SSH model; whether prod uses the hardened `deploy/docker-compose.prod.yml` vs the port-publishing `docker-compose.production.yml`; S3 bucket public-access-block/policy/SSE; backup schedule/offsite/encryption/PITR and whether a restore has ever succeeded; managed vs self-hosted Postgres (auto-backups/patching); log destination/retention/access; bcrypt cost in a live env; edge (Caddy) rate limiting; contents of `*.example` env files (placeholder-only?).

**Product decisions:** (1) Is a regional director meant to approve their own invoice and confirm their own director→club transfer (R-RBAC-1/2)? (2) Is `ExpenseCategory` intended to be a shared platform taxonomy or per-tenant (R-TEN-1)? (3) Is OpenAI ever permitted in RU production, or should it be hard-blocked (R-AI-1)? (4) Should non-owners be able to spawn new companies?

---

## 27. Remediation roadmap (no changes made)

**0. Emergency (do now):** none (no P0). Immediately decide R-AI-1 posture — if OpenAI must never run in RU prod, treat the hard-block as emergency-adjacent.

**1. Before production (P1):**
- Hard-block OpenAI provider in production (or force-mock) with an explicit override (R-AI-1). *(quick win, code)*
- Provision a least-privilege app DB role; keep a separate migration role (R-DB-1). *(infra)*
- Stand up scheduled, encrypted, offsite backups + WAL/PITR and run a **tested restore** (R-BAK-1). *(infra/ops)*
- Restrict `onDelete: Cascade` on financial children to `Restrict` or block Company/Club delete at the DB role (R-DB-2). *(architecture/schema — non-destructive additive change)*

**2. Before onboarding external companies (P2 cross-tenant):**
- Scope `ExpenseCategory` per company (add `companyId` + `@@unique([companyId,key])`) (R-TEN-1).
- Close the two SoD gaps (R-RBAC-1/2) after product confirmation.
- Add rate limiting (per-IP + per-account) on login/registration/OTP-send + cost quotas on AI/OFD (R-RATE-1/2/3). *(architecture)*
- Enforce `SESSION_SECRET`/`OTP_SECRET` ≥32 (R-SEC-1). *(quick win)*
- Nonce-based CSP + Permissions-Policy + `poweredByHeader:false` (R-HDR-1). *(quick win)*
- Migrate off `xlsx` 0.18.5 (R-DEP-1).

**3. Before bank API:** amount upper-bounds/step-up approval (R-BIZ-1); constant-time secret compares (R-API-1); DB TLS `require`; audit before/after + IP/UA + tamper-evidence.

**4. Before Telegram relay:** implement the relay minimal-requirements in §16 (mutual auth, request signing + replay protection, least data, no DB access, IP allowlist, rotation).

**5. Scaling hardening:** container runtime hardening (read_only/cap_drop/no-new-privileges/limits, R-CFG-2); reconcile the two compose files (R-CFG-1); short-lived CI creds/OIDC (R-CFG-3); Dependabot + `npm audit` in CI.

**6. Long-term / operational policies:** replace mirror+string-grep pilots with tests against real modules/routes + missing security categories (R-TEST-1); incident-response runbook + alerting; log retention/PII policy; secret rotation schedule; startup assertion against `superadmin`.

**Quick wins:** R-AI-1 block, R-SEC-1 length check, R-HDR-1 headers, R-API-1 timing-safe compare, R-CFG-1 port bind. **Architecture:** ExpenseCategory scoping, DB least-privilege, rate-limiting layer, cascade restriction. **Infrastructure:** backups/PITR/offsite, container hardening, CI creds. **Product:** SoD rules, OpenAI policy, category ownership.

---

*End of report. Only this file was created; code, schema, migrations, dependencies, env and database were not modified. No commit/push/merge/deploy was performed. No real secret value is disclosed herein.*
