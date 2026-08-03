// READ-ONLY codebase metrics collector (FULL AUDIT 1/6). Scans the source tree on disk —
// NO database connection, NO writes to code, NO production access. Emits machine-readable
// JSON to docs/audits/data/codebase-metrics.json + a human summary to stdout.
//   node scripts/audit-codebase-metrics.mjs [--json]
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SRC = join(ROOT, "src");
const SCRIPTS = join(ROOT, "scripts");
const JSON_ONLY = process.argv.includes("--json");

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next" || name === ".git") continue;
      walk(p, acc);
    } else acc.push(p);
  }
  return acc;
}

const countMatches = (text, re) => (text.match(re) || []).length;

// Count top-level-ish functions and flag those whose body exceeds 100 lines. Heuristic:
// match `function name(` / `const name = (…) =>` / `export async function` and measure to the
// matching brace depth returning to 0. Good enough for a risk signal, not a compiler.
function longFunctions(text, path) {
  const lines = text.split("\n");
  const out = [];
  const sig = /^\s*(export\s+)?(async\s+)?function\s+([A-Za-z0-9_]+)|^\s*(export\s+)?const\s+([A-Za-z0-9_]+)\s*(:[^=]+)?=\s*(async\s*)?\([^)]*\)\s*(:[^=]+)?=>/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(sig);
    if (!m) continue;
    const name = m[3] || m[5] || "anon";
    // find first { on this or next few lines, then track depth
    let depth = 0, started = false, len = 0;
    for (let j = i; j < lines.length; j++) {
      const l = lines[j];
      for (const ch of l) { if (ch === "{") { depth++; started = true; } else if (ch === "}") depth--; }
      len++;
      if (started && depth <= 0) break;
    }
    if (len > 100) out.push({ name, line: i + 1, length: len });
  }
  return out;
}

const files = walk(SRC).filter((f) => [".ts", ".tsx"].includes(extname(f)));
let totalLoc = 0, tsxLoc = 0;
const big = [], longFns = [];
let todo = 0, anys = 0, tsIgnore = 0, eslintDisable = 0, consoleUse = 0, useClient = 0, useServer = 0;
let directPrismaFiles = 0, prismaInPage = 0, rawSql = 0, transactions = 0, revalidate = 0;
let hardcodedRoleStatus = 0;
const ROLE_STATUS_RE = /"(owner|general_director|regional_director|manager|chief_accountant|accountant|marketer|draft|approved|confirmed|paid|pending|cancelled|canceled|rejected|needs_review|submitted|verified)"/g;

for (const f of files) {
  const text = readFileSync(f, "utf8");
  const loc = text.split("\n").length;
  totalLoc += loc;
  if (extname(f) === ".tsx") tsxLoc += loc;
  const rel = relative(ROOT, f).replace(/\\/g, "/");
  if (loc > 500) big.push({ path: rel, loc });
  for (const fn of longFunctions(text, rel)) longFns.push({ path: rel, ...fn });
  todo += countMatches(text, /\b(TODO|FIXME|HACK|XXX)\b/g);
  anys += countMatches(text, /:\s*any\b|<any>|as any\b/g);
  tsIgnore += countMatches(text, /@ts-ignore|@ts-expect-error/g);
  eslintDisable += countMatches(text, /eslint-disable/g);
  consoleUse += countMatches(text, /console\.(log|error|warn|debug|info)/g);
  if (/^\s*["']use client["']/m.test(text)) useClient++;
  if (/^\s*["']use server["']/m.test(text)) useServer++;
  if (/\bprisma\./.test(text)) directPrismaFiles++;
  if (f.endsWith("page.tsx") && /\bprisma\./.test(text)) prismaInPage++;
  rawSql += countMatches(text, /\$queryRaw|\$executeRaw/g);
  transactions += countMatches(text, /\$transaction/g);
  revalidate += countMatches(text, /revalidatePath|router\.refresh/g);
  hardcodedRoleStatus += countMatches(text, ROLE_STATUS_RE);
}

// Prisma schema stats (read the file, do not connect).
const devSchema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const models = countMatches(devSchema, /^model\s+/gm);
const enums = countMatches(devSchema, /^enum\s+/gm);
const devMigrations = readdirSync(join(ROOT, "prisma/migrations")).filter((n) => /^\d/.test(n)).length;
const prodMigrations = readdirSync(join(ROOT, "prisma/production/migrations")).filter((n) => /^\d/.test(n)).length;
const pilotFiles = readdirSync(SCRIPTS).filter((n) => /^pilot-.*\.mjs$/.test(n) && n !== "pilot-full.mjs").length;

const metrics = {
  generatedAt: "static-scan",
  files: { tsTsx: files.length, filesOver500Loc: big.length },
  loc: { total: totalLoc, tsx: tsxLoc },
  boundaries: { useClientFiles: useClient, useServerFiles: useServer, filesTouchingPrisma: directPrismaFiles, prismaInPageTsx: prismaInPage },
  quality: { todoFixmeHack: todo, anyUsage: anys, tsIgnore, eslintDisable, consoleUsage: consoleUse, rawSql, transactionUsages: transactions, revalidateCalls: revalidate, hardcodedRoleStatusLiterals: hardcodedRoleStatus },
  schema: { models, enums, devMigrations, prodMigrations, migrationDrift: devMigrations - prodMigrations },
  tests: { pilotSuites: pilotFiles },
  functionsOver100Loc: longFns.length,
  topBigFiles: big.sort((a, b) => b.loc - a.loc).slice(0, 25),
  topLongFunctions: longFns.sort((a, b) => b.length - a.length).slice(0, 30),
};

const outDir = join(ROOT, "docs/audits/data");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "codebase-metrics.json"), JSON.stringify(metrics, null, 2));

if (!JSON_ONLY) {
  console.log("=== CLUB-OPS codebase metrics (read-only static scan) ===");
  console.log(`TS/TSX files: ${metrics.files.tsTsx} | total LOC: ${metrics.loc.total} (tsx ${metrics.loc.tsx})`);
  console.log(`Prisma models: ${models} | enums: ${enums} | migrations dev/prod: ${devMigrations}/${prodMigrations} (drift ${metrics.schema.migrationDrift})`);
  console.log(`Pilot suites: ${pilotFiles}`);
  console.log(`use client: ${useClient} | use server: ${useServer} | files touching prisma: ${directPrismaFiles} | prisma in page.tsx: ${prismaInPage}`);
  console.log(`files>500 LOC: ${big.length} | functions>100 LOC: ${longFns.length}`);
  console.log(`TODO/FIXME/HACK: ${todo} | any: ${anys} | ts-ignore: ${tsIgnore} | eslint-disable: ${eslintDisable} | console: ${consoleUse} | raw SQL: ${rawSql} | $transaction: ${transactions}`);
  console.log(`hardcoded role/status string literals: ${hardcodedRoleStatus}`);
  console.log(`\nTop 10 biggest files:`);
  for (const b of metrics.topBigFiles.slice(0, 10)) console.log(`  ${String(b.loc).padStart(5)}  ${b.path}`);
  console.log(`\nWrote ${relative(ROOT, join(outDir, "codebase-metrics.json"))}`);
}
