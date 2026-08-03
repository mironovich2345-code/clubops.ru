// READ-ONLY security-scope scanner (FULL AUDIT 5/6). Static filesystem scan — NO DB, NO deploy,
// NO secret values. Inventories the tenant-scope surface (id-keyed reads/writes, client-supplied
// tenant fields, mass-assignment spreads, XSS sinks, raw SQL, file-route auth, security headers).
// Emits security-read-scope.json, security-write-scope.json, file-access-results.json + a summary.
//   node scripts/audit-security-scope.mjs [--json]
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
const read = (p) => { try { return readFileSync(join(ROOT, p), "utf8"); } catch { return ""; } };
const has = (p) => existsSync(join(ROOT, p));
function walk(d, a = []) { let s; try { s = readdirSync(d); } catch { return a; } for (const n of s) { const p = join(d, n); if (statSync(p).isDirectory()) { if (["node_modules", ".next", ".git"].includes(n)) continue; walk(p, a); } else a.push(p); } return a; }
const rel = (f) => relative(ROOT, f).replace(/\\/g, "/");
const files = walk(join(ROOT, "src")).filter((f) => [".ts", ".tsx"].includes(extname(f)));

// --- Reads: findUnique/findFirst by id, and whether a companyId scope appears nearby ---
const idReads = [];
const clientTenantTrust = []; // companyId/clubId read from formData/params then used
// --- Writes: id-keyed update/delete/upsert and whether a scope guard is co-located ---
const idWrites = [];
// --- Mass assignment ---
const massAssign = [];
// --- XSS sinks ---
const xssSinks = [];
// --- raw SQL ---
const rawSql = [];
let filesTouchingPrisma = 0;

for (const f of files) {
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  const r = rel(f);
  if (/\bprisma\.|\btx\.\w+\./.test(text)) filesTouchingPrisma++;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const ctx = lines.slice(Math.max(0, i - 4), i + 5).join(" "); // +/-4 line window
    // id-keyed reads
    if (/\.(findUnique|findFirst)\(\{\s*where:\s*\{\s*id\b/.test(l)) {
      const scoped = /companyId|allowedClubIds|clubId:\s*\{\s*in/.test(l) || /companyId|allowedClubIds/.test(ctx);
      idReads.push({ path: r, line: i + 1, scopedNearby: scoped, code: l.trim().slice(0, 120) });
    }
    // id-keyed writes
    if (/\.(update|delete|upsert)\(\{\s*where:\s*\{\s*id\b/.test(l)) {
      const scoped = /companyId|allowedClubIds|idempotencyKey|clubId_category_month|clubId:\s*\{\s*in/.test(l) || /companyId|allowedClubIds|canAccessClub|selectedCompanyId/.test(ctx);
      idWrites.push({ path: r, line: i + 1, scopeGuardNearby: scoped, code: l.trim().slice(0, 120) });
    }
    // client-supplied tenant fields trusted (companyId/clubId from formData/searchParams/body)
    if (/(companyId|clubId|legalEntityId)\s*=\s*String\(\s*(formData|searchParams|params|body)/.test(l) || /(companyId|clubId)\s*:\s*(body|input|parsed)\.(companyId|clubId)/.test(l)) {
      const intersected = /includes\(|canAccessC|allowedC|intersect/.test(ctx);
      clientTenantTrust.push({ path: r, line: i + 1, intersectedNearby: intersected, code: l.trim().slice(0, 120) });
    }
    // mass assignment: data: body / data: parsed / data: { ...spread
    if (/data:\s*(body|parsed|input)\b/.test(l) || /data:\s*\{\s*\.\.\./.test(l)) {
      massAssign.push({ path: r, line: i + 1, code: l.trim().slice(0, 120) });
    }
    // XSS
    if (/dangerouslySetInnerHTML|\.innerHTML\s*=|javascript:/.test(l)) xssSinks.push({ path: r, line: i + 1, code: l.trim().slice(0, 120) });
    // raw SQL
    if (/\$queryRaw|\$executeRaw/.test(l)) rawSql.push({ path: r, line: i + 1, code: l.trim().slice(0, 120) });
  }
}

// --- File-download route auth ---
const fileRoutes = walk(join(ROOT, "src/app/api")).filter((f) => f.endsWith("route.ts") && /(file|documents)\//.test(rel(f)));
const fileAccess = fileRoutes.map((f) => {
  const t = readFileSync(f, "utf8");
  return {
    route: rel(f),
    authContext: /getCurrentAccessContext|requireUser|getSession|getUser/.test(t),
    scopedLoader: /ForContext|ForScope|allowedClubIds|companyId/.test(t),
    docIdCrosschecked: /docId[\s\S]*expense|expenseId|refundId|invoiceId/.test(t) && /companyId|allowedClubIds|ForContext/.test(t),
    contentDisposition: /Content-Disposition/i.test(t),
    cacheControl: /Cache-Control|no-store|private/i.test(t),
  };
});

// --- Security headers (middleware + next.config) ---
const mw = read("src/middleware.ts") || read("middleware.ts");
const nextcfg = read("next.config.mjs") || read("next.config.js");
const hdr = mw + "\n" + nextcfg;
const headers = {
  csp: /content-security-policy/i.test(hdr),
  cspNonce: /nonce-/.test(hdr) || /nonce/i.test(mw),
  cspUnsafeInline: /'unsafe-inline'/.test(hdr),
  cspUnsafeEval: /'unsafe-eval'/.test(hdr),
  xFrameOptions: /x-frame-options/i.test(hdr),
  frameAncestors: /frame-ancestors/i.test(hdr),
  hsts: /strict-transport-security/i.test(hdr),
  xContentTypeOptions: /x-content-type-options/i.test(hdr),
  referrerPolicy: /referrer-policy/i.test(hdr),
  permissionsPolicy: /permissions-policy/i.test(hdr),
};

const readScope = { idKeyedReads: idReads.length, idReadsUnscopedNearby: idReads.filter((x) => !x.scopedNearby).length, clientTenantTrust, reads: idReads };
const writeScope = { idKeyedWrites: idWrites.length, idWritesNoGuardNearby: idWrites.filter((x) => !x.scopeGuardNearby).length, massAssignment: massAssign, writes: idWrites };
const fileAccessOut = { routes: fileAccess.length, routesMissingAuthContext: fileAccess.filter((x) => !x.authContext).length, headers, xssSinks, rawSql, detail: fileAccess };

const outDir = join(ROOT, "docs/audits/data");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "security-read-scope.json"), JSON.stringify(readScope, null, 2));
writeFileSync(join(outDir, "security-write-scope.json"), JSON.stringify(writeScope, null, 2));
writeFileSync(join(outDir, "file-access-results.json"), JSON.stringify(fileAccessOut, null, 2));

if (!JSON_ONLY) {
  console.log("=== Security scope scan (read-only static; NO DB, NO secrets) ===");
  console.log(`Files touching prisma: ${filesTouchingPrisma}`);
  console.log(`id-keyed READS: ${idReads.length} (no companyId scope in the +/-4 line window: ${readScope.idReadsUnscopedNearby} — VERIFY manually, many are display lookups)`);
  console.log(`id-keyed WRITES: ${idWrites.length} (no scope guard in the +/-4 line window: ${writeScope.idWritesNoGuardNearby} — candidates to verify a preceding guard)`);
  console.log(`client tenant-field trust sites: ${clientTenantTrust.length} (intersected nearby: ${clientTenantTrust.filter((x) => x.intersectedNearby).length})`);
  console.log(`mass-assignment (data:body / data:{...spread}): ${massAssign.length}` + (massAssign.length ? " -> " + massAssign.slice(0, 5).map((m) => m.path + ":" + m.line).join(", ") : ""));
  console.log(`XSS sinks (dangerouslySetInnerHTML/innerHTML/javascript:): ${xssSinks.length}` + (xssSinks.length ? " -> " + xssSinks.map((m) => m.path + ":" + m.line).join(", ") : ""));
  console.log(`raw SQL: ${rawSql.length}` + (rawSql.length ? " -> " + rawSql.map((m) => m.path + ":" + m.line).join(", ") : ""));
  console.log(`file-download routes: ${fileAccess.length} | missing auth-context: ${fileAccessOut.routesMissingAuthContext}`);
  console.log(`headers: CSP ${headers.csp}(nonce ${headers.cspNonce}, unsafe-inline ${headers.cspUnsafeInline}, unsafe-eval ${headers.cspUnsafeEval}) | frame-ancestors ${headers.frameAncestors} | HSTS ${headers.hsts} | X-CTO ${headers.xContentTypeOptions} | Referrer ${headers.referrerPolicy} | Permissions ${headers.permissionsPolicy}`);
  console.log("Wrote security-read-scope.json, security-write-scope.json, file-access-results.json");
}
