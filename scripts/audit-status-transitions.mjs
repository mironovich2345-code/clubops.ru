// READ-ONLY: inventory status vocabularies + manual status writes (FULL AUDIT 1/6). NO DB.
// Extracts every *_STATUSES / *_STATUS const array and every `status: "..."` write in server
// actions/lib, so status-machine drift (cancelled vs canceled, unreachable statuses, manual
// sets) is machine-visible. Emits docs/audits/data/status-transitions.json.
//   node scripts/audit-status-transitions.mjs [--json]
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
function walk(d, a = []) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (["node_modules", ".next", ".git"].includes(n)) continue; walk(p, a); } else a.push(p); } return a; }
const files = walk(join(ROOT, "src")).filter((f) => [".ts", ".tsx"].includes(extname(f)));
const rel = (f) => relative(ROOT, f).replace(/\\/g, "/");

const statusArrays = [];       // *_STATUSES const declarations
const manualStatusWrites = []; // data: { status: "..." } writes
const statusVocab = new Set(); // every "status"-ish literal
const cancelSpellings = { cancelled: 0, canceled: 0 };

for (const f of files) {
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const arr = l.match(/(?:const|export const)\s+([A-Z0-9_]*STATUS[A-Z0-9_]*)\s*=/);
    if (arr) statusArrays.push({ path: rel(f), line: i + 1, name: arr[1] });
    const wr = l.match(/status:\s*"([a-z_]+)"/);
    if (wr) {
      manualStatusWrites.push({ path: rel(f), line: i + 1, status: wr[1] });
      statusVocab.add(wr[1]);
    }
    cancelSpellings.cancelled += (l.match(/"cancelled"/g) || []).length;
    cancelSpellings.canceled += (l.match(/"canceled"/g) || []).length;
  }
}

// Group manual writes by status value to spot which statuses are actually produced.
const producedStatuses = {};
for (const w of manualStatusWrites) producedStatuses[w.status] = (producedStatuses[w.status] || 0) + 1;

const report = {
  statusConstArrays: statusArrays.length,
  statusConstArraysList: statusArrays,
  manualStatusWrites: manualStatusWrites.length,
  distinctStatusValuesProduced: Object.keys(producedStatuses).sort(),
  producedStatusCounts: producedStatuses,
  cancelSpellingDrift: cancelSpellings,
  note: "A status that appears in a *_STATUSES array but NOT in distinctStatusValuesProduced is a candidate 'unreachable status' (verify against the state-machine doc). Both cancelled and canceled spellings appearing is a normalization hazard.",
};
mkdirSync(join(ROOT, "docs/audits/data"), { recursive: true });
writeFileSync(join(ROOT, "docs/audits/data/status-transitions.json"), JSON.stringify(report, null, 2));
if (!JSON_ONLY) {
  console.log("=== Status transitions inventory (read-only) ===");
  console.log(`*_STATUS* const arrays: ${statusArrays.length}`);
  console.log(`manual 'status: \"...\"' writes: ${manualStatusWrites.length}`);
  console.log(`distinct produced status values: ${Object.keys(producedStatuses).length}`);
  console.log(`cancel spelling drift → cancelled: ${cancelSpellings.cancelled}, canceled: ${cancelSpellings.canceled} (both present = hazard)`);
  console.log("Wrote docs/audits/data/status-transitions.json");
}
