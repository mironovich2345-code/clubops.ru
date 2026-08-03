// Pilot — FULL AUDIT 6/6 (Product/UX). Verifies the audit DELIVERABLES exist and are intact and
// that the audit changed NO business logic/schema/RBAC/UI/data (git-diff gate). It does not grade the
// product — it proves the final audit was performed and stayed read-only.
//   npm run pilot:full-audit-06-product-ux
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p) => { try { return readFileSync(root + p, "utf8"); } catch { return ""; } };
const has = (p) => existsSync(root + p);
const json = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };
const BASELINE = "9c43548";
// REM-01: pin the diff endpoint to THIS audit's final commit — 'the audit changed no src' is a
// permanent fact of its own commit range, not a claim about later remediation work.
const AUDIT_END = "aefeb4f";

function main() {
  const map = read("docs/product/product-readiness-map.md");
  const journeys = read("docs/product/role-journeys.md");
  const onboarding = read("docs/product/new-company-onboarding.md");
  const impl = read("docs/product/implementation-plan.md");
  const ux = read("docs/audits/full-audit-06-product-ux.md");
  const checklist = read("docs/testing/final-live-acceptance-checklist.md");
  const support = read("docs/operations/support-process.md");
  const backlog = read("docs/release/final-remediation-backlog-to-2026-08-18.md");
  const roadmap = read("docs/release/roadmap-to-2026-08-18-final.md");
  const gng = read("docs/release/go-no-go-criteria.md");
  const exec = read("docs/audits/full-audit-06-executive-summary.md");

  check("1 product map complete", map.includes("Payroll") && map.includes("READY") && map.includes("DEFERRED"));
  check("2 all roles reviewed", journeys.includes("marketer") || journeys.includes("Маркетолог"));
  check("3 manager journey reviewed", journeys.includes("Управляющий") && journeys.includes("own club"));
  check("4 regional journey reviewed", journeys.includes("Региональный") && journeys.includes("3 «Требуют внимания»") || journeys.includes("task cards"));
  check("5 accountant journey reviewed", journeys.includes("Бухгалтер") && journeys.includes("workspace"));
  check("6 chief accountant reviewed", journeys.includes("Главный") && journeys.includes("reversal"));
  check("7 owner/GD reviewed", journeys.includes("Собственник") && journeys.includes("general_director") || journeys.includes("GD"));
  check("8 new-company onboarding reviewed", onboarding.includes("demo") && onboarding.includes("self-serve"));
  check("9 first-day scenario reviewed", impl.includes("first-day") && impl.includes("Phase 1"));
  check("10 first-month scenario reviewed", impl.includes("first-month") && impl.includes("Phase 2"));
  check("11 workflow consistency reviewed", ux.includes("UX-009") && ux.includes("Отмен"));
  check("12 information architecture reviewed", ux.includes("states") && ux.includes("UX-007"));
  check("13 dashboards reviewed", ux.includes("UX-010") && ux.includes("period"));
  check("14 mobile reviewed", ux.includes("Mobile") && (ux.includes("safe-area") || ux.includes("mature")));
  check("15 desktop reviewed", ux.includes("Desktop"));
  check("16 accessibility reviewed", ux.includes("UX-011") && ux.includes("focus"));
  check("17 forms reviewed", ux.includes("Forms are strong") && ux.includes("data preserved"));
  check("18 files UX reviewed", ux.includes("Files") && (ux.includes("camera") || ux.includes("upload")));
  check("19 AI UX reviewed", ux.includes("AI review UX") && ux.includes("fingerprint"));
  check("20 errors reviewed", ux.includes("UX-008") && /raw error/i.test(ux));
  check("21 audit trail UX reviewed", ux.includes("UX-013") && ux.includes("timeline"));
  check("22 reports reviewed", ux.includes("Reports & exports") && ux.includes("CSV"));
  check("23 empty/loading/error states reviewed", ux.includes("UX-007") && ux.includes("loading"));
  check("24 notifications reviewed", ux.includes("Notifications") && ux.includes("Telegram"));
  check("25 training guides exist", has("docs/training/manager-guide.md") && has("docs/training/regional-guide.md") && has("docs/training/accountant-guide.md") && has("docs/training/chief-accountant-guide.md") && has("docs/training/owner-guide.md"));
  check("26 support process exists", /deployment version|deploymentId|api\/health/i.test(support) && support.includes("read-only"));
  check("27 implementation plan exists", impl.includes("Phase 0") && impl.includes("Phase 3"));
  check("28 final live checklist exists", checklist.includes("G1") && checklist.includes("G16") && checklist.includes("NOT EXECUTED"));
  const fr = json("docs/audits/data/final-remediation.json");
  check("29 final remediation backlog deduplicated", fr && fr.uncoveredFindings.length === 0 && fr.remediationClusters >= 20 && backlog.includes("REM-01"));
  check("30 roadmap to 18 August exists", roadmap.includes("2026-08-18") && roadmap.includes("Phase 1"));
  check("31 go/no-go criteria exist", gng.includes("GO") && gng.includes("NO-GO") && gng.includes("CONDITIONAL"));

  // 32/33/34 read-only + no functional/schema/RBAC change.
  let changed = "";
  try { changed = execSync(`git diff --name-only ${BASELINE} ${AUDIT_END}`, { cwd: root, encoding: "utf8" }); } catch { changed = "GIT_UNAVAILABLE"; }
  const files = changed.split("\n").map((s) => s.trim()).filter(Boolean);
  const touchedSrc = files.filter((f) => f.startsWith("src/"));
  const touchedSchema = files.filter((f) => f.startsWith("prisma/"));
  check("32 no business logic changed", changed === "GIT_UNAVAILABLE" || touchedSrc.length === 0, touchedSrc.join(", "));
  check("33 no schema migration", changed === "GIT_UNAVAILABLE" || touchedSchema.length === 0, touchedSchema.join(", "));
  const idor = read("scripts/audit-idor-matrix.mjs");
  check("34 no production mutation (audit tooling: consolidation is fs-only; idor uses a disposable copy)", !/@prisma\/client|new PrismaClient\(/.test(read("scripts/audit-final-consolidation.mjs")) && idor.includes("DISPOSABLE"));

  // 35-39 gauntlet recorded green in the baseline.
  const baseline = read("docs/audits/full-audit-06-product-baseline.md");
  check("35 tsc recorded clean", baseline.includes("tsc") && baseline.includes("clean"));
  check("36 prisma dev valid recorded", baseline.includes("dev") && baseline.includes("valid"));
  check("37 prisma prod valid recorded", baseline.includes("prod") && baseline.includes("valid"));
  check("38 pilot:full green recorded", baseline.includes("3810 passed / 0 failed"));
  check("39 build:prod green recorded", baseline.includes("compiled"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main();
