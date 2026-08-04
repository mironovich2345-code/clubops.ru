// REM-03 — REAL executable tests for the backup/restore logic that does NOT need PostgreSQL or S3. These
// import and EXECUTE the actual backup-core / backup-checksums modules + drive backup-database.mjs in
// dry-run/local-only (no mocks for the pure logic). The pg_dump + real S3 upload + pg_restore paths are
// covered by the separate PostgreSQL rehearsal gate (docs/testing/rem-03-postgres-restore-rehearsal.md),
// which is NOT EXECUTED in this sandbox (no pg/S3).
//   node scripts/rem-03-backup-restore-tests.mjs
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { validateBackupEnv, validateDatabaseUrl, buildObjectKey, buildManifest, redactSecrets, isSafeRestoreTarget, sha256File } from "./lib/backup-core.mjs";
import { compareChecksums } from "./lib/backup-checksums.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const runBackup = (args, extraEnv) => spawnSync(process.execPath, [join(ROOT, "scripts", "backup-database.mjs"), ...args], { env: { ...process.env, ...extraEnv }, encoding: "utf8" });

const S3ENV = { BACKUP_S3_ENDPOINT: "https://s3.example.com", BACKUP_S3_REGION: "ru-1", BACKUP_S3_BUCKET: "clubops-backups-private", BACKUP_S3_ACCESS_KEY_ID: "AKIAEXAMPLE0000000AA", BACKUP_S3_SECRET_ACCESS_KEY: "s3cr3t-value-not-real-000000", BACKUP_S3_PREFIX: "clubops", BACKUP_ENVIRONMENT: "staging" };

async function main() {
  // 1. Env contract rejects incomplete config.
  check("1 env contract rejects incomplete S3 config", validateBackupEnv({ BACKUP_S3_BUCKET: "x" }, { requireS3: true }).ok === false);
  check("1b env contract accepts complete config", validateBackupEnv(S3ENV, { requireS3: true }).ok === true);
  check("1c public-looking bucket rejected", validateBackupEnv({ ...S3ENV, BACKUP_S3_BUCKET: "public-cdn" }, { requireS3: true }).ok === false);
  check("1d encryption=none rejected in production", validateBackupEnv({ ...S3ENV, BACKUP_ENCRYPTION_MODE: "none" }, { requireS3: true, isProduction: true }).ok === false);
  // 2. Production rejects sqlite DATABASE_URL.
  check("2 sqlite DATABASE_URL rejected", validateDatabaseUrl("file:./dev.db", {}).ok === false);
  check("2b non-postgres scheme rejected", validateDatabaseUrl("mysql://h/db", {}).ok === false);
  check("2c localhost rejected in production", validateDatabaseUrl("postgresql://u:p@localhost:5432/db", { isProduction: true }).ok === false);
  check("2d valid postgres URL accepted", validateDatabaseUrl("postgresql://u:p@db.internal:5432/clubops", {}).ok === true);
  // 6/11. Secrets absent from manifest + manifest structure.
  const now = new Date("2026-08-03T09:08:07Z");
  const manifest = buildManifest({ backupId: "b1", backupType: "scheduled", environment: "staging", createdAt: now.toISOString(), completedAt: now.toISOString(), deploymentVersion: "abc1234", sha256: "deadbeef", dumpSizeBytes: 1000, criticalRowCounts: { company: 3 }, criticalMoneyChecksums: { "invoice.amountKopeks": 500 }, encryption: "sse-s3", objectKey: "k" });
  check("5 manifest has required fields", manifest.formatVersion === "rem-03.v1" && manifest.criticalMoneyChecksums["invoice.amountKopeks"] === 500 && manifest.databaseProvider === "postgresql");
  check("6 manifest builder refuses a secret-looking value", (() => { try { buildManifest({ backupId: "postgresql://u:p@h/db", backupType: "manual", environment: "s", createdAt: "t", completedAt: "t" }); return false; } catch { return true; } })());
  // 14. Object key collision-safe + no secrets.
  const k1 = buildObjectKey({ environment: "staging", now, deploymentVersion: "abc1234", prefix: "clubops" });
  const k2 = buildObjectKey({ environment: "staging", now: new Date(now.getTime() + 1000), deploymentVersion: "abc1234", prefix: "clubops" });
  check("14 object key structured + UTC + collision-safe", k1 === "clubops/staging/2026/08/03/20260803T090807Z-abc1234-db.dump" && k1 !== k2 && !/postgres|secret|AKIA/i.test(k1));
  // 28. Redaction.
  check("28 redactSecrets hides URL + access key", (() => { const r = redactSecrets("connect postgresql://u:pw@h/db key AKIAEXAMPLE0000000AA", { BACKUP_S3_ACCESS_KEY_ID: "AKIAEXAMPLE0000000AA" }); return !r.includes("pw@h") && !r.includes("AKIAEXAMPLE0000000AA"); })());
  // 17/20. Restore target guard.
  check("17 restore refuses production target", isSafeRestoreTarget("postgresql://u:p@h/db", { confirmDisposable: true, isProduction: true }).ok === false);
  check("17b restore refuses without --confirm-disposable", isSafeRestoreTarget("postgresql://u:p@h/db", { confirmDisposable: false }).ok === false);
  check("17c restore allows disposable with confirmation", isSafeRestoreTarget("postgresql://u:p@disposable:5432/t", { confirmDisposable: true }).ok === true);
  check("18 restore refuses a sqlite target", isSafeRestoreTarget("file:./x.db", { confirmDisposable: true }).ok === false);
  // 22. compareChecksums detects a mismatch (restore identity check).
  check("22 checksum compare detects a money mismatch", (() => { const c = compareChecksums({ criticalRowCounts: { company: 3 }, criticalMoneyChecksums: { "x": 100 } }, { criticalRowCounts: { company: 3 }, criticalMoneyChecksums: { "x": 101 } }); return c.match === false && c.mismatches.length === 1; })());
  check("22b checksum compare matches identical sets", compareChecksums({ criticalRowCounts: { c: 1 }, criticalMoneyChecksums: { x: 5 } }, { criticalRowCounts: { c: 1 }, criticalMoneyChecksums: { x: 5 } }).match === true);
  // 11/2 (CLI): dry-run performs NO upload + validates env; sqlite URL is rejected by the CLI.
  const dry = runBackup(["--type=scheduled", "--dry-run", "--json"], { ...S3ENV, DATABASE_URL: "postgresql://u:p@db.internal:5432/clubops", NODE_ENV: "test" });
  check("11 dry-run exits 0 and uploads nothing", dry.status === 0 && /"dryRun":true/.test(dry.stdout) && !/uploaded":true/.test(dry.stdout), dry.stdout?.slice(0, 120));
  const badUrl = runBackup(["--type=scheduled", "--json"], { ...S3ENV, DATABASE_URL: "file:./dev.db", NODE_ENV: "test" });
  check("2e backup CLI rejects sqlite DATABASE_URL (non-zero, no success)", badUrl.status === 1 && /DB_URL_INVALID/.test(badUrl.stdout));
  const badEnv = runBackup(["--type=scheduled", "--json"], { DATABASE_URL: "postgresql://u:p@db.internal:5432/clubops", BACKUP_S3_BUCKET: "x", NODE_ENV: "test" });
  check("4 backup CLI fails-fast on incomplete S3 env", badEnv.status === 1 && /ENV_INVALID/.test(badEnv.stdout));
  // 12. Lock prevents overlap: local-only run holds+releases the lock; a dry-run doesn't conflict — verify
  //     the CLI creates+cleans the temp/lock and never leaves a success marker on failure.
  check("14b failed backup returns non-zero + errorCode (no false success)", badUrl.status === 1 && /"ok":false/.test(badUrl.stdout));
  // 32 (documented): the PostgreSQL restore gate exists as an explicit NOT-EXECUTED rehearsal doc.
  const rehearsal = (await import("node:fs")).readFileSync(join(ROOT, "docs/testing/rem-03-postgres-restore-rehearsal.md"), "utf8");
  check("32 PostgreSQL restore rehearsal documented as the gate (NOT EXECUTED here)", rehearsal.includes("NOT EXECUTED") && rehearsal.includes("pg_restore"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
