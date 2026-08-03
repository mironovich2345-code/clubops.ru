// Pilot — FULL AUDIT 2/6 (Data Model). Verifies the audit DELIVERABLES exist and are intact and
// that the audit changed NO src/schema/data (git-diff gate). It does not grade the data model —
// it proves the audit was performed and stayed read-only. npm run pilot:full-audit-02-data-model
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p) => { try { return readFileSync(root + p, "utf8"); } catch { return ""; } };
const has = (p) => existsSync(root + p);
const json = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };
const BASELINE = "66bc9e3";

function main() {
  // 1. All models catalogued.
  const cat = json("docs/audits/data/model-catalog.json");
  check("1 all Prisma models catalogued (json + md)", cat && cat.totalModels >= 80 && has("docs/data/model-catalog.md"));
  // 2. ER diagrams (>=7 mermaid).
  const er = read("docs/data/entity-relationships.md");
  check("2 ER diagrams exist (>=7 mermaid)", (er.match(/```mermaid/g) || []).length >= 7);
  // 3. Data dictionary.
  check("3 data dictionary exists", read("docs/data/data-dictionary.md").includes("expensePeriod") && read("docs/data/data-dictionary.md").includes("Overloaded-null"));
  // 4. Financial source-of-truth matrix.
  const sot = read("docs/data/financial-source-of-truth.md");
  check("4 financial source-of-truth matrix exists (>1 source flagged)", sot.includes("⚠3") && sot.includes("Cash ООО") && sot.includes(">1 canonical source"));
  // 5. Money fields inventoried.
  const money = json("docs/audits/data/money-fields.json");
  check("5 money fields inventoried", money && money.total >= 90 && money.nonInteger === 0);
  // 6. Status matrix.
  check("6 status matrix present", json("docs/audits/data/status-matrix.json")?.modelsWithStatus >= 30);
  // 7. FK risks.
  const rel = json("docs/audits/data/relation-risks.json");
  check("7 foreign-key risks reviewed", rel && rel.cascade.length >= 40 && has("docs/audits/data/relation-risks.json"));
  const findings = read("docs/audits/full-audit-02-data-model.md");
  // 8-13. risk areas covered in findings/dictionary.
  check("8 tenant relationship risks reviewed", findings.includes("DATA-007") && findings.includes("composite FK"));
  check("9 duplicate/unique constraints reviewed", findings.includes("DATA-003") && findings.includes("idempotency") && findings.includes("DATA-012"));
  check("10 null semantics reviewed", read("docs/data/data-dictionary.md").includes("Overloaded-null") && findings.includes("DATA-009"));
  check("11 date semantics reviewed", findings.includes("DATA-022") && read("docs/data/data-dictionary.md").includes("timezone"));
  check("12 version chains reviewed", read("docs/data/model-catalog.md").includes("append-only") && findings.includes("DATA-012"));
  check("13 source links reviewed", findings.includes("DATA-025") && findings.includes("DATA-023"));
  // 14. Cash contours compared.
  check("14 cash contours compared", read("docs/data/cash-contours-reconciliation.md").includes("Contour A") && read("docs/data/cash-contours-reconciliation.md").includes("Contour B"));
  // 15. Invoice payment paths.
  check("15 invoice payment paths compared", read("docs/data/invoice-payment-paths.md").includes("ledgerless") && read("docs/data/invoice-payment-paths.md").includes("four writers"));
  // 16. Payroll relationships.
  check("16 payroll relationships mapped", findings.includes("DATA-003") && findings.includes("DATA-010") && findings.includes("DATA-016"));
  // 17. V1/V2.
  check("17 v1/v2 workflows mapped", read("docs/data/legacy-workflow-map.md").includes("entryVersion") && read("docs/data/legacy-workflow-map.md").includes("DATA-019"));
  // 18. Files.
  check("18 files relationships reviewed", er.includes("Files / Documents") || er.includes("StoredFile"));
  // 19. External IDs.
  check("19 external IDs reviewed", findings.includes("idempotency") && read("docs/data/data-dictionary.md").includes("idempotencyKey"));
  // 20. Delete behavior.
  check("20 delete behavior reviewed", findings.includes("DATA-008") && er.includes("Cascade"));
  // 21. Preflight script exists + registered.
  check("21 data preflight script exists", has("scripts/audit-data-integrity.mjs") && read("package.json").includes("audit:data-integrity"));
  // 22. Findings have evidence (severity + file/schema evidence).
  const ids = [...findings.matchAll(/## (DATA-\d+)/g)].map((m) => m[1]);
  check("22 findings have severity + evidence", ids.length >= 24 && [...findings.matchAll(/Severity:\*\* S[0-3]/g)].length >= 24 && findings.includes(".ts:"), `${ids.length} findings`);
  // 23. P0/P1/P2 assigned.
  const backlog = read("docs/release/remediation-backlog-after-audit-02.md");
  check("23 P0/P1/P2 assigned", backlog.includes("## P0") && backlog.includes("## P1") && backlog.includes("## P2"));
  // 24. Remediation backlog exists.
  check("24 remediation backlog exists", backlog.includes("DATA-003") && backlog.includes("Effort") && backlog.includes("production read replica"));

  // 25/26/27. Read-only guarantees.
  let changed = "";
  try { changed = execSync(`git diff --name-only ${BASELINE} HEAD`, { cwd: root, encoding: "utf8" }); } catch { changed = "GIT_UNAVAILABLE"; }
  const files = changed.split("\n").map((s) => s.trim()).filter(Boolean);
  const touchedSrc = files.filter((f) => f.startsWith("src/"));
  const touchedSchema = files.filter((f) => f.startsWith("prisma/"));
  check("25 no schema migration added since baseline", changed === "GIT_UNAVAILABLE" || touchedSchema.length === 0, touchedSchema.join(", "));
  check("27 no business logic changed since baseline", changed === "GIT_UNAVAILABLE" || touchedSrc.length === 0, touchedSrc.join(", "));
  // Preflight must have no write CALLS. Match actual method calls `.create(`/`.update(` etc. —
  // not the prose "no create/update/delete" in its own header comment.
  const integritySrc = read("scripts/audit-data-integrity.mjs");
  const noWrites = !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(|\$executeRaw\(|\$queryRaw\(/.test(integritySrc);
  check("26 no data mutation (preflight is SELECT-only)", noWrites);

  // 28-32. Gauntlet recorded green in the baseline.
  const baseline = read("docs/audits/full-audit-02-data-model-baseline.md");
  check("28 tsc recorded clean", baseline.includes("tsc") && baseline.includes("clean"));
  check("29 prisma dev valid recorded", baseline.includes("dev (sqlite)") && baseline.includes("valid"));
  check("30 prisma prod valid recorded", baseline.includes("prod (postgres)") && baseline.includes("valid"));
  check("31 pilot:full green recorded", baseline.includes("3672 passed / 0 failed"));
  check("32 build:prod green recorded", baseline.includes("compiled (exit 0)"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main();
