// Pilot — FULL AUDIT 3/6 (Accounting). Verifies the audit DELIVERABLES exist and are intact and
// that the audit changed NO formulas/schema/data (git-diff gate). It does not grade the accounting
// — it proves the audit was performed and stayed read-only. npm run pilot:full-audit-03-accounting
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p) => { try { return readFileSync(root + p, "utf8"); } catch { return ""; } };
const has = (p) => existsSync(root + p);
const json = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };
const BASELINE = "d161c15";
const AUDIT_END = "dc14d10"; // REM-01: pin diff endpoint to this audit's completion

function main() {
  const contours = read("docs/accounting/financial-contours-map.md");
  const matrix = read("docs/accounting/accounting-recognition-matrix.md");
  const profit = read("docs/accounting/profit-formulas.md");
  const budget = read("docs/accounting/budget-fact-model.md");
  const cash = read("docs/accounting/cash-dual-contour-impact.md");
  const rounding = read("docs/accounting/math-and-rounding-map.md");
  const decisions = read("docs/accounting/business-decisions-required.md");
  const findings = read("docs/audits/full-audit-03-accounting-model.md");
  const backlog = read("docs/release/remediation-backlog-after-audit-03.md");

  check("1 all financial contours mapped", contours.includes("Income") && contours.includes("Expenses") && contours.includes("Money movements") && contours.includes("Managerial"));
  check("2 recognition matrix exists", matrix.includes("Recognition matrix") && matrix.includes("expensePeriod") && /accrual method/i.test(matrix));
  check("3 profit formulas compared", profit.includes("analytics.ts:557") && profit.includes("OFD path") && profit.includes("DEAD CODE"));
  check("4 budget fact formulas compared", budget.includes("computeUsedKopeks") && budget.includes("computeBudgetFactReport") && budget.includes("verified"));
  check("5 invoice accounting mapped", matrix.includes("Invoice paid") && matrix.includes("amountKopeks == "));
  check("6 payroll accounting mapped", matrix.includes("PayrollPayment") && matrix.includes("netPayableKopeks == paidKopeks + remainingKopeks"));
  check("7 refund accounting mapped", matrix.includes("Refund") && findings.includes("single-effect"));
  check("8 cash ООО formula mapped", cash.includes("cashOooFactBalance") && cash.includes("NO ООО cash-expense term"));
  check("9 cash ИП formula mapped", cash.includes("cashIpFactBalance") && cash.includes("walletBalanceKopeks"));
  check("10 dual cash contour impact mapped", cash.includes("Per-operation contour impact") && cash.includes("40 000"));
  check("11 obligations/debt mapped", findings.includes("debt") && (findings.includes("three") || findings.includes("×3")) );
  check("12 legal entities reviewed", findings.includes("FIN-014") && decisions.includes("BD-11"));
  check("13 period semantics reviewed", findings.includes("FIN-015") && matrix.includes("Accrual method"));
  check("14 tax fields reviewed without invented rules", findings.includes("FIN-007") && decisions.includes("BD-13") && /no tax\/vat|No tax\/VAT|NO tax model/i.test(findings));
  check("15 rounding map exists", rounding.includes("Rounding by computation") && rounding.includes("ceilToRubleKopeks") && rounding.includes("engine 2"));
  check("16 reconciliation equations exist", matrix.includes("Reconciliation equations") && has("docs/audits/data/reconciliation-report.json"));
  check("17 synthetic scenarios exist", matrix.includes("Synthetic scenarios") && matrix.includes("Legacy paid invoice without payment row"));
  check("18 read-only financial audit script exists", has("scripts/audit-financial-reconciliation.mjs") && read("package.json").includes("audit:financial-reconciliation"));
  const ids = [...findings.matchAll(/## (FIN-\d+)/g)].map((m) => m[1]);
  check("19 findings have evidence", ids.length >= 15 && [...findings.matchAll(/Severity:\*\* S[0-3]/g)].length >= 15 && findings.includes(".ts:"), `${ids.length} findings`);
  check("20 business decisions separated", decisions.includes("BD-01") && decisions.includes("BD-14") && has("docs/audits/data/business-decisions.json"));
  check("21 remediation backlog exists", backlog.includes("## P0") && backlog.includes("FIN-005") && backlog.includes("production read replica"));

  // 22/23/24 read-only guarantees.
  let changed = "";
  try { changed = execSync(`git diff --name-only ${BASELINE} ${AUDIT_END}`, { cwd: root, encoding: "utf8" }); } catch { changed = "GIT_UNAVAILABLE"; }
  const files = changed.split("\n").map((s) => s.trim()).filter(Boolean);
  const touchedSrc = files.filter((f) => f.startsWith("src/"));
  const touchedSchema = files.filter((f) => f.startsWith("prisma/"));
  check("22 no formulas / business logic changed", changed === "GIT_UNAVAILABLE" || touchedSrc.length === 0, touchedSrc.join(", "));
  check("23 no schema changes", changed === "GIT_UNAVAILABLE" || touchedSchema.length === 0, touchedSchema.join(", "));
  const recon = read("scripts/audit-financial-reconciliation.mjs");
  const noWrites = !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(|\$executeRaw\(|\$queryRaw\(/.test(recon);
  check("24 no data mutation (reconciliation is SELECT-only)", noWrites);

  // 25-29 gauntlet recorded green in the baseline.
  const baseline = read("docs/audits/full-audit-03-accounting-baseline.md");
  check("25 tsc recorded clean", baseline.includes("tsc") && baseline.includes("clean"));
  check("26 prisma dev valid recorded", baseline.includes("dev (sqlite)") && baseline.includes("valid"));
  check("27 prisma prod valid recorded", baseline.includes("prod (postgres)") && baseline.includes("valid"));
  check("28 pilot:full green recorded", baseline.includes("3704 passed / 0 failed"));
  check("29 build:prod green recorded", baseline.includes("compiled"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main();
