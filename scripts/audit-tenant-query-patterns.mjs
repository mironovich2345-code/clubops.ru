// READ-ONLY: flag tenant-scope query patterns to VERIFY (FULL AUDIT 1/6). NO DB connection.
// Locates the architectural shapes that MUST carry a scope guard: id-keyed update/delete,
// findUnique-by-id, upsert, transactions, and money-writing calls. This is architectural
// evidence for the remediation backlog — NOT a security verdict (that is audit #5).
//   node scripts/audit-tenant-query-patterns.mjs [--json]
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
function walk(d, a = []) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (["node_modules", ".next", ".git"].includes(n)) continue; walk(p, a); } else a.push(p); } return a; }
const files = walk(join(ROOT, "src")).filter((f) => [".ts", ".tsx"].includes(extname(f)));
const rel = (f) => relative(ROOT, f).replace(/\\/g, "/");

const counts = { idUpdate: 0, idDelete: 0, findUniqueById: 0, upsert: 0, transaction: 0, createMany: 0, updateManyStatusCas: 0, moneyExpenseCreate: 0 };
const transactionFiles = new Set();
const moneyWriteSites = []; // createSalaryExpense / recordExpenseMovement / payment creates
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  counts.idUpdate += (text.match(/\.update\(\{\s*where:\s*\{\s*id\b/g) || []).length;
  counts.idDelete += (text.match(/\.delete\(\{\s*where:\s*\{\s*id\b/g) || []).length;
  counts.findUniqueById += (text.match(/\.findUnique\(\{\s*where:\s*\{\s*id\b/g) || []).length;
  counts.upsert += (text.match(/\.upsert\(/g) || []).length;
  counts.createMany += (text.match(/\.createMany\(/g) || []).length;
  counts.updateManyStatusCas += (text.match(/updateMany\(\{\s*where:\s*\{[^}]*status/g) || []).length;
  const tx = (text.match(/\$transaction/g) || []).length;
  counts.transaction += tx;
  if (tx) transactionFiles.add(rel(f));
  for (let i = 0; i < lines.length; i++) {
    if (/createSalaryExpense\(|recordExpenseMovement\(/.test(lines[i]) && !/function|export|import/.test(lines[i])) {
      // Is this call inside a $transaction in the same file that passes tx? Heuristic: does the
      // call pass a `tx`/`db:` argument? If not, note it (money write may commit outside a tx).
      const passesTx = /\btx\b|db:\s*tx/.test(lines[i]) || /\btx\b/.test(lines.slice(Math.max(0, i - 6), i).join(" "));
      moneyWriteSites.push({ path: rel(f), line: i + 1, passesTxClient: passesTx, code: lines[i].trim().slice(0, 100) });
    }
  }
}

const report = {
  patternCounts: counts,
  transactionFileCount: transactionFiles.size,
  transactionFiles: [...transactionFiles].sort(),
  moneyWriteCallSites: moneyWriteSites,
  moneyWritesNotObviouslyInTx: moneyWriteSites.filter((s) => !s.passesTxClient).length,
  note: "id-keyed update/delete + findUnique-by-id are the shapes to verify a scope guard precedes. moneyWriteCallSites flags createSalaryExpense/recordExpenseMovement calls; passesTxClient=false means the money write likely commits on the GLOBAL prisma client and would NOT roll back with a surrounding $transaction (consistency risk — see backlog ARCH transaction findings).",
};
mkdirSync(join(ROOT, "docs/audits/data"), { recursive: true });
writeFileSync(join(ROOT, "docs/audits/data/tenant-query-patterns.json"), JSON.stringify(report, null, 2));
if (!JSON_ONLY) {
  console.log("=== Tenant / consistency query patterns (read-only) ===");
  console.log(JSON.stringify(counts, null, 2));
  console.log(`$transaction used in ${transactionFiles.size} files`);
  console.log(`money-write call sites (createSalaryExpense/recordExpenseMovement): ${moneyWriteSites.length}; not obviously in a tx: ${report.moneyWritesNotObviouslyInTx}`);
  console.log("Wrote docs/audits/data/tenant-query-patterns.json");
}
