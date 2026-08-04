// Pilot — REM-07 denied-authz logging + request correlation (§34). Fast STRUCTURAL
// checks that the model, requestId, logger, redaction, central integration, CLIs and
// docs are in place. BEHAVIORAL proof = test:rem-07-security-events (19/19 real rows +
// failure injection). Runs in pilot:full.
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => { try { return readFileSync(new URL(p, import.meta.url), "utf8"); } catch { return ""; } };

const schema = src("../prisma/schema.prisma");
const prodSchema = src("../prisma/production/schema.prisma");
const middleware = src("../src/middleware.ts");
const eventTypes = src("../src/lib/security/event-types.ts");
const redaction = src("../src/lib/security/redaction.ts");
const reqCtx = src("../src/lib/security/request-context.ts");
const logger = src("../src/lib/security/security-event.ts");
const access = src("../src/lib/access.ts");
const cron = src("../src/app/api/cron/ofd/daily/route.ts");
const cli = src("../scripts/audit-security-events.mjs");
const trace = src("../scripts/trace-request.mjs");
const tests = src("../scripts/rem-07-security-events-tests.mjs");
const pkg = src("../package.json");
const report = src("../docs/remediation/rem-07-final-report.md");
const contract = src("../docs/remediation/rem-07-security-event-contract.md");
const reqDesign = src("../docs/remediation/rem-07-request-context-design.md");
const integ = src("../docs/remediation/rem-07-denied-authz-integration.md");
const checklist = src("../docs/testing/rem-07-security-events-checklist.md");
const runbook = src("../docs/operations/security-event-runbook.md");
const traceRunbook = src("../docs/operations/request-tracing-runbook.md");
const alerts = src("../docs/operations/security-event-alerts.md");
const spec = src("../docs/security/security-events-spec.md");

// 1/2. request id generated + on response.
check("1 requestId server-minted (crypto UUID)", middleware.includes("crypto.randomUUID()") && middleware.includes('"x-request-id"'));
check("2 requestId on response header", middleware.includes('response.headers.set("x-request-id"'));
// 3. spoofed id not trusted.
check("3 inbound client requestId not trusted (overwritten)", /never trust|NEVER trust|overwrites it/i.test(middleware) && reqCtx.includes("never trusted"));
// 4. shared request context.
check("4 shared request context", reqCtx.includes("buildSecurityContext") && reqCtx.includes("getRequestId"));
// 5. single security-event logger.
check("5 single security-event logger", logger.includes("export async function recordSecurityEvent"));
// 6/7. auth + authz denials integrated centrally.
check("6/7 auth + authz denials logged in requirePageAccess", access.includes("auth.session_invalid") && access.includes("authz.denied_page_access") && access.includes("logSecurityDenial"));
// 8/9/10. tenant/club/legal-entity denial catalog present.
check("8/9/10 tenant/club/LE denial catalog", eventTypes.includes("authz.denied_company_scope") && eventTypes.includes("authz.denied_club_scope") && eventTypes.includes("authz.denied_legal_entity_scope"));
// 11. financial denials in catalog.
check("11 financial denial catalog", eventTypes.includes("finance.idempotency_conflict") && eventTypes.includes("finance.overpayment_blocked") && eventTypes.includes("finance.replay_returned_existing"));
// 12. file denials.
check("12 file denial catalog", eventTypes.includes("file.download_denied") && eventTypes.includes("file.cross_tenant_key_detected"));
// 13. cron denial wired.
check("13 cron denial logged (never the secret)", cron.includes("integration.cron_denied") && !/metadata:\s*\{[^}]*(secret|cronSecret|authorization)/i.test(cron));
// 14. replay distinguished.
check("14 replay distinguished from conflict", eventTypes.includes("finance.replay_returned_existing") && contract.includes("replay"));
// 15. conflict logged (high).
check("15 idempotency conflict high severity", eventTypes.includes("finance.idempotency_conflict") && /idempotency_conflict[\s\S]*high/.test(eventTypes));
// 16. external response generic + requestId.
check("16 generic external message + requestId", logger.includes("deniedUserMessage") && logger.includes("Код обращения"));
// 17. object existence not leaked.
check("17 object-existence privacy documented", contract.includes("NEVER echoed") || contract.includes("never echoed") || integ.includes("never revealing"));
// 18/19/20. metadata allowlist + secrets/PII redacted.
check("18 metadata allowlist", redaction.includes("SAFE_METADATA_KEYS") && redaction.includes("redactMetadata"));
check("19 secrets redacted", redaction.includes("SECRET_RE") && redaction.includes("[redacted]"));
check("20 PII redacted (email/url/control)", redaction.includes("EMAIL_RE") && redaction.includes("stripControl") && redaction.includes("emailMarker"));
// 21. logger failure fail-safe.
check("21 logger failure fail-safe (never throws upward)", logger.includes("best-effort") && logger.includes("NEVER") && logger.includes("catch") && logger.includes("security_event_fallback"));
// 22. persistent high-risk events (DB model).
check("22 persistent SecurityEvent model", schema.includes("model SecurityEvent") && schema.includes("eventType") && schema.includes("requestId"));
// 23. tenant-scoped reads.
check("23 tenant-scoped event reads", cli.includes("companyId = arg") && cli.includes("READ-ONLY"));
// 24/25. trace + audit CLIs.
check("24/25 trace + security-event CLIs registered", pkg.includes("audit:security-events") && pkg.includes("trace:request") && trace.includes("requestId"));
// 26. synthetic two-tenant tests.
check("26 real two-tenant + failure-injection tests", tests.includes("recordSecurityEvent") && tests.includes("FAILURE INJECTION") && tests.includes("tenant-scoped query isolates"));
// 27/28. no RBAC / decision change.
check("27/28 access DECISION unchanged (only logging added)", access.includes("decision is unchanged") || access.includes("access DECISION unchanged") || access.includes("unchanged (still /login)"));
// 29. no production mutation (logger writes only SecurityEvent; no domain writes).
check("29 logger writes only SecurityEvent", logger.includes("db.securityEvent.create") && !/\.(expense|invoice|refund|payroll|company|user)\.(create|update|delete)/i.test(logger));
// 30/31. prisma dev/prod (SecurityEvent synced).
check("30/31 SecurityEvent in dev + prod schema", schema.includes("model SecurityEvent") && prodSchema.includes("model SecurityEvent"));
// 32. tsc marker (imports wired).
check("32 access wired to security lib", access.includes('from "@/lib/security/security-event"') && access.includes('from "@/lib/security/request-context"'));
// 33. pilot registered.
check("33 pilot registered in pilot:full", pkg.includes("pilot:rem-07-security-events") && src("../scripts/pilot-full.mjs").includes("pilot-rem-07-security-events.mjs"));
// 34. build marker (indexes).
check("34 SecurityEvent indexed for query patterns", schema.includes("@@index([eventType, createdAt])") && schema.includes("@@index([requestId])") && schema.includes("@@index([companyId, createdAt])"));
// docs + findings closure.
check("35 docs present", contract.length > 200 && reqDesign.length > 200 && integ.length > 200 && runbook.length > 200 && traceRunbook.length > 200 && alerts.includes("pager") && checklist.includes("G-SECLOG"));
check("36 findings closure honest", report.includes("OPS-006") && report.includes("SEC-009") && report.includes("ARCH-005") && report.includes("NOT CLOSED") && spec.includes("REM-07"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
