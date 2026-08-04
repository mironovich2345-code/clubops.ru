// REM-04 — READ-ONLY file-storage preflight (§28). A fast go/no-go before a
// migration or a production storage cutover. SELECT + fs stat only; NO writes.
//   node --env-file=.env scripts/preflight-file-storage.mjs [--json]
//
// It answers: is the storage env valid for this environment, are there missing or
// orphan blobs, duplicate keys, unsafe keys, cross-tenant prefixes, unsupported
// extensions, stale pending uploads, or files still on local storage? It reuses the
// exact contract logic the app enforces. Storage keys are never printed raw.
import { PrismaClient } from "@prisma/client";
import { stat, readdir } from "node:fs/promises";
import { join, sep, relative } from "node:path";
import { createHash } from "node:crypto";
import { validateStorageEnv, isSafeStorageKey, parseObjectKey, keyExtension, ALLOWED_EXTS } from "./lib/file-storage-core.mjs";

const prisma = new PrismaClient();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const UPLOAD_ROOT = join(ROOT, "uploads");
const JSON_ONLY = process.argv.includes("--json");
const isProduction = process.env.NODE_ENV === "production";
const checks = [];
const add = (id, title, sev, ok, detail = "") => checks.push({ id, title, severity: sev, ok, detail });

function keyHash(k) {
  return createHash("sha256").update(String(k)).digest("hex").slice(0, 12);
}
async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile()) out.push(relative(UPLOAD_ROOT, full).split(sep).join("/"));
  }
}

async function main() {
  // 0. env contract for THIS environment
  const env = validateStorageEnv(process.env, { isProduction });
  add("PF-00", "storage env contract valid for this environment", "S0", env.ok, env.ok ? env.provider : env.errors.join(";"));

  const rows = [];
  const push = (model, r, companyId) =>
    rows.push({ model, id: r.id, storageKey: r.storageKey, companyId: companyId ?? r.companyId ?? null, removed: Boolean(r.removedAt), storageProvider: r.storageProvider ?? null, migrationStatus: r.migrationStatus ?? null, createdAt: r.createdAt ?? null });
  for (const r of await prisma.expenseDocument.findMany()) push("ExpenseDocument", r);
  for (const r of await prisma.refundDocument.findMany()) push("RefundDocument", r);
  for (const r of await prisma.cashOperationDocument.findMany()) push("CashOperationDocument", r);
  for (const r of await prisma.salesReportDocument.findMany({ include: { report: { select: { companyId: true } } } })) push("SalesReportDocument", r, r.report?.companyId);
  const withKey = rows.filter((r) => r.storageKey);

  const blobs = [];
  await walk(UPLOAD_ROOT, blobs);
  const referenced = new Set(withKey.map((r) => r.storageKey));

  // 1. missing blobs
  let missing = 0;
  for (const r of withKey) {
    if (r.removed) continue;
    try {
      if (!(await stat(join(UPLOAD_ROOT, r.storageKey))).isFile()) missing++;
    } catch {
      missing++;
    }
  }
  add("PF-01", "no missing blobs for live metadata", "S1", missing === 0, `missing=${missing}`);

  // 2. orphan blobs
  const orphans = blobs.filter((k) => !referenced.has(k)).length;
  add("PF-02", "no orphan blobs on storage", "S2", orphans === 0, `orphans=${orphans}`);

  // 3. duplicate keys
  const seen = new Set();
  let dup = 0;
  for (const r of withKey) {
    if (seen.has(r.storageKey)) dup++;
    else seen.add(r.storageKey);
  }
  add("PF-03", "no duplicate storage keys", "S1", dup === 0, `dup=${dup}`);

  // 4. unsafe keys
  const unsafe = withKey.filter((r) => !isSafeStorageKey(r.storageKey)).length;
  add("PF-04", "all storage keys are safe/well-formed", "S0", unsafe === 0, `unsafe=${unsafe}`);

  // 5. cross-tenant prefix
  let cross = 0;
  for (const r of withKey) {
    const p = parseObjectKey(r.storageKey);
    if (p && r.companyId && p.companyId !== r.companyId) cross++;
  }
  add("PF-05", "no cross-tenant key prefixes", "S0", cross === 0, `cross=${cross}`);

  // 6. unsupported extension
  const badExt = withKey.filter((r) => !ALLOWED_EXTS.has(keyExtension(r.storageKey))).length;
  add("PF-06", "all key extensions supported", "S2", badExt === 0, `badExt=${badExt}`);

  // 7. stale pending
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const stale = withKey.filter((r) => r.migrationStatus === "pending" && r.createdAt && new Date(r.createdAt).getTime() < dayAgo).length;
  add("PF-07", "no migrations stuck pending > 24h", "S2", stale === 0, `stale=${stale}`);

  // 8. local metadata in production
  const localInProd = isProduction ? withKey.filter((r) => r.storageProvider === "local").length : 0;
  add("PF-08", "no local-provider files in production", "S1", localInProd === 0, `localInProd=${localInProd}`);

  // 9. migration readiness — every live file resolvable on disk (local) for a copy
  add("PF-09", "migration source readable (local blobs resolvable)", "S2", missing === 0, `missing=${missing}`);

  const failed = checks.filter((c) => !c.ok && (c.severity === "S0" || c.severity === "S1"));
  if (JSON_ONLY) {
    console.log(JSON.stringify({ environment: isProduction ? "production" : "non-production", totals: { withKey: withKey.length, blobs: blobs.length }, checks }, null, 2));
  } else {
    console.log(`File-storage preflight — ${withKey.length} keyed rows, ${blobs.length} blobs`);
    for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.severity} ${c.id} ${c.title} (${c.detail})`);
    console.log(failed.length ? `\n${failed.length} blocking issue(s).` : "\nNo blocking issues.");
  }
  await prisma.$disconnect();
  process.exit(failed.length ? 2 : 0);
}

main().catch(async (e) => {
  console.error("preflight failed:", String(e.message || e).slice(0, 300));
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
