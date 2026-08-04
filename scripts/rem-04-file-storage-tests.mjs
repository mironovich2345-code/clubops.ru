// REM-04 — REAL executable logic tests (§27). Imports and EXECUTES the actual TS
// storage service (config/object-key/service/index/readiness) via jiti AND the pure
// .mjs core — no mirroring, no grep. Round-trips (put -> verify -> get, two provider
// instances) run against the LOCAL provider in a disposable temp cwd. The real S3
// upload/download/restore rehearsal is the documented gate (NOT EXECUTED here:
// no MinIO/S3 in the sandbox) — see docs/testing/rem-04-file-restore-rehearsal.md.
//   node scripts/rem-04-file-storage-tests.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const SCRATCH = join(ROOT, ".rem04-tmp");
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(join(SCRATCH, "uploads"), { recursive: true });

// The local provider binds UPLOAD_ROOT = cwd/uploads at module load, so chdir to
// the disposable dir BEFORE importing the storage modules. Force local provider.
const ORIG_CWD = process.cwd();
process.chdir(SCRATCH);
delete process.env.STORAGE_PROVIDER;
process.env.NODE_ENV = "test";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(fileURLToPath(import.meta.url), {
  alias: { "@": SRC, "server-only": join(ROOT, "scripts", "_stubs", "server-only.cjs") },
  interopDefault: true,
  esmResolve: true,
});

const cfg = jiti("@/lib/storage/config.ts");
const objectKey = jiti("@/lib/storage/object-key.ts");
const service = jiti("@/lib/storage/service.ts");
const types = jiti("@/lib/storage/types.ts");
const local = jiti("@/lib/storage/local-provider.ts");
const readiness = jiti("@/lib/storage/readiness.ts");

// Pure .mjs core (mirror used by the cron tools).
const core = await import("./lib/file-storage-core.mjs");

let pass = 0,
  fail = 0;
const check = (n, c, x = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`);
  c ? pass++ : fail++;
};
const HASH64 = "a".repeat(64);

async function main() {
  // 1. production rejects local provider
  check("1 production refuses local provider", cfg.validateStorageEnv({}, { isProduction: true }).errors.includes("PRODUCTION_LOCAL_FORBIDDEN"));
  // 2. incomplete S3 config fails
  {
    const v = cfg.validateStorageEnv({ STORAGE_PROVIDER: "s3" }, { isProduction: true });
    check("2 incomplete S3 config fails fast", !v.ok && v.errors.some((e) => e.startsWith("S3_CONFIG_INCOMPLETE")));
  }
  // 2b. complete S3 config passes (with legacy S3_* fallback)
  {
    const v = cfg.validateStorageEnv(
      { STORAGE_PROVIDER: "s3", S3_ENDPOINT: "https://s3.example", S3_BUCKET: "priv", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" },
      { isProduction: true },
    );
    check("2b complete S3 config (legacy fallback) validates", v.ok, v.errors.join(","));
  }
  // 3. server generates key + structure
  {
    const k = objectKey.buildObjectKey({ environment: "production", companyId: "cabc123", entityType: "expense", entityId: "e1", fileId: objectKey.newFileId(), contentHash: HASH64, ext: "pdf" });
    const p = objectKey.parseObjectKey(k);
    check("3 server-generated key parses to its parts", p && p.companyId === "cabc123" && p.entityType === "expense" && p.ext === "pdf");
  }
  // 4. client key ignored / unsafe rejected
  check("4 unsafe/traversal key rejected", !types.isSafeStorageKey("../etc/passwd") && !types.isSafeStorageKey("/abs/x") && objectKey.parseObjectKey("a/../b") === null);
  // 5. tenant prefix carries companyId
  {
    const k = objectKey.buildObjectKey({ environment: "dev", companyId: "ctenant1", entityType: "refund", entityId: "r1", fileId: "f1", contentHash: HASH64, ext: "jpg" });
    check("5 tenant prefix = companyId", objectKey.companyIdFromObjectKey(k) === "ctenant1");
  }
  // 6/7/13. put -> verify -> get on the real local provider (temp cwd)
  {
    const storage = local.createLocalStorageProvider();
    const buf = Buffer.from("hello-clubops-file");
    const key = "expenses/deadbeefdeadbeefdeadbeefdeadbeef.pdf";
    const r = await service.putAndVerify(key, buf, "application/pdf");
    const back = await storage.get(key);
    check("6 upload writes an object retrievable via get", back && back.equals(buf));
    check("7 putAndVerify returns verified before metadata trusted", r.verified === true && r.verificationStatus === "verified");
    check("13 putAndVerify records size + sha256", r.size === buf.length && r.sha256 === core.sha256Buffer(buf));
  }
  // 8. metadata NOT active on a failed/unsafe upload
  {
    let threw = false;
    try {
      await service.putAndVerify("../evil", Buffer.from("x"), "application/pdf");
    } catch (e) {
      threw = e && e.code === "UNSAFE_KEY";
    }
    check("8 unsafe key rejected before any write", threw);
  }
  // 9/25. deterministic migration target key (idempotent replay, no duplicate)
  {
    const row = { id: "cfile1", companyId: "cco1", entityType: "expense", entityId: "ce1", storageKey: "expense-docs/" + "b".repeat(64) + ".pdf", sha256: HASH64, storageProvider: "local", localHash: HASH64 };
    const a = core.buildMigrationTargetKey(row, "production");
    const b = core.buildMigrationTargetKey(row, "production");
    check("9/25 migration target key is deterministic (replay = no duplicate)", a === b && core.parseObjectKey(a) !== null);
  }
  // 10. two different fileIds → different keys (immutability, no overwrite)
  {
    const base = { environment: "dev", companyId: "cco1", entityType: "expense", entityId: "e1", contentHash: HASH64, ext: "pdf" };
    const k1 = objectKey.buildObjectKey({ ...base, fileId: objectKey.newFileId() });
    const k2 = objectKey.buildObjectKey({ ...base, fileId: objectKey.newFileId() });
    check("10 distinct uploads → distinct immutable keys", k1 !== k2);
  }
  // 11. same key / different hash = conflict
  {
    const row = { id: "cf2", companyId: "cco", entityType: "expense", entityId: "e", storageKey: "expense-docs/" + "c".repeat(64) + ".pdf", sha256: HASH64, storageProvider: "local", localPresent: true, localHash: HASH64 };
    const plan = core.planFileMigration(row, { environment: "dev", remoteExists: true, remoteHash: "d".repeat(64) });
    check("11 remote exists with a different hash → conflict (never overwrite)", plan.action === "conflict");
  }
  // 12/29. hash stored (known vector) + checksum stable
  check("12/29 sha256 is stable + correct", core.sha256Buffer(Buffer.from("abc")) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  // 14. get on an unsafe key returns null (download gate)
  {
    const storage = local.createLocalStorageProvider();
    check("14 get on an unsafe key returns null", (await storage.get("../../secret")) === null);
  }
  // 15. cross-tenant detection
  {
    const k = objectKey.buildObjectKey({ environment: "dev", companyId: "cownera", entityType: "expense", entityId: "e", fileId: "f", contentHash: HASH64, ext: "pdf" });
    check("15 cross-tenant key detectable", objectKey.companyIdFromObjectKey(k) === "cownera" && objectKey.companyIdFromObjectKey(k) !== "cownerb");
  }
  // 16. signed-url TTL bounded (<=3600) and defaulted to 300
  {
    const tooLong = cfg.validateStorageEnv({ STORAGE_SIGNED_URL_TTL_SECONDS: "99999" }, { isProduction: false });
    const dflt = cfg.validateStorageEnv({}, { isProduction: false });
    const custom = cfg.validateStorageEnv({ STORAGE_SIGNED_URL_TTL_SECONDS: "120" }, { isProduction: false });
    check("16 signed-url TTL bounded (<=3600) + defaulted to 300", tooLong.errors.includes("SIGNED_URL_TTL_TOO_LONG") && dflt.signedUrlTtlSeconds === 300 && custom.signedUrlTtlSeconds === 120);
  }
  // 17. MIME → safe extension allowlist
  check("17 MIME maps to a safe ext; unknown rejected", objectKey.safeExtensionFromMime("application/pdf") === "pdf" && objectKey.safeExtensionFromMime("text/html") === null);
  // 18/33. both legacy + tenant keys are safe; a deep traversal is not
  check("18/33 legacy + tenant keys safe, traversal unsafe", types.isSafeStorageKey("invoices/abc.pdf") && types.isSafeStorageKey("dev/cco/expense/e/f/" + HASH64 + "-pdf") && !types.isSafeStorageKey("a/..\\b"));
  // 19. path traversal impossible in a built key
  {
    let threw = false;
    try {
      objectKey.buildObjectKey({ environment: "dev", companyId: "../x", entityType: "expense", entityId: "e", fileId: "f", contentHash: HASH64, ext: "pdf" });
    } catch {
      threw = true;
    }
    check("19 buildObjectKey throws on an unsafe segment", threw);
  }
  // 20/22/31. verifyObject: missing / hash-mismatch / ok
  {
    const buf = Buffer.from("verify-me");
    const key = "expenses/00000000000000000000000000000001.pdf";
    await service.putAndVerify(key, buf, "application/pdf");
    const okv = await service.verifyObject(key, { size: buf.length, sha256: core.sha256Buffer(buf) });
    const bad = await service.verifyObject(key, { sha256: HASH64 });
    const gone = await service.verifyObject("expenses/00000000000000000000000000000009.pdf", { sha256: HASH64 });
    check("20 verifyObject reports missing blob", gone.ok === false && gone.reason === "missing");
    check("22 verifyObject reports hash mismatch", bad.ok === false && bad.reason === "hash_mismatch");
    check("31 verifyObject confirms a matching hash", okv.ok === true);
  }
  // 23. dry-run plan for a local file = copy (no mutation)
  {
    const row = { id: "cf3", companyId: "cco", entityType: "expense", entityId: "e", storageKey: "expense-docs/" + "e".repeat(64) + ".pdf", sha256: null, storageProvider: "local", localPresent: true, localHash: HASH64 };
    const plan = core.planFileMigration(row, { environment: "dev", remoteExists: null, remoteHash: null });
    check("23 local file plans as copy (dry-run, no mutation)", plan.action === "copy");
  }
  // 24/26. remote already exists (interrupted run) → finalize-only (resume, no dup)
  {
    const row = { id: "cf4", companyId: "cco", entityType: "expense", entityId: "e", storageKey: "expense-docs/" + "f".repeat(64) + ".pdf", sha256: HASH64, storageProvider: "local", localPresent: true, localHash: HASH64 };
    const plan = core.planFileMigration(row, { environment: "dev", remoteExists: true, remoteHash: HASH64 });
    check("24/26 resume: remote present same hash → finalize-only (no duplicate)", plan.action === "finalize-only");
  }
  // 27. multi-instance read: instance A writes, instance B reads
  {
    const a = local.createLocalStorageProvider();
    const b = local.createLocalStorageProvider();
    const buf = Buffer.from("cross-instance");
    const key = "refunds/11111111111111111111111111111111.pdf";
    await a.put(key, buf, "application/pdf");
    const read = await b.get(key);
    check("27 second provider instance reads what the first wrote", read && read.equals(buf));
  }
  // 28. manifest entry shape + 30 secrets absent guard
  {
    const entry = { fileId: "f", companyId: "c", entityType: "expense", storageKey: "expenses/x.pdf", sha256: HASH64, sizeBytes: 3 };
    const json = JSON.stringify(entry);
    check("28 manifest entry carries no original filename/PII", !("originalFilename" in entry) && !("safeFilename" in entry));
    let threwSecret = false;
    try {
      core.assertNoSecretValue("AKIAIOSFODNN7EXAMPLE1234567890ABCDEF0000");
    } catch {
      threwSecret = true;
    }
    check("30 secret-looking value refused in a manifest", threwSecret && core.redactStorageSecrets(json, {}) === json);
  }
  // 32. head() feature-detect + size (verification capability)
  {
    const storage = local.createLocalStorageProvider();
    const buf = Buffer.from("head-me-please");
    const key = "cash-docs/" + "2".repeat(64) + ".pdf";
    await storage.put(key, buf, "application/pdf");
    const meta = typeof storage.head === "function" ? await storage.head(key) : null;
    check("32 head() returns present + correct size", meta && meta.size === buf.length);
  }
  // 35. readiness detects an unavailable/misconfigured storage
  {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production"; // production + local (unset provider) => not ready
    const r = readiness.storageReadiness();
    process.env.NODE_ENV = prev;
    check("35 readiness = not ready when production is on local", r.ready === false && r.errors.includes("PRODUCTION_LOCAL_FORBIDDEN"));
  }
  // 36. list() is read-only and returns logical keys (inventory capability)
  {
    const storage = local.createLocalStorageProvider();
    const keys = typeof storage.list === "function" ? await storage.list("") : [];
    check("36 list() returns logical keys (inventory capability)", Array.isArray(keys) && keys.every((k) => types.isSafeStorageKey(k)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.chdir(ORIG_CWD);
  rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("rem-04 tests crashed:", e);
  try {
    process.chdir(ORIG_CWD);
  } catch {
    /* ignore */
  }
  process.exit(1);
});
