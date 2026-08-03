// READ-ONLY (of production) synthetic IDOR / tenant-isolation test (FULL AUDIT 5/6). Operates ONLY
// on a DISPOSABLE COPY of the dev sqlite DB (never production, never the real dev.db) — creates two
// synthetic companies + clubs, exercises the tenant-scoping primitive, then deletes the copy. It
// proves (a) the scoped query pattern isolates tenants and (b) an UNSCOPED findUnique-by-id would
// leak — i.e. isolation depends entirely on the app-level companyId filter (ARCH-005). Emits
// docs/audits/data/idor-results.json.  node scripts/audit-idor-matrix.mjs [--json]
import { PrismaClient } from "@prisma/client";
import { copyFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
const SCRATCH = process.env.CLUBOPS_SCRATCH || join(ROOT, ".idor-scratch.db");
const SRC = join(ROOT, "prisma/dev.db");

const results = [];
const assert = (id, desc, pass, detail = "") => results.push({ id, desc, verdict: pass ? "ISOLATED" : "LEAK", detail });

async function main() {
  if (!existsSync(SRC)) { console.error("dev.db not found — cannot build a disposable copy"); process.exit(1); }
  // Disposable copy — NEVER touch the real dev.db or production.
  rmSync(SCRATCH, { force: true }); rmSync(SCRATCH + "-wal", { force: true }); rmSync(SCRATCH + "-shm", { force: true });
  copyFileSync(SRC, SCRATCH);
  const prisma = new PrismaClient({ datasourceUrl: `file:${SCRATCH}` });
  const TAG = "SECTEST-" + "idor"; // recognizable synthetic marker
  try {
    // --- synthetic 2-tenant data (in the disposable copy only) ---
    const A = await prisma.company.create({ data: { name: `${TAG}-CompanyA` } });
    const B = await prisma.company.create({ data: { name: `${TAG}-CompanyB` } });
    const clubA = await prisma.club.create({ data: { companyId: A.id, name: `${TAG}-ClubA`, city: "X" } });
    const clubB = await prisma.club.create({ data: { companyId: B.id, name: `${TAG}-ClubB`, city: "Y" } });
    // Company A's caller context: selectedCompanyId=A.id, allowedClubIds=[clubA.id].
    const ctxA = { companyId: A.id, allowedClubIds: [clubA.id] };

    // 1. SCOPED read of B's club as A (the app pattern: filter by companyId) → must be null.
    const scopedRead = await prisma.club.findFirst({ where: { id: clubB.id, companyId: ctxA.companyId } });
    assert("IDOR-READ-SCOPED", "A reads B's club via {id, companyId:A} scoped filter", scopedRead === null, "returned " + (scopedRead ? "ROW (LEAK)" : "null"));

    // 2. UNSCOPED read of B's club by raw id → returns the row (proves the filter is the ONLY guard).
    const unscopedRead = await prisma.club.findUnique({ where: { id: clubB.id } });
    assert("IDOR-READ-UNSCOPED", "raw findUnique({id}) WITHOUT companyId returns B's row (demonstrates the scope filter is load-bearing — ARCH-005)", unscopedRead !== null && unscopedRead.companyId === B.id, "raw id read " + (unscopedRead ? "returned B's row → any unscoped loader leaks" : "null"));

    // 3. allowedClubIds intersection: A requests clubB by id but its allowed set is [clubA] → empty.
    const clubScoped = await prisma.club.findMany({ where: { companyId: ctxA.companyId, id: { in: ctxA.allowedClubIds } } });
    const leaksB = clubScoped.some((c) => c.id === clubB.id);
    assert("IDOR-CLUBSCOPE", "A's club list (companyId=A, id in allowedClubIds=[clubA]) never contains clubB", !leaksB, `${clubScoped.length} clubs, contains B: ${leaksB}`);

    // 4. SCOPED write of B's club as A (updateMany with companyId filter) → 0 rows affected.
    const scopedWrite = await prisma.club.updateMany({ where: { id: clubB.id, companyId: ctxA.companyId }, data: { city: "HACKED" } });
    assert("IDOR-WRITE-SCOPED", "A writes B's club via updateMany({id, companyId:A}) affects 0 rows", scopedWrite.count === 0, `updateMany affected ${scopedWrite.count} rows`);

    // 5. UNSCOPED write demonstration (updateMany by raw id) WOULD affect B's row — we verify the
    //    COUNT a raw filter WOULD match, WITHOUT persisting a real value change (set city to its own value).
    const unscopedWriteCount = (await prisma.club.updateMany({ where: { id: clubB.id }, data: { city: clubB.city } })).count;
    assert("IDOR-WRITE-UNSCOPED", "raw updateMany({id}) WITHOUT companyId matches B's row (a mass-assignment/unguarded write would cross tenants)", unscopedWriteCount === 1 ? false : true, `raw id write matched ${unscopedWriteCount} row → unguarded id-keyed writes are cross-tenant capable`);

    // cleanup synthetic rows (belt-and-suspenders; the copy is deleted anyway)
    await prisma.club.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.$disconnect();
  } catch (e) {
    results.push({ id: "IDOR-ERROR", desc: "test harness error", verdict: "ERROR", detail: String(e.message || e).slice(0, 200) });
    try { await prisma.$disconnect(); } catch {}
  } finally {
    rmSync(SCRATCH, { force: true }); rmSync(SCRATCH + "-wal", { force: true }); rmSync(SCRATCH + "-shm", { force: true });
  }

  const leaks = results.filter((r) => r.verdict === "LEAK").length;
  const report = {
    note: "Executed against a DISPOSABLE COPY of the dev sqlite DB (deleted after). Proves the tenant-scoping PRIMITIVE: the scoped {id,companyId} filter isolates tenants, while an unscoped findUnique/update by raw id crosses tenants — so every loader/writer MUST add the companyId/allowedClubIds filter (ARCH-005). The static scanners (security-read/write-scope.json) inventory whether each real site does.",
    tenantsSynthetic: 2, checks: results.length, leaks, results,
  };
  mkdirSync(join(ROOT, "docs/audits/data"), { recursive: true });
  writeFileSync(join(ROOT, "docs/audits/data/idor-results.json"), JSON.stringify(report, null, 2));

  if (!JSON_ONLY) {
    console.log("=== Synthetic IDOR / tenant-isolation test (disposable DB copy; production untouched) ===");
    for (const r of results) console.log(`${r.verdict === "ISOLATED" ? "OK  " : r.verdict === "LEAK" ? "LEAK" : "ERR "} ${r.id}: ${r.desc} — ${r.detail}`);
    console.log(`\n${results.length} checks · ${leaks} isolation leaks`);
    console.log("Interpretation: the SCOPED filter isolates; the UNSCOPED raw-id access crosses tenants by design of SQL — hence every read/write MUST carry the companyId/allowedClubIds filter (ARCH-005). See security-read/write-scope.json for per-site coverage.");
    console.log("Wrote docs/audits/data/idor-results.json");
  }
}
main();
