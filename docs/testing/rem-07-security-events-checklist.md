# REM-07 — Security Events Live Acceptance Checklist

Automated proof done (`test:rem-07-security-events` 19/19; `pilot:rem-07-security-events`). Live gates:

- [ ] **G-SECLOG-1** A wrong-role action creates a `authz.denied_*` event (actor/reason/requestId), no mutation.
- [ ] **G-SECLOG-2** A synthetic cross-company access attempt creates a `high` event; no data changed.
- [ ] **G-SECLOG-3** The `requestId` in the user's safe message resolves via `trace:request`.
- [ ] **G-SECLOG-4** No event contains a password/2FA/session token/signed URL/plain email/filename/bytes.
- [ ] **G-SECLOG-5** With the SecurityEvent write failing, the action is STILL denied (fallback stderr only).
- [ ] **G-SECLOG-6** Repeated denials by one actor cross the alert threshold (monitoring).
- [ ] **G-SECLOG-7** Owner A cannot read Company B's security events (tenant-scoped query).
- [ ] **G-SECLOG-8** Failed-login enumeration stays protected (same external response; internal reasonCode differs).
- [ ] **G-SECLOG-9** Production diagnosis by `requestId` works (`trace:request` on a replica).
- [ ] **G-SECLOG-10** Caddy/Railway strip/ignore an inbound `X-Request-Id`; the app mints its own.

**Sign-off:** OPS-006 + SEC-009 CLOSED on the infrastructure + central page/cron integration + tests +
`logSecurityDenial` adoption at the high-risk denial branches (G-SECLOG-1/2). ARCH-005 stays NOT CLOSED
(observability only — DB tenant backstop is a separate remediation). SEC-002/008 stay NOT CLOSED
(events only prepare evidence).
