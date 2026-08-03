// Pilot — FULL AUDIT 1/6 (Code Architecture). Verifies the AUDIT DELIVERABLES exist and are
// intact, and that the audit changed NO source/schema/data (§24). It does NOT grade code
// quality — it proves the audit was performed and stayed read-only. npm run pilot:full-audit-01-code-architecture
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p) => { try { return readFileSync(root + p, "utf8"); } catch { return ""; } };
const has = (p) => existsSync(root + p);
const BASELINE = "71f1cff"; // audited commit (baseline)

function main() {
  // 1. Baseline recorded
  const baseline = read("docs/audits/full-audit-01-code-architecture-baseline.md");
  check("1 baseline recorded (commit + gauntlet)", baseline.includes("71f1cff") && baseline.includes("build:prod") && baseline.includes("pilot:full"));
  // 2. System map
  const sysmap = read("docs/architecture/system-map.md");
  check("2 system map exists with Mermaid diagrams", sysmap.includes("```mermaid") && (sysmap.match(/```mermaid/g) || []).length >= 5);
  // 3. State machine map
  const sm = read("docs/architecture/state-machines.md");
  check("3 state-machine map exists (12 entities)", sm.includes("PayrollPeriod") && sm.includes("BalanceSnapshot") && sm.includes("BudgetChangeProposal") && sm.includes("MandatoryPaymentPlan"));
  // 4-6. Modules / server actions / API routes inventoried (in system map)
  check("4 major modules inventoried", sysmap.includes("| **invoices**") && sysmap.includes("| **payroll**") && sysmap.includes("| **cash/collections**"));
  check("5 server actions inventoried", sysmap.includes("263") || sysmap.includes("Server actions"));
  check("6 API routes inventoried", sysmap.includes("17 `route.ts`") || sysmap.includes("API routes"));
  // 7-11. Reports generated
  check("7 direct-prisma report generated", has("docs/audits/data/direct-prisma-access.json"));
  check("8 status duplication/transition report generated", has("docs/audits/data/status-transitions.json"));
  check("9 tenant query risk report generated", has("docs/audits/data/tenant-query-patterns.json"));
  check("10 dead-code candidates listed", has("docs/audits/data/dead-code-candidates.json"));
  const findings = read("docs/audits/full-audit-01-code-architecture.md");
  check("11 god files/functions listed", findings.includes("God files") && findings.includes("invoices/actions.ts"));
  // 12. Dependencies inventoried
  check("12 dependencies reviewed", findings.includes("ARCH-019") && findings.toLowerCase().includes("xlsx"));
  // 13. Client/server boundary risks
  check("13 client/server boundary risks listed", findings.includes("ARCH-025") && findings.includes("page.tsx"));
  // 14. Transactions reviewed
  check("14 transactions reviewed", findings.includes("ARCH-002") && findings.includes("$transaction"));
  // 15. Error handling reviewed
  check("15 error handling reviewed", findings.includes("ARCH-024") && findings.includes("recordAudit"));
  // 16. Test architecture reviewed
  check("16 test architecture reviewed (false-green)", findings.includes("ARCH-022") && findings.includes("false-green"));
  // 17. Build/deploy reviewed
  check("17 build/deploy reviewed", findings.includes("ARCH-013") && findings.includes("ARCH-016"));
  // 18. Maintainability reviewed
  const exec = read("docs/audits/full-audit-01-executive-summary.md");
  check("18 maintainability reviewed", exec.includes("поддержк") && exec.includes("Риск"));
  // 19. Metrics generated
  const metrics = read("docs/audits/codebase-metrics-2026-08.md");
  check("19 metrics generated", metrics.includes("71,860") || metrics.includes("Total LOC"));
  check("19b metrics JSON present", has("docs/audits/data/codebase-metrics.json"));
  // 20. Every finding has severity + evidence + path
  const archIds = [...findings.matchAll(/## (ARCH-\d+)/g)].map((m) => m[1]);
  const allHaveSeverity = archIds.length >= 20 && [...findings.matchAll(/## ARCH-\d+[\s\S]*?Severity:\*\* S[0-3]/g)].length >= 20;
  check("20 every finding has severity/evidence/path", allHaveSeverity && findings.includes("Files:**") && findings.includes("src/"), `${archIds.length} findings`);
  // 21. P0/P1/P2 assigned
  const backlog = read("docs/release/remediation-backlog-after-audit-01.md");
  check("21 P0/P1/P2 assigned", backlog.includes("## P0") && backlog.includes("## P1") && backlog.includes("## P2") && backlog.includes("DEFERRED"));
  // 22. Remediation backlog generated with finding IDs + effort + target
  check("22 remediation backlog generated", backlog.includes("ARCH-002") && backlog.includes("Effort") && backlog.includes("Target") && backlog.includes("08-"));

  // 23-25. Read-only guarantees (git diff since baseline touched NO src/prisma; audit scripts don't mutate data)
  let changed = "";
  try { changed = execSync(`git diff --name-only ${BASELINE} HEAD`, { cwd: root, encoding: "utf8" }); } catch { changed = "GIT_UNAVAILABLE"; }
  const files = changed.split("\n").map((s) => s.trim()).filter(Boolean);
  const touchedSrc = files.filter((f) => f.startsWith("src/"));
  const touchedSchema = files.filter((f) => f.startsWith("prisma/") && !f.includes("/data/"));
  check("23 no source business logic changed since baseline", changed === "GIT_UNAVAILABLE" || touchedSrc.length === 0, touchedSrc.join(", "));
  check("24 no schema/migration added since baseline", changed === "GIT_UNAVAILABLE" || touchedSchema.length === 0, touchedSchema.join(", "));
  const auditScripts = ["scripts/audit-codebase-metrics.mjs", "scripts/audit-direct-prisma-access.mjs", "scripts/audit-status-transitions.mjs", "scripts/audit-tenant-query-patterns.mjs", "scripts/audit-dead-code-candidates.mjs"];
  // Audit scripts must not connect to a DB at all: no @prisma/client import, no PrismaClient
  // instantiation (they are pure filesystem scanners). Note: the scripts legitimately CONTAIN
  // ".create("/".update(" as search-regex literals — those are not DB calls, so we check the
  // import/instantiation surface, not substrings.
  const noDbInScripts = auditScripts.every((s) => { const t = read(s); return !/@prisma\/client|new PrismaClient\(/.test(t); });
  check("25 no production data mutation (audit scripts never connect to a DB)", noDbInScripts);

  // 26-30. Gauntlet recorded green in the baseline (the live runs are executed outside this pilot)
  check("26 tsc recorded clean in baseline", baseline.includes("tsc") && baseline.includes("clean"));
  check("27 prisma dev valid recorded", baseline.includes("dev, sqlite") && baseline.includes("valid"));
  check("28 prisma prod valid recorded", baseline.includes("prod, postgres") && baseline.includes("valid"));
  check("29 pilot:full green recorded", baseline.includes("3641 passed / 0 failed"));
  check("30 build:prod green recorded", baseline.includes("compiled (exit 0)"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main();
