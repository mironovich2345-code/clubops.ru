# CLUB-OPS — Integration & Machine-Endpoint Security (AI, OFD, cron, SSRF, rate limiting)

Read-only at `eb8a8f6`. Covers AI, OFD/integrations, cron/webhook endpoints, SSRF, and rate limiting.

## AI — contract holds (AI cannot authorize/pay)
Analyzers run at upload and only **prefill the client form**; every DB write of amount/counterparty/
status/tenant comes from human-submitted `parsed.data`, never the extraction. The pay gate
(`invoicePaymentBlockedReason` + `approvedDataFingerprint`) is enforced server-side at pay. Prompt
injection defended: document text wrapped as untrusted with an ignore-instructions rule; output only
`JSON.parse`d + validated (no eval/dynamic dispatch); `pdftoppm` spawned with fixed argv + stdin. No
cross-company context in prompts; `YANDEX_DATA_LOGGING_ENABLED` off by default; no PII/base64/response
bodies logged; per-upload calls bounded (1 primary + ≤1 fallback).
- **SEC-007 (S2):** client-supplied `confidence` is trusted, not re-derived server-side — a crafted
  `confidence:"high"` skips the low-confidence **review nudge**. Defeats a safety nudge, **not** the
  human approve→fingerprint→pay chain. Fix = derive/clamp confidence from the stored extraction.

## OFD / integrations
- **Cross-tenant OFD import: SAFE** — mappings scoped to `connection.companyId`; a physical FN maps to one company system-wide (`activeMappingKey @unique`). Receipts booked under their own mapping's club/legalEntity.
- **Credential storage: AES-256-GCM AEAD**, random 12-byte IV, prod-required key, never logged (`ofd/crypto.ts`).
- **SEC-004 (S2, SSRF via Taxcom `serverBaseUrl`):** the Taxcom client builds its URL from
  `cfg.serverBaseUrl`, a **user-supplied** OFD-settings value validated only as `^https://` (no host
  allowlist, unlike Saby's `assertSabyHost`). An OFD admin (owner/GD + settings PIN) can point it at
  `https://169.254.169.254/…` or internal HTTPS services; on connect/import the server issues an
  authenticated request there **and would send the connection's login/token** → internal reachability +
  credential exfil. `https://`-only blocks `file://` and plain-http metadata; internal HTTPS + HTTPS
  metadata remain. Fix = host allowlist (`*.taxcom.ru`) at save + before fetch; same for Astral's override.
- All other outbound fetches use **hardcoded provider URLs**; the AI pipeline processes uploaded **bytes**, never a user-supplied document URL — no other SSRF.
- **C-low:** OFD amount fields have no range/sanity cap (a compromised upstream could inject amounts — inherent trust boundary); dedupe existence query not company-scoped (KKT-transfer under-import edge only).

## Cron / webhook endpoints — strong
All three use **constant-time** secret compare (`timingSafeEqual`), fail-closed, POST-only, `no-store`:
| Endpoint | Auth | Idempotency | Verdict |
|---|---|---|---|
| `POST /api/cron/ofd/daily` | `CRON_SECRET` (503 if unset / 401 wrong) | `dedupeKey @unique` + per-connection lock | PASS |
| `POST /api/internal/notifications/drain` | `NOTIFICATION_DRAIN_SECRET` | CAS claim prevents double-send | PASS |
| `POST /api/telegram/webhook` | `TELEGRAM_WEBHOOK_SECRET` (403) | link-code single-use CAS; **no `update_id` dedupe** (P3, bounded) | PASS |
| `GET /api/health` | public by design | names/booleans only, no secrets | PASS |
- **SEC-011 (S3):** collections `syncIpCashAction`/`syncOooCashAction` check only `selectedCompanyId`, **not** the `ofd.sync.trigger` capability that gates the dashboard trigger → any collections-page role can trigger a company OFD sync (bounded: own-company, idempotent, per-connection lock).

## Rate limiting & abuse — good design, three gaps
DB-backed fixed-window limiter (HMAC-keyed, multi-instance safe). Covered: login (IP+email), registration,
OTP, invite, PIN, Telegram link, OFD sync-now, invoice+expense AI upload.
- **SEC-002 (S2, P1):** `getClientIp` trusts `X-Forwarded-For` index 0 with no trusted-proxy validation → a client-supplied XFF mints unlimited fresh IP buckets, defeating `login:ip`/`register:ip` (mass-registration, OTP amplification, credential-stuffing breadth). Single-account brute force still bounded by `login:email` + OTP lock. **Verify Caddy replaces inbound XFF.**
- **SEC-003 (S2, P1):** `uploadAndAnalyzeRefund` has **no** `isRateLimited` (unlike invoice/expense) → AI-cost + storage abuse by one authenticated user (looks like a missed call site). Payroll AI upload also uncapped (P2, mitigated by prod PII block).
- **SEC-008 (S2, P2):** the limiter **fails open** on a DB error → limits vanish exactly under DoS load.
- File-download routes RBAC-checked but uncapped (read-amplification, P3); exports hard-404.

## Security headers & cookies — well-hardened
Nonce-based CSP (`script-src 'self' 'nonce-…'`, **no prod `unsafe-inline`/`unsafe-eval`**; `unsafe-eval`
dev-only; `unsafe-inline` styles-only). **Context-aware framing:** doc-viewer routes `frame-ancestors
'self'`+`SAMEORIGIN`; every other route `'none'`+`DENY` (same-origin PDF viewer works, cross-origin
blocked). `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` all-disabled,
`X-Powered-By` off. **HSTS at Caddy** `max-age=31536000; includeSubDomains`. Session cookie
`httpOnly+Secure(prod)+SameSite=lax`, HMAC of a 256-bit token. Low hardening only: HSTS no `preload`, no
explicit global `no-store` on authed HTML, residual `style-src 'unsafe-inline'` (can't run script).
