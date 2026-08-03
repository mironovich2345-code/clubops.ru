// READ-ONLY deploy/ops audit (FULL AUDIT 4/6). Scans deploy config + migrations + env usage on
// disk — NO deploy, NO DB connection, NO secret values printed. Emits machine-readable JSON:
// deploy-readiness.json, migration-risks.json, env-contract.json, storage-risk.json.
//   node scripts/audit-deploy-ops.mjs [--json]
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
const read = (p) => { try { return readFileSync(join(ROOT, p), "utf8"); } catch { return ""; } };
const has = (p) => existsSync(join(ROOT, p));
function walk(d, a = []) { let s; try { s = readdirSync(d); } catch { return a; } for (const n of s) { const p = join(d, n); if (statSync(p).isDirectory()) { if (["node_modules", ".next", ".git"].includes(n)) continue; walk(p, a); } else a.push(p); } return a; }

// --- 1. Migration risk (scan every prod migration SQL for risky DDL) ---
const migDir = join(ROOT, "prisma/production/migrations");
const migNames = readdirSync(migDir).filter((n) => /^\d/.test(n)).sort();
const migRisks = [];
let concurrentIndexes = 0;
for (const name of migNames) {
  const sql = read(`prisma/production/migrations/${name}/migration.sql`);
  if (!sql) continue;
  const notNullNoDefault = /ADD COLUMN[^;]*\bNOT NULL\b(?![^;]*DEFAULT)/gi.test(sql);
  const setNotNull = /ALTER COLUMN[^;]*SET NOT NULL/gi.test(sql);
  const alterType = /ALTER COLUMN[^;]*\bTYPE\b|ALTER COLUMN[^;]*SET DATA TYPE/gi.test(sql);
  const plainIndex = /CREATE (UNIQUE )?INDEX(?! CONCURRENTLY)/gi.test(sql);
  const uniqueIndex = /CREATE UNIQUE INDEX|ADD CONSTRAINT[^;]*UNIQUE/gi.test(sql);
  const concurrent = /CREATE INDEX CONCURRENTLY/gi.test(sql);
  if (concurrent) concurrentIndexes++;
  const dropCol = /DROP COLUMN/gi.test(sql);
  const dropTable = /DROP TABLE/gi.test(sql);
  const addColDefault = /ADD COLUMN[^;]*DEFAULT/gi.test(sql);
  const risky = notNullNoDefault || setNotNull || alterType || dropCol || dropTable;
  const sev = (dropTable || dropCol || alterType) ? "S1" : (notNullNoDefault || setNotNull) ? "S2" : (uniqueIndex || plainIndex) ? "S3" : "OK";
  migRisks.push({ migration: name, notNullNoDefault, setNotNull, alterType, plainIndex, uniqueIndex, dropCol, dropTable, addColDefault, additive: !risky, severity: sev });
}
const last15 = migRisks.slice(-15);

// --- 2. Env contract (scan src+scripts+deploy for process.env.X; cross-ref .env.production.example) ---
const envUse = new Map(); // name → {files, clientExposed}
const srcFiles = walk(join(ROOT, "src")).filter((f) => [".ts", ".tsx"].includes(extname(f)));
for (const f of srcFiles) {
  const text = readFileSync(f, "utf8");
  const isClient = /^\s*["']use client["']/m.test(text);
  for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
    const name = m[1];
    const e = envUse.get(name) || { files: 0, clientExposed: false, public: name.startsWith("NEXT_PUBLIC_") };
    e.files++; if (isClient) e.clientExposed = true;
    envUse.set(name, e);
  }
}
const envExample = read("deploy/.env.production.example");
const documented = new Set([...envExample.matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]));
const envContract = [...envUse.entries()].map(([name, e]) => ({ name, usedInFiles: e.files, public: e.public, clientExposed: e.clientExposed, documentedInExample: documented.has(name) })).sort((a, b) => a.name.localeCompare(b.name));
const undocumented = envContract.filter((e) => !e.documentedInExample && !e.public);

// --- 3. Deploy readiness facts (from the deploy files) ---
const health = read("src/app/api/health/route.ts");
const deploySh = read("deploy/deploy.sh");
const entrypoint = read("docker-entrypoint.sh");
const pkg = read("package.json");
const storageIndex = read("src/lib/storage/index.ts");
const deployReadiness = {
  healthChecksDb: /prisma|\.\$queryRaw|db\./i.test(health) && !/does not|no DB call|Liveness/i.test(health) ? "unknown" : false,
  healthLivenessOnly: /Liveness probe/i.test(health) || !/prisma/i.test(health),
  readinessEndpointExists: has("src/app/api/health/ready/route.ts") || has("src/app/api/ready/route.ts"),
  buildProdRegeneratesProdClient: /prisma generate --schema=prisma\/production\/schema\.prisma/.test(pkg),
  postbuildRestoresDevClient: /"postbuild"/.test(pkg) || /prisma generate --schema=prisma\/schema\.prisma/.test(pkg.split('"build:prod"')[1] || ""),
  backupBeforeMigrate: /pg_dump/.test(deploySh),
  backupLocationLocalToVm: /BACKUP_DIR=.*DEPLOY_DIR/.test(deploySh) || /\/opt\/club-ops\/backups/.test(deploySh),
  backupOnlyOnDeploy: /pg_dump/.test(deploySh) && !has("deploy/systemd/club-ops-backup.timer"),
  offsiteBackup: /s3|rclone|aws s3|restic|borg|scp .*backup/i.test(deploySh),
  restoreTested: false, // no evidence of an executed restore test in-repo
  appRollback: /roll(ing)? (the )?app back/i.test(deploySh),
  dbRollback: false, // deploy.sh explicitly does NOT roll back the DB
  migrateBeforeApp: /compose run --rm migrate[\s\S]*compose up -d/.test(deploySh),
  railwayAutoMigrate: /migrate deploy/.test(entrypoint),
  storageDefaultLocal: /STORAGE_PROVIDER[^;]*\|\|\s*"local"|\?\?\s*"local"|default.*local/i.test(storageIndex) || /"local"/.test(storageIndex),
  storageProdGuard: /production[\s\S]*local[\s\S]*throw|throw[\s\S]*STORAGE_PROVIDER/i.test(storageIndex),
  structuredLogger: has("src/lib/logger.ts") || /pino|winston/.test(pkg),
  errorTracker: /sentry|@sentry|bugsnag|rollbar/i.test(pkg),
};
const storageRisk = {
  provider: /storageProviderName/.test(storageIndex) ? "local|s3 (env STORAGE_PROVIDER)" : "unknown",
  defaultLocal: deployReadiness.storageDefaultLocal,
  prodGuardAgainstLocal: deployReadiness.storageProdGuard,
  localLostOnRedeploy: deployReadiness.storageDefaultLocal && !deployReadiness.storageProdGuard,
  s3ProviderPresent: has("src/lib/storage/s3-provider.ts"),
  localProviderPresent: has("src/lib/storage/local-provider.ts"),
};

const outDir = join(ROOT, "docs/audits/data");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "migration-risks.json"), JSON.stringify({ total: migRisks.length, concurrentIndexes, riskyCount: migRisks.filter((m) => !m.additive).length, last15, all: migRisks }, null, 2));
writeFileSync(join(outDir, "env-contract.json"), JSON.stringify({ total: envContract.length, undocumentedNonPublic: undocumented.map((e) => e.name), clientExposed: envContract.filter((e) => e.clientExposed).map((e) => e.name), contract: envContract }, null, 2));
writeFileSync(join(outDir, "deploy-readiness.json"), JSON.stringify(deployReadiness, null, 2));
writeFileSync(join(outDir, "storage-risk.json"), JSON.stringify(storageRisk, null, 2));

if (!JSON_ONLY) {
  console.log("=== Deploy/Ops readiness (read-only, no deploy, no DB) ===");
  console.log(`Prod migrations: ${migRisks.length} | risky (non-additive): ${migRisks.filter((m) => !m.additive).length} | CONCURRENT indexes: ${concurrentIndexes}`);
  console.log(`  last-15 risky: ${last15.filter((m) => !m.additive).map((m) => m.migration).join(", ") || "none (all additive)"}`);
  console.log(`Env vars used: ${envContract.length} | undocumented non-public: ${undocumented.length} (${undocumented.map((e) => e.name).join(", ") || "none"}) | client-exposed: ${envContract.filter((e) => e.clientExposed).length}`);
  console.log(`Health checks DB: ${deployReadiness.healthChecksDb} | readiness endpoint: ${deployReadiness.readinessEndpointExists} | build:prod restores dev client: ${deployReadiness.postbuildRestoresDevClient}`);
  console.log(`Backup before migrate: ${deployReadiness.backupBeforeMigrate} | local-to-VM: ${deployReadiness.backupLocationLocalToVm} | off-site: ${deployReadiness.offsiteBackup} | only-on-deploy: ${deployReadiness.backupOnlyOnDeploy} | restore tested: ${deployReadiness.restoreTested}`);
  console.log(`App rollback: ${deployReadiness.appRollback} | DB rollback: ${deployReadiness.dbRollback} | migrate-before-app: ${deployReadiness.migrateBeforeApp}`);
  console.log(`Storage default local: ${storageRisk.defaultLocal} | prod guard: ${storageRisk.prodGuardAgainstLocal} | lost-on-redeploy risk: ${storageRisk.localLostOnRedeploy}`);
  console.log(`Structured logger: ${deployReadiness.structuredLogger} | error tracker: ${deployReadiness.errorTracker}`);
  console.log("Wrote migration-risks.json, env-contract.json, deploy-readiness.json, storage-risk.json");
}
