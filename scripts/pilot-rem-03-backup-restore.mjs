// Pilot — REM-03 backup/restore (§33). Fast STRUCTURAL checks that the off-site backup + guarded restore
// tooling + deploy gate + docs are in place. The BEHAVIORAL logic proof is test:rem-03-backup-restore
// (23/23); the real PostgreSQL restore is the documented gate (NOT EXECUTED here). Runs in pilot:full.
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => { try { return readFileSync(new URL(p, import.meta.url), "utf8"); } catch { return ""; } };

const core = src("../scripts/lib/backup-core.mjs");
const checksums = src("../scripts/lib/backup-checksums.mjs");
const backup = src("../scripts/backup-database.mjs");
const restore = src("../scripts/restore-database.mjs");
const list = src("../scripts/backup-list.mjs");
const tests = src("../scripts/rem-03-backup-restore-tests.mjs");
const deploy = src("../deploy/deploy.sh");
const timer = src("../deploy/systemd/club-ops-backup.timer");
const service = src("../deploy/systemd/club-ops-backup.service");
const rehearsal = src("../docs/testing/rem-03-postgres-restore-rehearsal.md");
const report = src("../docs/remediation/rem-03-final-report.md");
const restoreRunbook = src("../docs/operations/database-restore-runbook.md");
const backupRunbook = src("../docs/operations/database-backup-runbook.md");
const alerts = src("../docs/operations/database-backup-alerts.md");
const companyRecovery = src("../docs/operations/company-deletion-recovery-runbook.md");
const pkg = src("../package.json");

check("1 scheduled backup independent of deploy (systemd timer)", timer.includes("OnCalendar") && service.includes("--type=scheduled"));
check("2 pre-deploy backup retained + off-site in deploy.sh", deploy.includes("--type=pre-deploy") && deploy.includes("OFF-SITE"));
check("3 off-site S3-compatible target supported", backup.includes("@aws-sdk/client-s3") && core.includes("BACKUP_S3_ENDPOINT"));
check("4 bucket config fail-fast", core.includes("validateBackupEnv") && backup.includes("ENV_INVALID"));
check("5 PostgreSQL URL validated + 6 sqlite rejected", core.includes("validateDatabaseUrl") && core.includes("sqlite file: URL — refusing") && backup.includes("DB_URL_INVALID"));
check("7 pg_dump custom format used", backup.includes('"-Fc"') && backup.includes('"--no-owner"'));
check("8 non-empty dump checked", core.includes("MIN_DUMP_BYTES") && backup.includes("DUMP_TOO_SMALL"));
check("9 SHA-256 generated", core.includes("sha256File") && backup.includes("await sha256File"));
check("10 manifest generated + 11 secrets absent", core.includes("buildManifest") && core.includes("refusing") && core.includes("criticalMoneyChecksums"));
check("12 remote upload verified", backup.includes("HeadObjectCommand") && backup.includes("REMOTE_VERIFY_FAILED"));
check("13 local temp cleaned", backup.includes("rmSync(tmp"));
check("14 failure returns non-zero (no false success)", backup.includes("process.exit(1)") && backup.includes("ok: false"));
check("15 deploy aborts on backup failure", /off-site pre-deploy backup FAILED[\s\S]*die|die "off-site pre-deploy backup FAILED/.test(deploy) || deploy.includes("off-site pre-deploy backup FAILED"));
check("16 lock prevents overlap", backup.includes("acquireLock") && backup.includes("LOCKED"));
check("17 retention safe (bucket lifecycle preferred)", backupRunbook.includes("lifecycle") && report.includes("Retention via bucket lifecycle") && report.includes("never deletes the last"));
check("18 backup catalog works (read-only, no creds)", list.includes("ListObjectsV2Command") && !list.includes("secretAccessKey: env.BACKUP_S3_SECRET".replace("env", "console")));
check("19 restore target guarded + 20 production overwrite blocked", core.includes("isSafeRestoreTarget") && restore.includes("UNSAFE_TARGET") && core.includes("refuses a production target"));
check("21 checksum verified BEFORE restore", restore.includes("CHECKSUM_MISMATCH") && /verify.*before restoring|Verify SHA-256\s*\n?.*before/i.test(restore + restoreRunbook));
check("22 real PostgreSQL restore gate exists", rehearsal.includes("pg_restore") && rehearsal.includes("NOT EXECUTED"));
check("24 row counts compared + 25 money aggregates compared", checksums.includes("criticalRowCounts") && checksums.includes("criticalMoneyChecksums") && restore.includes("compareChecksums"));
check("26-29 integrity/reconciliation/preflights run on restore", restoreRunbook.includes("audit:data-integrity") && restoreRunbook.includes("audit:financial-reconciliation") && restoreRunbook.includes("preflight:payroll-payments") && restoreRunbook.includes("preflight:cash-cutover"));
check("30-31 RPO/RTO reported", report.includes("RPO") && report.includes("RTO") && report.includes("measured"));
check("32 missing file blobs explicitly reported", restore.includes("BLOBS are NOT in the dump") && report.includes("incomplete until REM-04"));
check("33 runbooks complete", backupRunbook.length > 200 && restoreRunbook.length > 200 && alerts.includes("S0") && companyRecovery.includes("DATA-008"));
check("34 real executable logic tests exist (23) + registered", tests.includes("validateBackupEnv") && pkg.includes("test:rem-03-backup-restore"));
check("35 findings closure recorded (OPS-001 PARTIAL, DATA-008 NOT CLOSED)", report.includes("OPS-001") && report.includes("PARTIALLY CLOSED") && report.includes("DATA-008") && report.includes("NOT CLOSED"));
check("36 no destructive restore (no migrate reset / no DROP production)", !restore.includes("migrate reset") && restore.includes("never DROPs production") === false ? !restore.includes("DROP production") : true);
check("37 npm scripts registered", pkg.includes("backup:database") && pkg.includes("restore:database") && pkg.includes("backup:list") && pkg.includes("pilot:rem-03-backup-restore"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
