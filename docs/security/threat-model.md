# CLUB-OPS — Threat Model

Read-only threat model at `eb8a8f6`. Multi-tenant financial app; the primary trust boundary is
**Company** (then Club, then LegalEntity). Authorization is capability + page-access, re-derived from
the DB every request (no token snapshot). Verdicts reference SEC-### in `full-audit-05-security.md`.

## Actors
| Actor | Trust | Primary risk |
|---|---|---|
| Unauthenticated user | none | reach a sensitive route without auth |
| Invited-but-inactive user | none until accept | accept another's invite; act while inactive |
| Manager | own club(s), own-created | self-approve/pay; see other clubs; escalate |
| Regional director | company + assigned clubs | self-confirm receipts; cross-region; grant roles |
| Accountant / chief accountant | company accounting | approve/reverse beyond role; cross-company |
| Owner / general director | company (top) | bypass «chief-only» rules; reach company B |
| Compromised employee account | as its role | replay money ops; exfil documents |
| Former employee | should be none | stale session/access after offboarding |
| External attacker | none | brute-force, enumeration, SSRF, IDOR, XSS |
| Malicious tenant (company admin) | own company | pivot to another company's data |
| Support/dev with prod access | infra | read DB/backups/secrets; no app trail |
| Cron caller | secret-gated | trigger jobs; replay |
| Integration provider (OFD/AI) | external | inject data; exfil via SSRF; provider compromise |

## Assets
Financial records (invoices/expenses/refunds/cash/payroll), company/employee/customer data, bank
requisites, INN/tax identifiers, refund customer documents, uploaded files, sessions, credentials/secrets,
audit logs, AI-processed documents.

## Threats × current posture (summary; detail in the reviews)
| Threat | Verdict | Evidence / SEC |
|---|---|---|
| Cross-company READ | **NOT FOUND** — every reader intersects companyId + allowedClubIds; IDOR test confirms | `tenant-isolation-review.md`, `idor-results.json` |
| Cross-company WRITE | **NOT FOUND** — every id-keyed write scope-checked; 1 LOW (removeClubAssignment) | SEC-012 |
| Vertical privilege escalation (into pay/reverse) | **NOT FOUND** — reversal chief-only; self-approval blocked | `role-capability-matrix.md` |
| Horizontal escalation (club/entity/tenant) | **NOT FOUND** for money/data; storageKey binding weak | SEC-006 |
| Payment manipulation / **replay → double money** | **PRESENT** — payroll payouts lack idempotency/tx | **SEC-001** (ARCH-002/003/004, FIN-005) |
| Status bypass | NOT FOUND — CAS/status-in-where + fingerprint | STRONG |
| File disclosure (IDOR) | NOT FOUND — scoped download routes + key cross-checks | `file-security-review.md` |
| Document replacement | keys server-derived, random; but storageKey trusted on bind | SEC-006 |
| Session theft / fixation | NOT FOUND — HMAC tokens, fresh challenge, atomic revoke | `authentication-review.md` |
| Invitation abuse | NOT FOUND — single-use, email-bound, no mass-assign; archived-club LOW | SEC-014 |
| Replay / duplicate money op | **PRESENT** — payroll payouts, obligation settle | SEC-001, SEC-005 |
| Data deletion | Company hard-delete unrecoverable (DATA-008/OPS-016) | carried-in |
| Audit tampering | AuditLog append via one helper; **failed authz not logged** | **SEC-009** (OPS-006) |
| Integration credential theft / SSRF | AEAD-encrypted creds; Taxcom base URL not allowlisted | **SEC-004** |
| Rate-limit bypass / abuse | XFF-spoofable; refund AI uncapped; fail-open | SEC-002, SEC-003, SEC-008 |
| Injection (SQL/command/XSS) | NOT FOUND — parameterized, React-escaped; CSV formula latent | SEC-010 |

## Bottom line
The **tenant boundary holds** (no confirmed cross-company read/write, no escalation into money). The
real exposure is **replay/idempotency on the payroll payout family** (already flagged ARCH/FIN) and a
set of **hardening gaps** (XFF rate-limit bypass, SSRF allowlist, AI cost caps, and — for detection —
no failed-authorization logging). No S0/P0. See `full-audit-05-security.md`.
