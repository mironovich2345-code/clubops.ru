# CLUB-OPS — Environment / Secrets Register

Read-only inventory at `dc14d10`. **No secret values are recorded.** Machine data:
`docs/audits/data/env-contract.json` (`npm run audit:env-contract`) — 43 env vars used, **1**
client-exposed (`NODE_ENV`, inlined, non-sensitive), **0** `NEXT_PUBLIC_*` (nothing sensitive shipped
to the client), 7 non-public undocumented in the deploy example.

## Fail-closed policy (confirmed sound)
`src/lib/env-secrets.ts:19-35` `resolveSecret()`: in production a **missing** secret **throws**
`"<NAME> is required in production"`; a present-but-too-short (<32) value throws; dev returns a labelled
`dev-insecure-*` fallback. Same pattern in `account-recovery.ts:12`, `ofd/crypto.ts:8`, `app-url.ts:35`
(throws in prod for a missing/invalid absolute URL). **No `process.env.X || "hardcoded-secret"` in
`src/` runtime code.**

## Register (names, requirement, secrecy, validation)
| Var | Prod req? | Secret? | Fallback | Validated (throws)? | Notes |
|---|---|---|---|---|---|
| `SESSION_SECRET` | yes ≥32 | secret | dev-insecure (non-prod) | **throws** | `tokens.ts` |
| `OTP_SECRET` | yes ≥32 | secret | dev-insecure | **throws** | `otp.ts` |
| `ACCOUNT_RECOVERY_SECRET` | yes ≥32 | secret | dev-insecure | **throws** | deletion/recovery only |
| `OFD_SECRET` | if OFD ≥32 | secret | dev-insecure | **throws** on save | `ofd/crypto.ts` |
| `DATABASE_URL` | yes | secret (pw) | `?? ""` | **NOT validated in app** | **OPS-013:** non-`postgres://` URL silently treated as sqlite → `FOR UPDATE` locks become no-ops (`db-locking.ts:22`) |
| `POSTGRES_PASSWORD` | yes | secret | none | compose | |
| `CRON_SECRET` | to run OFD cron | secret | none→null | fail-closed **503** | **OPS-011:** missing from `deploy/.env.production.example` (documented in root examples only) |
| `NOTIFICATION_DRAIN_SECRET` | to drain | secret | none→null | fail-closed **401** | |
| `TELEGRAM_WEBHOOK_SECRET` / `TELEGRAM_BOT_TOKEN` | if TG | secret | none→null | 403 / no-send | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | if s3 | secret | **`?? ""` (empty accepted)** | **no boot check** | **OPS-012:** mis-set `STORAGE_PROVIDER=s3` fails only at first upload |
| `SMTP_*` | prod OTP delivery | secret/config | dev console transport | no throw | absent → OTP not delivered |
| `YANDEX_AI_API_KEY`/`YANDEX_FOLDER_ID` | if AI=yandex | secret/id | none→mock | no throw | |
| `OPENAI_API_KEY` | dev/test only | secret | none | **hard-blocked in prod** | `openai-client.ts:106` |
| `APP_URL` | yes (https) | public-ish | localhost (dev only) | **throws in prod** | |
| `STORAGE_PROVIDER` / `AI_PROVIDER` / feature flags (`OFD_*`, `TELEGRAM_NOTIFICATIONS_ENABLED`, `YANDEX_DATA_LOGGING_ENABLED`) | no | public config | safe off/local/mock | no | |
| `NODE_ENV` | yes | public (inlined) | dev | no | only client-read env (`PwaBoot.tsx`) |
| Tunables/metadata (`*_MODEL/TIMEOUT`, `S3_ENDPOINT/REGION/BUCKET`, `SMTP_PORT/SECURE/FROM`, `APP_GIT_SHA/DEPLOYMENT_ID/ENVIRONMENT`, `SITE_DOMAIN`, `APP_IMAGE_REPO`, `RETENTION_DAYS`, `NEXT_PHASE`, `OTP_TEST_TRANSPORT`) | no | public/metadata | defaults | no | |

## Undocumented in `deploy/.env.production.example` (non-public)
`CRON_SECRET`, `INVOICE_AI_PRIMARY_MODEL`, `INVOICE_AI_FALLBACK_MODEL`, `INVOICE_AI_TIMEOUT_MS`,
`NEXT_PHASE`, `OFD_SABY_ENABLED`, `OTP_TEST_TRANSPORT`. Only `CRON_SECRET` is operationally significant
(OPS-011); the rest are dev/tunable.

## Findings
- **OPS-013 (S2/P1):** `DATABASE_URL` provider is inferred by regex; a malformed prod URL silently disables the DB row-locks (`lockClubRow`/`lockCompanyRow`) that guard concurrency. Validate the URL at startup.
- **OPS-012 (S2):** S3 secrets accept empty → no boot validation.
- **OPS-011 (S2):** `CRON_SECRET` absent from the deploy-target env example (ARCH-020 half-open).
- **Good:** no unsafe secret fallback in app code; no sensitive `NEXT_PUBLIC_*`; secrets fail-closed in prod; OpenAI blocked in prod. Rotation procedure: **not documented** (org gap, `production-access` §).
- **Do not record real secret values** anywhere — this register is names-only by design.
