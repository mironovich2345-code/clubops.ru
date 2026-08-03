// READ-ONLY: map direct Prisma access across layers (FULL AUDIT 1/6). NO DB connection.
// Flags prisma usage inside React Server Component page.tsx / component files (coupling smell)
// and counts prisma-touching files per layer. Emits docs/audits/data/direct-prisma-access.json.
//   node scripts/audit-direct-prisma-access.mjs [--json]
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
function walk(d, a = []) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (["node_modules", ".next", ".git"].includes(n)) continue; walk(p, a); } else a.push(p); } return a; }

const files = walk(join(ROOT, "src")).filter((f) => [".ts", ".tsx"].includes(extname(f)));
const rel = (f) => relative(ROOT, f).replace(/\\/g, "/");
const layerOf = (p) => p.includes("/lib/") ? "lib" : /\/actions?\.ts$|-actions\.ts$/.test(p) ? "server-action" : p.endsWith("page.tsx") ? "page-rsc" : p.endsWith(".tsx") ? "component" : p.includes("/api/") ? "api-route" : "other";

const byLayer = {};
const pageOrComponentWithPrisma = [];
const idWrites = []; // .update/.delete({ where: { id ... without a nearby companyId in the where
for (const f of files) {
  const text = readFileSync(f, "utf8");
  if (!/\bprisma\.|\btx\.\w+\./.test(text)) continue;
  const layer = layerOf(rel(f));
  byLayer[layer] = (byLayer[layer] || 0) + 1;
  if ((f.endsWith("page.tsx") || (f.endsWith(".tsx") && !f.endsWith("page.tsx"))) && /\bprisma\./.test(text)) {
    const calls = (text.match(/prisma\.[A-Za-z]+\.(findUnique|findFirst|findMany|update|delete|create|upsert|count|aggregate|groupBy)/g) || []);
    if (f.endsWith(".tsx")) pageOrComponentWithPrisma.push({ path: rel(f), kind: layerOf(rel(f)), calls: calls.length });
  }
  // id-keyed writes without companyId in the same where object (heuristic evidence, not a verdict)
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/\.(update|delete)\(\{\s*where:\s*\{\s*id\b/.test(lines[i])) {
      const windowText = lines.slice(i, i + 3).join(" ");
      if (!/companyId|idempotencyKey/.test(windowText)) idWrites.push({ path: rel(f), line: i + 1, code: lines[i].trim().slice(0, 120) });
    }
  }
}

const report = {
  filesTouchingPrisma: Object.values(byLayer).reduce((a, b) => a + b, 0),
  byLayer,
  prismaInPageOrComponent: pageOrComponentWithPrisma.sort((a, b) => b.calls - a.calls),
  idKeyedWritesWithoutCompanyIdInWhere: idWrites,
  note: "id-keyed writes are flagged ONLY as places to verify a preceding scope check exists; most are guarded by a findUnique+companyId check on the line above (safe). This is architectural evidence, not a security verdict (see audit #5).",
};
mkdirSync(join(ROOT, "docs/audits/data"), { recursive: true });
writeFileSync(join(ROOT, "docs/audits/data/direct-prisma-access.json"), JSON.stringify(report, null, 2));
if (!JSON_ONLY) {
  console.log("=== Direct Prisma access (read-only) ===");
  console.log("Files touching prisma by layer:", JSON.stringify(byLayer));
  console.log(`Prisma inside page.tsx / components: ${pageOrComponentWithPrisma.length}`);
  console.log(`id-keyed update/delete without companyId in the where (verify guard precedes): ${idWrites.length}`);
  console.log("Wrote docs/audits/data/direct-prisma-access.json");
}
