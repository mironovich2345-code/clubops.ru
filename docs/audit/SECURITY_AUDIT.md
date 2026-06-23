# CLUB-OPS — Security Audit

Date: 2026-06-24. Verified against current code with file:line evidence.

## 1. Authentication / OTP / Session (Phase 3)

Verdict: **SECURE** (one P2 timeout gap, fixed in this task).

| # | Claim | Result | Evidence |
|---|---|---|---|
| 1 | No Session before OTP | PASS | `createSession` callers: only `login-challenge.ts:~260` (post-verify). `loginAction`/`registerAction` call `startLoginChallenge`, never `createSession`. |
| 2 | No alternate login bypass | PASS | All entries go through `verifyLoginPassword` (password only) or `requireUser` (needs Session). `acceptInvite`/`completeOnboarding` require `requireUser`. |
| 3 | Registration cannot create session pre-OTP | PASS | `auth-actions.ts registerAction` → `startLoginChallenge` → `/login/verify`. |
| 4 | Invite cannot bypass OTP | PASS | Invite is accepted in an already-OTP-authenticated session; sets `emailVerifiedAt` idempotently, no session creation. |
| 5 | OTP not plaintext | PASS | `otp.ts otpDigest` = HMAC(OTP_SECRET, challengeTokenHash:otp); schema stores `otpDigest` + `challengeTokenHash` only. |
| 6 | Tokens never logged | PASS | Only masked email / requestId / recipientDomain logged; dev-only OTP console print gated `NODE_ENV!=="production"`. |
| 7 | Constant-time compare | PASS | `otp.ts verifyOtp` uses `crypto.timingSafeEqual` with length guard. |
| 8 | Used/expired/revoked/locked not reusable; concurrent verify ≤1 session | PASS | `getCurrentChallenge` rejects consumed/revoked/expired/inactive; success path uses a conditional `updateMany(...consumedAt:null...)` so only one winner creates a session. |
| 9 | 5 wrong attempts lock the challenge only | PASS | `verifyCurrentChallenge` increments `attemptCount`; at max → revoke challenge + clear cookie. User account untouched. |
| 10 | Resend invalidates previous code | PASS | `resendCurrentChallenge` replaces `otpDigest`. |
| 11 | DB-backed rate limits | PASS | `sendsInLastHour` sums `sendCount` across challenges; cooldown via `resendAvailableAt`. Survives a new browser (per-user rows). |
| 12 | Inactive users blocked | PASS | `verifyLoginPassword` rejects `!isActive`; `startLoginChallenge` rejects inactive; `getCurrentChallenge` rejects inactive. |
| 13 | Revoked session fails next request | PASS | `getValidSession` re-reads DB every call (no cache); checks `revokedAt`, `expiresAt`, `user.isActive`. |
| 14 | Cookies hardened, host-only | PASS | Session cookie (`session.ts`) + challenge cookie (`login-challenge.ts`): httpOnly, `secure` in prod, `sameSite:lax`, path set, **no Domain** ⇒ host-only. |
| 15 | No cross-subdomain cookie auth | PASS | No `Domain=.clubops.ru` anywhere; host-only ⇒ pilot cookies do not authenticate other subdomains, Railway cookies do not authenticate pilot. |
| 16 | Email-change / 2FA-reset revoke sessions+challenges | PASS | CLIs `security-change-email.mjs` / `security-reset-2fa.mjs` revoke all sessions + active challenges in a transaction and write a system audit row. |
| 17 | SMTP failure safe | PASS (after F-002) | On send failure: no session, `deliveryFailedAt` set, sanitized message, resend possible. **F-002 added connection/greeting/socket timeouts** so an unresponsive server fails fast instead of hanging. |

## 2. Tenant / Company / Club isolation (Phase 6)

Verdict: **STRONG — no confirmed cross-Company read/write.**

- Access is **DB-derived, never cookie-derived**: `getCurrentAccessContext` resolves `allowedCompanyIds`/`allowedClubIds` from `CompanyUserAccess`/`ClubUserAccess`. Scope cookies (`scope_company`/`scope_club`) are **preferences**; an inaccessible value falls back to an accessible one (`access.ts getCurrentCompanyAndClub`).
- Single-record loads use the `getXForContext` pattern: `record.companyId === ctx.selectedCompanyId && ctx.allowedClubIds.includes(record.clubId)` (expenses/invoices/refunds/sales/budgets). No `findUnique`-by-client-id without an ownership check was found.
- Operational create/update derive `companyId` from a **server-side club lookup**, never from FormData; `clubId` is checked against `allowedClubIds` + `canAccessClub`.
- File routes call `getXForContext` **before** streaming; storage keys are random 32-hex and regex-validated (`isSafeStorageKey` `^[a-z0-9._-]+/[a-z0-9._-]+$`) ⇒ no path traversal / enumeration.
- Strategic multi-Company views are gated to owner/general_director; URL `companyId/city/clubId` are filters, not authorization; cross-Company opens re-validate record ownership before switching scope. Balances/cash-gap are never merged across Companies (analytics requires a single Company for balances).
- User-management authority is centralized in `assertCanManageUser` (owner→any; GD→non-owner/GD; regional→managers in own clubs; else deny; superadmin/unknown deny) + `isLastActiveOwner` protection.

## 3. File / document security (Phase 12)

Verdict: **STRONG.** Authorization before stream; size limits (10MB expenses/invoices, 15MB sales-reports) + allowlisted MIME (JPG/PNG/WEBP/PDF, +XLS/XLSX/CSV for reports); inline vs attachment gated by `canDownloadDocuments`; `document.viewed/downloaded` audited (deduped on Range requests); storage path/URL never sent to the browser; S3 presigning server-side only.

## 4. AI document analysis (Phase 13)

Verdict: **STRONG.** OpenAI call has `AbortSignal.timeout(60s)`; responses are strictly validated (typed value coercers, never trust raw model fields); missing amount/date → null + low confidence + `missingFields`. **AI never auto-approves/auto-pays** — status is decided by budget constraints + explicit user action, AI confidence is stored for audit only. Provider selection is fail-safe: `mock` unless `AI_PROVIDER` + the provider key(s) are explicitly set ⇒ the mock/test provider cannot silently activate; production without keys = mock (no external calls). API key never logged or sent to the browser; document payload never logged.

## 5. Web security headers & injection (Phase 18)

- `next.config.mjs` headers: CSP (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `form-action 'self'`, images `data:`/`blob:`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
- CSRF: cookie-authenticated server actions rely on `sameSite=lax` + Next App Router's built-in server-action origin handling. No custom CSRF token (correct for this stack).
- Open redirect: `safe-redirect.ts safeNextPath` only allows single-leading-slash internal paths.
- SQL injection: the only raw SQL is `db-locking.ts` `$queryRaw` template with a **bound** `${clubId}` parameter (`SELECT id FROM "Club" WHERE id = ${clubId} FOR UPDATE`), Postgres-only path.
- XSS: no `dangerouslySetInnerHTML` in the codebase; AI fields flow through React text/hidden inputs.
- User enumeration: login returns one generic `Неверный email или пароль` for all failures; invite creation does not reveal account existence.

## 6. Domain / cookie isolation (Phase 16)

`APP_URL` (`app-url.ts`) validates a real URL, strips trailing slash, requires HTTPS in production, never reads Host/forwarded headers, never falls back to Railway. Invitation links are minted from `APP_URL` server-side; production **refuses** invite creation with a sanitized Russian error when APP_URL is missing/invalid (no origin fallback). `metadataBase` is omitted safely when APP_URL is absent. Icons at `/icon`, `/apple-icon`. Cookies host-only (see §1.14–15).

## 7. Secrets / configuration (Phase 17)

Required prod vars: `DATABASE_URL`, `SESSION_SECRET`, `OTP_SECRET` (distinct from SESSION_SECRET), `APP_URL`, `SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM`; optional `AI_PROVIDER` + keys, `STORAGE_PROVIDER` + S3 vars. Fail-closed: `OTP_SECRET`/`SESSION_SECRET` throw in production when missing (used at runtime); `getAppUrl` throws in production when invalid; `OTP_TEST_TRANSPORT` test transport is disabled in production. `.env` is gitignored; examples contain placeholders only. **Each future customer deployment must use unique secrets and its own DB/storage/domain.**

## Residual security risks

- SMTP/email deliverability and real header behavior behind Railway's proxy require a live check (not testable here).
- No automated brute-force lockout on *password* attempts beyond the OTP gate (login still requires OTP). Consider a DB-backed password-attempt limiter in a later task (P3, documented, not blocking).
