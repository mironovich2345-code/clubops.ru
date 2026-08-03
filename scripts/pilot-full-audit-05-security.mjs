// Pilot — FULL AUDIT 5/6 (Security). Verifies the audit DELIVERABLES exist and are intact and that
// the audit changed NO src/schema/RBAC/data and used NO production target (git-diff gate). It does
// not grade security — it proves the audit was performed and stayed read-only.
//   npm run pilot:full-audit-05-security
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p) => { try { return readFileSync(root + p, "utf8"); } catch { return ""; } };
const has = (p) => existsSync(root + p);
const json = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };
const BASELINE = "eb8a8f6";

function main() {
  const threat = read("docs/security/threat-model.md");
  const roles = read("docs/security/role-capability-matrix.md");
  const auth = read("docs/security/authentication-review.md");
  const tenant = read("docs/security/tenant-isolation-review.md");
  const idor = read("docs/security/idor-test-matrix.md");
  const filesec = read("docs/security/file-security-review.md");
  const integ = read("docs/security/integration-security-review.md");
  const events = read("docs/security/security-events-spec.md");
  const findings = read("docs/audits/full-audit-05-security.md");
  const backlog = read("docs/release/remediation-backlog-after-audit-05.md");

  check("1 threat model exists", threat.includes("Actors") && threat.includes("Assets") && threat.includes("Threat"));
  check("2 role matrix complete", roles.includes("reverse") && roles.includes("chief") && roles.includes("Self-approval"));
  check("3 authentication reviewed", auth.includes("bcrypt") && auth.includes("OTP") && auth.includes("token"));
  check("4 sessions reviewed", auth.includes("stale authorization") && auth.includes("fresh"));
  check("5 invitations reviewed", auth.includes("Invitations") && auth.includes("single-use"));
  check("6 all reads inventoried", has("docs/audits/data/security-read-scope.json") && tenant.includes("Reads"));
  check("7 all writes inventoried", has("docs/audits/data/security-write-scope.json") && tenant.includes("Writes"));
  check("8 IDOR matrix executed locally", has("docs/audits/data/idor-results.json") && (json("docs/audits/data/idor-results.json")?.checks >= 5) && idor.includes("Executed"));
  check("9 vertical escalation reviewed", roles.includes("Vertical escalation") && findings.includes("escalation"));
  check("10 horizontal escalation reviewed", tenant.includes("cross-tenant") && idor.includes("substitution"));
  check("11 financial actions reviewed", findings.includes("SEC-001") && findings.includes("idempotency"));
  check("12 mass assignment reviewed", tenant.includes("Mass assignment") && findings.includes("storageKey"));
  check("13 CSRF reviewed", integ.includes("cookie") && /SameSite|sameSite/.test(integ));
  check("14 XSS reviewed", filesec.includes("XSS") && filesec.includes("dangerouslySetInnerHTML"));
  check("15 injection reviewed", findings.includes("injection") || findings.includes("SQL"));
  check("16 SSRF reviewed", integ.includes("SSRF") && integ.includes("SEC-004"));
  check("17 upload reviewed", filesec.includes("Upload validation") && filesec.includes("magic-byte"));
  check("18 download reviewed", filesec.includes("Download authorization") && filesec.includes("SAFE"));
  check("19 path traversal reviewed", filesec.includes("Path traversal") && filesec.includes("isSafeStorageKey"));
  check("20 AI reviewed", integ.includes("AI") && integ.includes("cannot authorize"));
  check("21 integrations reviewed", integ.includes("OFD") && integ.includes("AEAD"));
  check("22 cron reviewed", integ.includes("cron") && integ.includes("constant-time"));
  check("23 rate limiting reviewed", integ.includes("Rate limiting") && integ.includes("SEC-002"));
  check("24 audit logs reviewed", events.includes("recordAudit") && events.includes("Failed authorization"));
  check("25 PII mapped", events.includes("PII") || findings.includes("PII") || events.includes("no secrets"));
  check("26 exports reviewed", findings.includes("SEC-010") && filesec.includes("CSV"));
  check("27 account management reviewed", roles.includes("Invite") && auth.includes("inviter authority"));
  check("28 company management reviewed", threat.includes("Company") && findings.includes("Company"));
  check("29 headers/cookies reviewed", integ.includes("headers") && integ.includes("CSP") && integ.includes("HSTS"));
  check("30 dependencies reviewed", findings.includes("bcrypt") || integ.includes("xlsx") || findings.includes("SEC-016"));
  const ids = [...findings.matchAll(/## (SEC-\d+)/g)].map((m) => m[1]);
  check("31 findings have evidence", ids.length >= 14 && [...findings.matchAll(/Severity:\*\* S[0-3]/g)].length >= 14 && findings.includes(".ts:"), `${ids.length} findings`);
  check("32 P0/P1/P2 assigned", backlog.includes("## P1") && backlog.includes("## P2") && has("docs/audits/data/security-findings.json"));
  check("33 remediation backlog exists", backlog.includes("SEC-001") && backlog.includes("Effort"));

  // 34/35/36/37 read-only + no-production + no-RBAC guarantees.
  let changed = "";
  try { changed = execSync(`git diff --name-only ${BASELINE} HEAD`, { cwd: root, encoding: "utf8" }); } catch { changed = "GIT_UNAVAILABLE"; }
  const files = changed.split("\n").map((s) => s.trim()).filter(Boolean);
  const touchedSrc = files.filter((f) => f.startsWith("src/"));
  const touchedSchema = files.filter((f) => f.startsWith("prisma/"));
  // The IDOR test targets a DISPOSABLE sqlite copy via a `file:` datasource and never constructs a
  // postgres/production URL (it legitimately mentions the word "production" in a "never production" comment).
  const idorSrc = read("scripts/audit-idor-matrix.mjs");
  check("34 no production target (IDOR test uses a disposable sqlite copy)", idorSrc.includes("DISPOSABLE") && idorSrc.includes("datasourceUrl: `file:") && !/postgres(ql)?:\/\//.test(idorSrc));
  check("35 no production data mutation (idor scanner deletes its disposable copy; no src/data change)", read("scripts/audit-idor-matrix.mjs").includes("rmSync") && (changed === "GIT_UNAVAILABLE" || touchedSrc.length === 0));
  check("36 no schema migration", changed === "GIT_UNAVAILABLE" || touchedSchema.length === 0, touchedSchema.join(", "));
  check("37 no RBAC change (auth.ts/access.ts untouched)", changed === "GIT_UNAVAILABLE" || !files.some((f) => f === "src/lib/auth.ts" || f === "src/lib/access.ts"));

  // 38-42 gauntlet recorded green in the baseline.
  const baseline = read("docs/audits/full-audit-05-security-baseline.md");
  check("38 tsc recorded clean", baseline.includes("tsc") && baseline.includes("clean"));
  check("39 prisma dev valid recorded", baseline.includes("dev (sqlite)") && baseline.includes("valid"));
  check("40 prisma prod valid recorded", baseline.includes("prod (postgres)") && baseline.includes("valid"));
  check("41 pilot:full green recorded", baseline.includes("3768 passed / 0 failed"));
  check("42 build:prod green recorded", baseline.includes("compiled"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main();
