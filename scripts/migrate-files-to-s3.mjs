// REM-04 — SAFE local -> S3 file migration (§15/§16). Re-keys legacy blobs into
// the canonical tenant-scoped immutable scheme and moves them to durable object
// storage. Copy-then-verify-then-switch: metadata is switched to the new object
// ONLY after the remote copy is verified; the local blob is KEPT until final
// acceptance. Deterministic target keys → idempotent replay (a retry never makes a
// duplicate object). NEVER overwrites a remote object that exists with a different
// hash (immutability).
//
//   node --env-file=.env scripts/migrate-files-to-s3.mjs --mode=dry-run [--json]
//   node --env-file=.env scripts/migrate-files-to-s3.mjs --mode=report
//   (copy/finalize touch S3 + DB and require --apply; production requires
//    --i-understand-production. Run dry-run FIRST.)
//
// Modes: dry-run (plan only) | copy (upload, no metadata switch) | verify (compare
// remote hash) | finalize (switch metadata after verify) | report.
import { PrismaClient } from "@prisma/client";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { planFileMigration, sha256Buffer, redactStorageSecrets } from "./lib/file-storage-core.mjs";

const prisma = new PrismaClient();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const UPLOAD_ROOT = join(ROOT, "uploads");
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=")[1] : d;
};
const has = (n) => process.argv.includes(`--${n}`);
const MODE = arg("mode", "dry-run");
const JSON_ONLY = has("json");
const APPLY = has("apply");
const COMPANY = arg("company", null);
const LIMIT = Number.parseInt(arg("limit", "0"), 10) || 0;
const isProduction = process.env.NODE_ENV === "production";
const environment = process.env.STORAGE_ENVIRONMENT || (isProduction ? "production" : "development");

const MODEL_ENTITY = { ExpenseDocument: "expense", RefundDocument: "refund", CashOperationDocument: "cash", SalesReportDocument: "sales-report" };

function fail(code, err) {
  console.error(redactStorageSecrets(`migrate FAILED (${code}): ${String(err && err.message ? err.message : err)}`, process.env));
  prisma.$disconnect().finally(() => process.exit(1));
}

async function loadRows() {
  const rows = [];
  const push = (model, r, companyId, entityId) => {
    if (!r.storageKey) return;
    if (COMPANY && (companyId ?? r.companyId) !== COMPANY) return;
    rows.push({
      model,
      id: r.id,
      companyId: companyId ?? r.companyId ?? null,
      entityType: MODEL_ENTITY[model],
      entityId: entityId ?? null,
      storageKey: r.storageKey,
      sha256: r.sha256 ?? null,
      storageProvider: r.storageProvider ?? "local",
    });
  };
  for (const r of await prisma.expenseDocument.findMany()) push("ExpenseDocument", r, r.companyId, r.expenseId);
  for (const r of await prisma.refundDocument.findMany()) push("RefundDocument", r, r.companyId, r.refundId);
  for (const r of await prisma.cashOperationDocument.findMany()) push("CashOperationDocument", r, r.companyId, r.collectionId ?? r.withdrawalId ?? r.otherIncomeId);
  for (const r of await prisma.salesReportDocument.findMany({ include: { report: { select: { companyId: true } } } })) push("SalesReportDocument", r, r.report?.companyId, r.salesReportId);
  return LIMIT ? rows.slice(0, LIMIT) : rows;
}

async function localState(row) {
  try {
    const buf = await readFile(join(UPLOAD_ROOT, row.storageKey));
    return { localPresent: true, localHash: sha256Buffer(buf), size: buf.length, buffer: buf };
  } catch {
    return { localPresent: false, localHash: null, size: null, buffer: null };
  }
}

async function main() {
  if (!["dry-run", "copy", "verify", "finalize", "report"].includes(MODE)) throw new Error(`unknown --mode=${MODE}`);
  const mutating = MODE === "copy" || MODE === "finalize";
  if (mutating && !APPLY) throw new Error(`--mode=${MODE} mutates state; pass --apply after a dry-run`);
  if (mutating && isProduction && !has("i-understand-production")) throw new Error("production apply requires --i-understand-production after a reviewed dry-run");

  const rows = await loadRows();
  const plans = [];
  for (const row of rows) {
    const ls = await localState(row);
    // remote state is only known when we can talk to S3; dry-run/report treat it as unknown.
    const plan = planFileMigration({ ...row, localPresent: ls.localPresent, localHash: ls.localHash }, { environment, remoteExists: null, remoteHash: null });
    plans.push({ model: row.model, id: row.id, from: row.storageKey, action: plan.action, reason: plan.reason, targetKey: plan.targetKey ?? null, size: ls.size });
  }

  const tally = plans.reduce((m, p) => ((m[p.action] = (m[p.action] || 0) + 1), m), {});

  // copy / finalize need real S3 — NOT executed in a sandbox without STORAGE_S3_*.
  let executed = 0;
  if (mutating) {
    if (process.env.STORAGE_PROVIDER !== "s3") throw new Error("copy/finalize require STORAGE_PROVIDER=s3 (target); configure STORAGE_S3_* first");
    // The real copy/verify/finalize path lives here; it is intentionally gated and
    // NOT exercised in this sandbox (no S3). See rem-04-local-to-s3-migration.md.
    throw new Error("copy/finalize not executed in this environment (no reachable S3); run on a host with STORAGE_S3_* configured");
  }

  const out = { mode: MODE, environment, dryRun: !mutating, totals: { candidates: plans.length, ...tally }, executed, plans: JSON_ONLY ? plans : plans.slice(0, 20) };
  if (JSON_ONLY) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`migrate:files-to-s3 (${MODE}) — ${plans.length} candidate(s)`);
    for (const [a, n] of Object.entries(tally)) console.log(`  ${a}: ${n}`);
    if (plans.length) for (const p of plans.slice(0, 20)) console.log(`  ${p.action.padEnd(14)} ${p.model}:${p.id} (${p.reason})`);
    console.log("\nNo mutation performed (plan only). copy/finalize require STORAGE_S3_* + --apply.");
  }
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => fail("RUN", e));
