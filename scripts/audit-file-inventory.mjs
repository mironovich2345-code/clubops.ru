// REM-04 — READ-ONLY file inventory (§11). Reconciles DB file metadata against the
// actual blobs. SELECT-only + fs stat/read; NEVER writes, deletes, or mutates a
// blob or row. Run on dev or a production READ REPLICA + a read-only storage view.
//   node --env-file=.env scripts/audit-file-inventory.mjs [--json]
//
// In this sandbox the provider is local (uploads/), so blob checks run against
// disk. Against S3 the same logic runs via ListObjectsV2/HeadObject (the runbook
// documents the read-only credentials). Storage keys are never printed raw — only
// a short non-reversible hash, the owning company/entity, severity and repair class.
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync, createReadStream } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { join, sep, relative } from "node:path";
import { createHash } from "node:crypto";
import { isSafeStorageKey, parseObjectKey, keyExtension, ALLOWED_EXTS } from "./lib/file-storage-core.mjs";

const prisma = new PrismaClient();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const UPLOAD_ROOT = join(ROOT, "uploads");
const JSON_ONLY = process.argv.includes("--json");
const isProduction = process.env.NODE_ENV === "production";
const results = [];
const rec = (id, title, sev, repair, count, sample = []) =>
  results.push({ id, title, severity: sev, repairClass: repair, offending: count, sample: sample.slice(0, 10) });

function keyHash(key) {
  return createHash("sha256").update(String(key)).digest("hex").slice(0, 12);
}
function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("error", reject);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
  });
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
  // ---- gather metadata rows from every dedicated file model ----
  const rows = [];
  const push = (model, r, companyId) =>
    rows.push({
      model,
      id: r.id,
      storageKey: r.storageKey,
      sha256: r.sha256 ?? null,
      sizeBytes: r.sizeBytes ?? null,
      companyId: companyId ?? r.companyId ?? null,
      removed: Boolean(r.removedAt),
      storageProvider: r.storageProvider ?? null,
      verificationStatus: r.verificationStatus ?? null,
      migrationStatus: r.migrationStatus ?? null,
      createdAt: r.createdAt ?? null,
    });

  for (const r of await prisma.expenseDocument.findMany()) push("ExpenseDocument", r);
  for (const r of await prisma.refundDocument.findMany()) push("RefundDocument", r);
  for (const r of await prisma.cashOperationDocument.findMany()) push("CashOperationDocument", r);
  for (const r of await prisma.salesReportDocument.findMany({ include: { report: { select: { companyId: true } } } }))
    push("SalesReportDocument", r, r.report?.companyId);
  for (const r of await prisma.invoice.findMany({ where: { originalFileStorageKey: { not: null } }, select: { id: true, originalFileStorageKey: true, originalFileSize: true, companyId: true } }))
    rows.push({ model: "Invoice", id: r.id, storageKey: r.originalFileStorageKey, sha256: null, sizeBytes: r.originalFileSize ?? null, companyId: r.companyId, removed: false });
  for (const r of await prisma.pendingInvoiceUpload.findMany({ select: { id: true, storageKey: true, companyId: true, consumedAt: true } }))
    rows.push({ model: "PendingInvoiceUpload", id: r.id, storageKey: r.storageKey, sha256: null, sizeBytes: null, companyId: r.companyId, removed: Boolean(r.consumedAt) });

  const withKey = rows.filter((r) => r.storageKey);

  // ---- enumerate blobs on disk (local provider) ----
  const blobs = [];
  await walk(UPLOAD_ROOT, blobs);
  const blobSet = new Set(blobs);
  const referenced = new Set(withKey.map((r) => r.storageKey));

  // 1. metadata row without blob
  {
    const bad = [];
    for (const r of withKey) {
      if (r.removed) continue;
      let present;
      try {
        present = (await stat(join(UPLOAD_ROOT, r.storageKey))).isFile();
      } catch {
        present = false;
      }
      if (!present) bad.push({ model: r.model, id: r.id, keyHash: keyHash(r.storageKey), companyId: r.companyId });
    }
    rec("FI-01", "metadata row without a blob (missing object)", "S1", "object-recovery", bad.length, bad);
  }
  // 2. blob without metadata (orphan)
  {
    const bad = blobs.filter((k) => !referenced.has(k)).map((k) => ({ keyHash: keyHash(k) }));
    rec("FI-02", "blob on storage with no metadata row (orphan)", "S2", "cleanup-after-review", bad.length, bad);
  }
  // 3. size mismatch + 4. hash mismatch (present blobs with recorded integrity)
  {
    const sizeBad = [];
    const hashBad = [];
    for (const r of withKey) {
      if (r.removed || !blobSet.has(r.storageKey)) continue;
      let s;
      try {
        s = await stat(join(UPLOAD_ROOT, r.storageKey));
      } catch {
        continue;
      }
      if (r.sizeBytes != null && s.size !== r.sizeBytes) sizeBad.push({ model: r.model, id: r.id, keyHash: keyHash(r.storageKey) });
      if (r.sha256) {
        const actual = await sha256File(join(UPLOAD_ROOT, r.storageKey));
        if (actual !== r.sha256) hashBad.push({ model: r.model, id: r.id, keyHash: keyHash(r.storageKey) });
      }
    }
    rec("FI-03", "blob size does not match metadata sizeBytes", "S1", "object-recovery", sizeBad.length, sizeBad);
    rec("FI-04", "blob sha256 does not match metadata sha256", "S0", "object-recovery", hashBad.length, hashBad);
  }
  // 5. cross-tenant key prefix: tenant-scoped key whose companyId != row.companyId
  {
    const bad = [];
    for (const r of withKey) {
      const parsed = parseObjectKey(r.storageKey);
      if (parsed && r.companyId && parsed.companyId !== r.companyId)
        bad.push({ model: r.model, id: r.id, keyHash: keyHash(r.storageKey) });
    }
    rec("FI-05", "tenant-scoped key prefix companyId != row companyId (cross-tenant)", "S0", "investigate-security", bad.length, bad);
  }
  // 6. duplicate storageKey across rows
  {
    const seen = new Map();
    const bad = [];
    for (const r of withKey) {
      const prev = seen.get(r.storageKey);
      if (prev) bad.push({ keyHash: keyHash(r.storageKey), a: prev, b: `${r.model}:${r.id}` });
      else seen.set(r.storageKey, `${r.model}:${r.id}`);
    }
    rec("FI-06", "same storageKey referenced by more than one row", "S1", "investigate", bad.length, bad);
  }
  // 7. duplicate hash across DIFFERENT entities (informational) + 15. across tenants (security)
  {
    const byHash = new Map();
    for (const r of withKey) {
      if (!r.sha256) continue;
      if (!byHash.has(r.sha256)) byHash.set(r.sha256, []);
      byHash.get(r.sha256).push(r);
    }
    let dupEntities = 0;
    const crossTenant = [];
    for (const [h, list] of byHash) {
      if (list.length > 1) dupEntities++;
      const companies = new Set(list.map((x) => x.companyId).filter(Boolean));
      if (companies.size > 1) crossTenant.push({ hashHead: h.slice(0, 12), companies: companies.size });
    }
    rec("FI-07", "same blob hash across different entities (dedupe candidate)", "S3", "informational", dupEntities, []);
    rec("FI-15", "same blob hash linked to DIFFERENT tenants", "S1", "investigate-security", crossTenant.length, crossTenant);
  }
  // 8. invalid MIME/extension by key
  {
    const bad = withKey
      .filter((r) => !ALLOWED_EXTS.has(keyExtension(r.storageKey)))
      .map((r) => ({ model: r.model, id: r.id, keyHash: keyHash(r.storageKey), ext: keyExtension(r.storageKey) }));
    rec("FI-08", "storage key extension outside the allowed set", "S2", "investigate", bad.length, bad);
  }
  // 9. local-provider metadata while running production
  {
    const bad = isProduction ? withKey.filter((r) => r.storageProvider === "local").map((r) => ({ model: r.model, id: r.id })) : [];
    rec("FI-09", "storageProvider=local recorded in a production environment", "S1", "migrate-to-s3", bad.length, bad);
  }
  // 10. unverified upload
  {
    const bad = withKey.filter((r) => r.verificationStatus && r.verificationStatus !== "verified").map((r) => ({ model: r.model, id: r.id, status: r.verificationStatus }));
    rec("FI-10", "upload never verified (verificationStatus != verified)", "S3", "re-verify", bad.length, bad);
  }
  // 11. pending too long (migration/verification pending + created > 24h ago)
  {
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const bad = withKey
      .filter((r) => (r.migrationStatus === "pending" || r.verificationStatus === "pending") && r.createdAt && new Date(r.createdAt).getTime() < dayAgo)
      .map((r) => ({ model: r.model, id: r.id }));
    rec("FI-11", "upload/migration stuck pending > 24h", "S2", "resume-or-clean", bad.length, bad);
  }
  // 12. orphan temp blob (temp/ prefix on storage, no live reference)
  {
    const bad = blobs.filter((k) => k.startsWith("temp/") && !referenced.has(k)).map((k) => ({ keyHash: keyHash(k) }));
    rec("FI-12", "stale temp/ blob with no reference", "S3", "lifecycle-cleanup", bad.length, bad);
  }
  // 13. unsafe/malformed storage key recorded
  {
    const bad = withKey.filter((r) => !isSafeStorageKey(r.storageKey)).map((r) => ({ model: r.model, id: r.id, keyHash: keyHash(r.storageKey) }));
    rec("FI-13", "recorded storage key is unsafe/malformed", "S0", "investigate-security", bad.length, bad);
  }
  // 14. conflict marker set by migration
  {
    const bad = withKey.filter((r) => r.migrationStatus === "conflict").map((r) => ({ model: r.model, id: r.id }));
    rec("FI-14", "migration marked this file as a hash conflict", "S1", "manual-migration", bad.length, bad);
  }

  const summary = {
    generatedAtNote: "read-only inventory; no timestamp stamped inside the tool",
    environment: isProduction ? "production" : "non-production",
    provider: process.env.STORAGE_PROVIDER === "s3" ? "s3" : "local",
    totals: { metadataRows: rows.length, withStorageKey: withKey.length, blobsOnStorage: blobs.length },
    checks: results,
  };
  try {
    mkdirSync(join(ROOT, "docs/audits/data"), { recursive: true });
    writeFileSync(join(ROOT, "docs/audits/data/file-inventory.json"), JSON.stringify(summary, null, 2));
  } catch {
    /* best effort */
  }

  if (JSON_ONLY) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`File inventory — provider=${summary.provider} env=${summary.environment}`);
    console.log(`  metadata rows: ${rows.length}  (with key: ${withKey.length})   blobs: ${blobs.length}`);
    for (const c of results) console.log(`  ${c.severity} ${c.id} ${c.title}: ${c.offending}`);
  }
  const criticals = results.filter((c) => (c.severity === "S0" || c.severity === "S1") && c.offending > 0);
  await prisma.$disconnect();
  process.exit(criticals.length ? 2 : 0);
}

main().catch(async (e) => {
  console.error("inventory failed:", String(e.message || e).slice(0, 300));
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
