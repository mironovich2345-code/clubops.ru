# CLUB-OPS — Authentication, Session & Invitation Review

Read-only at `eb8a8f6`. **Verdict: the strongest security area.** Model: password → mandatory email-OTP
(2FA) → DB-backed session. Authorization is re-derived from the DB every request — **no role/scope
snapshot in any cookie/JWT**. Tokens (session/challenge/invite/recovery) are 32-byte random, stored
**HMAC-only**.

## Authentication
| Item | Verdict | Evidence |
|---|---|---|
| Registration | SECURE (per-IP cap before any write) | `auth-actions.ts:82` |
| Login (2-step: password → OTP; session only after OTP) | SECURE | `login-challenge.ts:270` |
| Password hashing | bcrypt cost **10** — WEAK-ish for 2026 | `auth.ts:301` |
| Session token | 256-bit random, HMAC-SHA256 stored (`tokenHash @unique`) | `session.ts:74`, `tokens.ts:18` |
| Cookie flags | `httpOnly, sameSite=lax, secure(prod), path=/, +30d` | `session.ts:96` |
| Secret separation | SESSION/OTP/RECOVERY separate, fail-closed in prod | `env-secrets.ts:19` |
| Logout / revocation | soft-revoke DB row + clear cookie; admin revoke-all | `session.ts:192`, `users/actions.ts:587` |
| Session fixation | fresh token post-OTP; challenge cookie cleared | `login-challenge.ts:286` |
| Brute-force | DB limiter login:ip 30/15m, login:email 10/15m, OTP 5-attempt lock | `rate-limit.ts`, `login-challenge.ts:216` |
| Timing-safe compares | OTP + recovery via `timingSafeEqual`; tokens by indexed HMAC | `otp.ts:43`, `account-recovery.ts:82` |
| Inactive/archived login | rejected at password, OTP, and session-validity gates | `auth.ts:383`, `session.ts:115` |

**Weaknesses (WEAK/low-GAP, no P0/P1 auth vuln):** bcrypt cost 10 (SEC-013-adj); rate limiter **fails
open** on DB error (SEC-008); login **timing side-channel** — bcrypt skipped on user-miss (SEC-013);
**registration email enumeration** ("уже существует", SEC-013); **XFF-spoofable** per-IP limits if the
proxy doesn't strip inbound `X-Forwarded-For` (SEC-002).

## Session security (stale authorization) — SECURE, the strongest area
`getCurrentAccessContext` → `effectiveRolesInCompany` queries `CompanyUserAccess`+`ClubUserAccess` **live
every request** (`access.ts:293-306,313`); the global `User.role` never grants app permissions. Verified:
disabled/deleted user → session invalid immediately (sessions revoked in the same tx as the access
change); club/company access removal → sessions revoked atomically; role downgrade → next request
re-derives (no stale window); password/email change → other sessions revoked; restore → forces fresh
password+OTP. Multi-account container verifies every stored account belongs to the caller and passes the
same validity gate; scope cookies cleared on switch. **No stale-authorization window.**
- Defense-in-depth note: the session gate checks `isActive` only, not `deletedAt` — safe **because**
  every deletion path also sets `isActive:false`; add `!deletedAt` for robustness.

## Invitations — SECURE
256-bit token, HMAC-stored (`tokenHash @unique`); 7-day TTL; single-use via a transactional
compare-and-set (`invite-service.ts:44-99`); **recipient-email bound** (NFKC compare — cannot accept
another's invite); role/club/company come **from the persisted Invite row, never the request** (no
mass-assignment); inviter authority enforced (`getInvitableRoles`); owner of A cannot invite into B.
- **GAP (low, SEC-014):** `createInvite` club lookup lacks `isActive` → a manager invite can reference
  an **archived** club → a dangling (but inert/hidden) `ClubUserAccess`. `role-actions.ts` does filter
  `isActive` — inconsistent.

## Overall
No P0/P1 authentication, session, or invitation vulnerability. All items are WEAK/low-GAP hardening
(bcrypt cost, rate-limit fail-open/XFF, enumeration/timing, archived-club invite). The
fresh-per-request authorization derivation is a notable strength.

## Update (REM-07)
REM-07: authentication denials (session invalid/expired, inactive user, 2FA/invitation failures, login
rate-limit) have an allow-listed `SecurityEvent` catalog; enumeration protection is preserved (same safe
external response; internal reasonCode differs; only an `emailMarker` is stored, never the address).
