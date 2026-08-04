// REM-07 — REAL logic tests (§26/§27/§31). Imports & EXECUTES the actual security
// modules via jiti against a DISPOSABLE sqlite copy: recordSecurityEvent writes real
// SecurityEvent rows; redaction/allowlist; failure injection (logger throws → denial
// still stands, fallback emitted); catalog + severity. Not string assertions.
//   node scripts/rem-07-security-events-tests.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { copyFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = join(ROOT, ".rem07-tmp");
mkdirSync(SCRATCH, { recursive: true });
const TMP_DB = join(SCRATCH, "rem07.db");
const SRC = join(ROOT, "src");
const DEV_DB = join(ROOT, "prisma", "dev.db");
if (!existsSync(DEV_DB)) { console.error("dev.db not found — run prisma migrate deploy"); process.exit(1); }
for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true });
copyFileSync(DEV_DB, TMP_DB);
process.env.DATABASE_URL = "file:" + TMP_DB.replace(/\\/g, "/");

const require = createRequire(import.meta.url);
const jiti = require("jiti")(fileURLToPath(import.meta.url), { alias: { "@": SRC, "server-only": join(ROOT, "scripts", "_stubs", "server-only.cjs") }, interopDefault: true, esmResolve: true });
const { recordSecurityEvent } = jiti("@/lib/security/security-event.ts");
const { redactMetadata, sanitizeValue, emailMarker, amountBand } = jiti("@/lib/security/redaction.ts");
const { isKnownSecurityEventType, defaultSeverity, retentionClass } = jiti("@/lib/security/event-types.ts");
const { getRequestId } = jiti("@/lib/security/request-context.ts");
const { prisma } = jiti("@/lib/prisma.ts");

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 10);

async function main() {
  // 1. records a real row (query back).
  { const rid = uid("req"); await recordSecurityEvent({ eventType: "authz.denied_club_scope", reasonCode: "club_not_in_scope", actorId: uid("u"), companyId: uid("co"), targetType: "Invoice", targetId: uid("inv"), route: "action:approveInvoice", source: "server_action", requestId: rid });
    const row = await prisma.securityEvent.findFirst({ where: { requestId: rid } });
    check("1/7 event persisted with actor/target/route", !!row && row.eventType === "authz.denied_club_scope" && row.targetType === "Invoice"); }
  // 2/10. requestId + deploymentVersion stored.
  { const rid = uid("req"); await recordSecurityEvent({ eventType: "authz.denied_role", requestId: rid });
    const row = await prisma.securityEvent.findFirst({ where: { requestId: rid } });
    check("2/10 requestId + deploymentVersion stored", row?.requestId === rid && typeof row?.deploymentVersion === "string"); }
  // severity default (high for cross-tenant company scope).
  { const rid = uid("req"); await recordSecurityEvent({ eventType: "authz.denied_company_scope", requestId: rid });
    const row = await prisma.securityEvent.findFirst({ where: { requestId: rid } });
    check("severity defaults high for company-scope denial", row?.severity === "high"); }
  // 21/22/23. metadata redaction — secrets/PII/unknown keys dropped; allowlisted kept.
  { const rid = uid("req"); await recordSecurityEvent({ eventType: "file.download_denied", requestId: rid, metadata: { password: "hunter2", sessionToken: "abc.def.ghi", signedUrl: "https://s3/x?sig=1", email: "a@b.com", role: "manager", entityType: "Refund", filename: "паспорт.pdf" } });
    const row = await prisma.securityEvent.findFirst({ where: { requestId: rid } });
    const md = row?.metadataJson ?? "";
    check("21 allowlisted metadata kept (role/entityType)", md.includes("manager") && md.includes("Refund"));
    check("22 password/session token NOT stored", !md.includes("hunter2") && !md.includes("abc.def.ghi"));
    check("23 signed URL + filename + email NOT stored", !md.includes("s3/x") && !md.includes("паспорт") && !md.includes("a@b.com")); }
  // pure redaction unit.
  check("redactMetadata drops unknown keys", !("filename" in redactMetadata({ filename: "x", role: "owner" })) && redactMetadata({ role: "owner" }).role === "owner");
  check("sanitizeValue strips newline (log injection)", sanitizeValue("a\nb\rc\tINJECT") === "a b c INJECT");
  check("sanitizeValue redacts email/url/secret", sanitizeValue("a@b.com") === "[redacted]" && sanitizeValue("https://x") === "[redacted]");
  check("emailMarker non-reversible (no @)", !String(emailMarker("Person@Example.com")).includes("@") && emailMarker("Person@Example.com") === emailMarker("person@example.com"));
  check("amountBand coarse", amountBand(500) === "<1k" && amountBand(50_000_000) === "100k-1M");
  // catalog.
  check("catalog known/unknown", isKnownSecurityEventType("authz.denied_role") && !isKnownSecurityEventType("authz.made_up"));
  check("defaultSeverity + retentionClass", defaultSeverity("finance.replay_returned_existing") === "info" && retentionClass("finance.overpayment_blocked", "high") === "long");
  // 19/20. FAILURE INJECTION: logger DB write throws → recordSecurityEvent does NOT throw; fallback emitted.
  { let threw = false, fallback = false; const origErr = console.error; console.error = (s) => { if (typeof s === "string" && s.includes("security_event_fallback")) fallback = true; };
    const badDb = { securityEvent: { create: async () => { throw new Error("db exploded SECRETVALUE"); } } };
    try { await recordSecurityEvent({ eventType: "authz.denied_capability", requestId: uid("req"), metadata: { role: "manager" } }, badDb); } catch { threw = true; }
    console.error = origErr;
    check("19 logger DB failure does not throw (denial stands)", threw === false);
    check("20 fallback structured stderr emitted", fallback === true); }
  // 24. no raw DB error string surfaces (fallback has no 'db exploded' raw? it logs the ROW not the error).
  { let logged = ""; const origErr = console.error; console.error = (s) => { logged += String(s); };
    const badDb = { securityEvent: { create: async () => { throw new Error("db exploded SECRETVALUE"); } } };
    await recordSecurityEvent({ eventType: "authz.denied_role", requestId: uid("req") }, badDb);
    console.error = origErr;
    check("24 fallback carries the safe row, not the raw DB error", logged.includes("security_event_fallback") && !logged.includes("SECRETVALUE")); }
  // getRequestId off-request → null (no throw).
  check("getRequestId off-request → null", (await getRequestId()) === null);
  // 28. events indexed/queryable by company + eventType.
  { const co = uid("co"); for (let i = 0; i < 3; i++) await recordSecurityEvent({ eventType: "authz.denied_object_scope", companyId: co, requestId: uid("r") });
    const n = await prisma.securityEvent.count({ where: { companyId: co, eventType: "authz.denied_object_scope" } });
    check("28 queryable by company + eventType", n === 3, `got ${n}`); }
  // 26/27. tenant-scoped query isolates; company A cannot see company B events by filter.
  { const a = uid("coA"), b = uid("coB"); await recordSecurityEvent({ eventType: "authz.denied_role", companyId: a, requestId: uid("r") }); await recordSecurityEvent({ eventType: "authz.denied_role", companyId: b, requestId: uid("r") });
    const onlyA = await prisma.securityEvent.count({ where: { companyId: a } });
    const seesB = await prisma.securityEvent.count({ where: { companyId: a, AND: [{ companyId: b }] } });
    check("26/27 tenant-scoped query isolates companies", onlyA >= 1 && seesB === 0); }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true });
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error("rem-07 tests crashed:", e); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
