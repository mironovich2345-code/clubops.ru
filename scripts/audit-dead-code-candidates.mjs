// READ-ONLY: dead-code candidate detector (FULL AUDIT 1/6). NO DB connection.
// Flags: Prisma models with no prisma.<model>/tx.<model>/db.<model> reference; exported React
// components never imported; lib modules never imported; disabled-feature tombstones. Emits
// docs/audits/data/dead-code-candidates.json. NOTHING is deleted — candidates only.
//   node scripts/audit-dead-code-candidates.mjs [--json]
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
function walk(d, a = []) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (["node_modules", ".next", ".git"].includes(n)) continue; walk(p, a); } else a.push(p); } return a; }
const files = walk(join(ROOT, "src")).filter((f) => [".ts", ".tsx"].includes(extname(f)));
const rel = (f) => relative(ROOT, f).replace(/\\/g, "/");
const allText = files.map((f) => ({ path: rel(f), text: readFileSync(f, "utf8") }));
const corpus = allText.map((a) => a.text).join("\n");

// 1) Prisma models with no data-access reference (checks prisma./tx./db. + any Cased usage).
const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const modelNames = [...schema.matchAll(/^model\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
const unusedModels = [];
for (const model of modelNames) {
  const camel = model[0].toLowerCase() + model.slice(1);
  const re = new RegExp(`(prisma|tx|db)\\.${camel}\\b|\\b${camel}\\.(findUnique|findMany|findFirst|create|update|delete|upsert|count|aggregate|groupBy)`);
  if (!re.test(corpus)) unusedModels.push(model);
}

// 2) Exported components / lib modules never imported by basename.
const importCandidates = [];
for (const { path } of allText) {
  if (!/\/(components|lib)\//.test(path)) continue;
  const name = basename(path).replace(/\.(ts|tsx)$/, "");
  if (name === "index") continue;
  // imported by path fragment or by name?
  const importedByPath = corpus.includes(path.replace(/\.(ts|tsx)$/, "").replace(/^src\//, "@/"));
  const importedByName = new RegExp(`from\\s+["'][^"']*/${name}["']|import\\s+["'][^"']*/${name}["']`).test(corpus);
  const selfOnly = corpus.split(name).length - 1 <= 1; // only its own declaration mentions it
  if (!importedByPath && !importedByName && selfOnly) importCandidates.push(path);
}

// 3) Disabled-feature tombstones + intentional 404 routes.
const tombstones = allText.filter(({ text }) => /Legacy .* disabled|auditBlockedFeature|return new NextResponse\(null, \{ status: 404|isFeatureDisabled/.test(text)).map((a) => a.path);

const report = {
  models: { total: modelNames.length, noDataAccessReference: unusedModels },
  unusedComponentOrLibCandidates: importCandidates,
  disabledFeatureTombstones: tombstones,
  note: "noDataAccessReference models may still be used via tx.<model>/db.<model> aliases inside a $transaction — VERIFY before treating as dead. unusedComponentOrLibCandidates are files whose basename is never imported anywhere (strong dead-code signal). Tombstones are intentional (kill-switch / 404) — keep unless consolidating. Nothing here is deleted by this script.",
};
mkdirSync(join(ROOT, "docs/audits/data"), { recursive: true });
writeFileSync(join(ROOT, "docs/audits/data/dead-code-candidates.json"), JSON.stringify(report, null, 2));
if (!JSON_ONLY) {
  console.log("=== Dead-code candidates (read-only) ===");
  console.log(`Prisma models: ${modelNames.length}; with NO data-access reference (verify tx/db alias): ${unusedModels.length}`);
  if (unusedModels.length) console.log("  " + unusedModels.join(", "));
  console.log(`Unused component/lib module candidates (basename never imported): ${importCandidates.length}`);
  for (const c of importCandidates) console.log("  " + c);
  console.log(`Disabled-feature / 404 tombstones: ${tombstones.length}`);
  console.log("Wrote docs/audits/data/dead-code-candidates.json");
}
