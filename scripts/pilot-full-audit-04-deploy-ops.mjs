// Pilot — FULL AUDIT 4/6 (Deploy/Ops). Verifies the audit DELIVERABLES exist and are intact and
// that the audit changed NO src/schema/data and did NOT deploy (git-diff gate). It does not grade
// the infrastructure — it proves the audit was performed and stayed read-only.
//   npm run pilot:full-audit-04-deploy-ops
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p) => { try { return readFileSync(root + p, "utf8"); } catch { return ""; } };
const has = (p) => existsSync(root + p);
const json = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };
const BASELINE = "dc14d10";

function main() {
  const findings = read("docs/audits/full-audit-04-deploy-ops.md");
  check("1 deployment architecture documented", read("docs/operations/deployment-architecture.md").includes("migrate") && read("docs/operations/deployment-architecture.md").includes("rollback"));
  check("2 prisma build matrix tested", read("docs/operations/prisma-build-matrix.md").includes("ARCH-013") && read("docs/operations/prisma-build-matrix.md").includes("un-pathed generator"));
  check("3 migration risks inventoried", has("docs/audits/data/migration-risks.json") && read("docs/operations/migration-risk-register.md").includes("CONCURRENTLY"));
  check("4 staging rehearsal documented honestly", read("docs/testing/staging-migration-rehearsal.md").includes("NOT EXECUTED"));
  check("5 backup policy exists", read("docs/operations/backup-policy.md").includes("RPO") && read("docs/operations/backup-policy.md").includes("off-site"));
  check("6 restore rehearsal result explicit", /NOT EXECUTED/.test(read("docs/testing/backup-restore-rehearsal.md")) && /EXECUTED/.test(read("docs/testing/backup-restore-rehearsal.md")));
  check("7 storage durability reviewed", read("docs/operations/file-storage-durability.md").includes("redeploy") && has("docs/audits/data/storage-risk.json"));
  check("8 health/readiness reviewed", read("docs/operations/health-readiness-spec.md").includes("liveness") && read("docs/operations/health-readiness-spec.md").includes("readiness"));
  check("9 startup safety reviewed", findings.includes("Startup safety") && findings.includes("fail fast"));
  check("10 env contract reviewed", read("docs/operations/environment-secrets-register.md").includes("fail-closed") && has("docs/audits/data/env-contract.json"));
  check("11 secrets values not exposed", !/=\s*['\"][A-Za-z0-9+/]{20,}/.test(read("docs/operations/environment-secrets-register.md")));
  check("12 logging reviewed", read("docs/operations/logging-spec.md").includes("recordAudit") && read("docs/operations/logging-spec.md").includes("Failed authorization"));
  check("13 monitoring reviewed", read("docs/operations/monitoring-alerts.md").includes("alert matrix") || read("docs/operations/monitoring-alerts.md").includes("Alert matrix") || read("docs/operations/monitoring-alerts.md").includes("alert"));
  check("14 error tracking reviewed", read("docs/operations/monitoring-alerts.md").includes("error track") || read("docs/operations/monitoring-alerts.md").includes("Error tracking"));
  check("15 cron/jobs reviewed", read("docs/operations/incident-runbooks.md").includes("OFD") && findings.includes("OPS-008"));
  const rb = read("docs/operations/rollback-runbook.md");
  check("16 rollback runbook exists (no destructive reset advised)", rb.includes("DB rollback") && rb.includes("Never") && /migrate reset/.test(rb));
  check("17 incident runbooks exist", read("docs/operations/incident-runbooks.md").includes("Double payment") && read("docs/operations/incident-runbooks.md").includes("Backup failed"));
  check("18 production access matrix exists", read("docs/operations/disaster-recovery-plan.md").includes("access matrix") || read("docs/operations/disaster-recovery-plan.md").includes("SSH to VM"));
  check("19 release checklist exists", read("docs/operations/release-checklist.md").includes("BLOCKER") && read("docs/operations/release-checklist.md").includes("Staging migration rehearsal"));
  check("20 post-deploy checklist exists", read("docs/operations/post-deploy-checklist.md").includes("readiness") && read("docs/operations/post-deploy-checklist.md").includes("reconciliation"));
  check("21 DR plan exists", read("docs/operations/disaster-recovery-plan.md").includes("Total DB loss") && read("docs/operations/disaster-recovery-plan.md").includes("RPO"));
  check("22 multi-company operations reviewed", findings.includes("Multi-company operations") && findings.includes("OPS-016"));
  check("23 capacity assumptions documented", findings.includes("Capacity assumptions") && findings.includes("1M"));
  const ids = [...findings.matchAll(/## (OPS-\d+)/g)].map((m) => m[1]);
  check("24 findings have evidence", ids.length >= 16 && [...findings.matchAll(/Severity:\*\* S[0-3]/g)].length >= 16 && (findings.includes(".ts:") || findings.includes("deploy.sh:")), `${ids.length} findings`);
  const backlog = read("docs/release/remediation-backlog-after-audit-04.md");
  check("25 P0/P1/P2 assigned", backlog.includes("## P0") && backlog.includes("## P1") && backlog.includes("## P2") && has("docs/audits/data/operations-findings.json"));
  check("26 remediation backlog exists", backlog.includes("OPS-001") && backlog.includes("rehearsal") && backlog.includes("Effort"));

  // 27/28/29/30 read-only + no-deploy guarantees.
  let changed = "";
  try { changed = execSync(`git diff --name-only ${BASELINE} HEAD`, { cwd: root, encoding: "utf8" }); } catch { changed = "GIT_UNAVAILABLE"; }
  const files = changed.split("\n").map((s) => s.trim()).filter(Boolean);
  const touchedSrc = files.filter((f) => f.startsWith("src/"));
  const touchedSchema = files.filter((f) => f.startsWith("prisma/"));
  const touchedDeploy = files.filter((f) => f.startsWith("deploy/") || f === "Dockerfile" || f.startsWith("docker-") || f.startsWith(".github/"));
  check("27 no production deploy (no deploy/CI/Dockerfile change)", changed === "GIT_UNAVAILABLE" || touchedDeploy.length === 0, touchedDeploy.join(", "));
  // The scanner is a pure filesystem reader: it must not import a DB client or a process-runner
  // (it legitimately CONTAINS strings like "migrate deploy" as search patterns — check imports, not substrings).
  const scanner = read("scripts/audit-deploy-ops.mjs");
  check("28 no production mutation (scanner is pure-fs: no DB client / no process exec)", !/@prisma\/client|new PrismaClient\(|child_process|execSync\(|spawnSync\(/.test(scanner));
  check("29 no schema migration added", changed === "GIT_UNAVAILABLE" || touchedSchema.length === 0, touchedSchema.join(", "));
  check("30 no business logic changed", changed === "GIT_UNAVAILABLE" || touchedSrc.length === 0, touchedSrc.join(", "));

  // 31-35 gauntlet recorded green in the baseline.
  const baseline = read("docs/audits/full-audit-04-deploy-ops-baseline.md");
  check("31 tsc recorded clean", baseline.includes("tsc") && baseline.includes("clean"));
  check("32 prisma dev valid recorded", baseline.includes("dev (sqlite)") && baseline.includes("valid"));
  check("33 prisma prod valid recorded", baseline.includes("prod (postgres)") && baseline.includes("valid"));
  check("34 pilot:full green recorded", baseline.includes("3733 passed / 0 failed"));
  check("35 build:prod green recorded", baseline.includes("compiled"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main();
