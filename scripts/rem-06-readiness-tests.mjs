// REM-06 — REAL logic tests (§26). Imports & EXECUTES the actual health modules via
// jiti: pure validators (DATABASE_URL / storage / startup) + computeReadiness driven
// by MOCK Prisma clients that simulate DB-down / pending / failed / mismatch. No
// PostgreSQL needed here — the real provider/migration proof is the staging gate
// (docs/testing/rem-06-postgres-readiness-rehearsal.md).
//   node scripts/rem-06-readiness-tests.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const require = createRequire(import.meta.url);
const jiti = require("jiti")(fileURLToPath(import.meta.url), { alias: { "@": SRC, "server-only": join(ROOT, "scripts", "_stubs", "server-only.cjs") }, interopDefault: true, esmResolve: true });
const { validateDatabaseEnvironment, expectedDbProvider } = jiti("@/lib/health/database-validation.ts");
const { classifyStartup } = jiti("@/lib/health/startup-validation.ts");
const { checkSchemaCompatibility } = jiti("@/lib/health/schema-compatibility.ts");
const { checkDatabase, detectDbProvider } = jiti("@/lib/health/runtime-checks.ts");
const { computeReadiness } = jiti("@/lib/health/readiness.ts");
const { createProbeCache } = jiti("@/lib/health/cache.ts");
const { deploymentVersion } = jiti("@/lib/deployment-version.ts");
const { EXPECTED_LATEST_MIGRATION } = jiti("@/lib/health/migration-manifest.ts");

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const PG = "postgresql://user:s3cr3tPASSWORD@db.internal:5432/clubops";

// Mock Prisma clients driven by the SQL substring.
function mockClient(opts) {
  return {
    async $queryRawUnsafe(sql) {
      if (opts.down) throw new Error("ECONNREFUSED");
      if (sql.includes("sqlite_version")) { if (opts.provider === "postgresql") throw new Error("no such function"); return [{ v: "3.45" }]; }
      if (sql.includes("version()")) { if (opts.provider === "postgresql") return [{ v: "PostgreSQL 16" }]; throw new Error("no version()"); }
      if (sql.includes("SELECT 1")) return [{ 1: 1 }];
      if (sql.includes("_prisma_migrations")) return opts.migrations ?? [{ migration_name: EXPECTED_LATEST_MIGRATION, finished_at: new Date(), rolled_back_at: null }];
      return [];
    },
  };
}

async function main() {
  // --- pure DATABASE_URL validation ---
  check("1 dev sqlite allowed", validateDatabaseEnvironment({ DATABASE_URL: "file:./dev.db" }, { isProduction: false }).ok);
  check("4 production rejects sqlite", validateDatabaseEnvironment({ DATABASE_URL: "file:./x.db" }, { isProduction: true }).errors.includes("PRODUCTION_SQLITE_FORBIDDEN"));
  check("3 production accepts postgres", validateDatabaseEnvironment({ DATABASE_URL: PG }, { isProduction: true }).ok);
  check("5 malformed URL rejected", !validateDatabaseEnvironment({ DATABASE_URL: "postgresql://" }, { isProduction: true }).ok);
  check("empty URL rejected", validateDatabaseEnvironment({}, { isProduction: true }).errors.includes("DATABASE_URL_EMPTY"));
  check("unsupported protocol rejected", validateDatabaseEnvironment({ DATABASE_URL: "mongodb://x" }, { isProduction: true }).errors.includes("DATABASE_URL_UNSUPPORTED_PROTOCOL"));
  check("6 localhost production rejected unless override", validateDatabaseEnvironment({ DATABASE_URL: "postgresql://u:p@localhost:5432/db" }, { isProduction: true }).errors.includes("PRODUCTION_LOCALHOST_FORBIDDEN"));
  check("6b localhost allowed with override", validateDatabaseEnvironment({ DATABASE_URL: "postgresql://u:p@localhost:5432/db" }, { isProduction: true, allowLocalhost: true }).ok);
  // 7. secret redacted — the password never appears in the result.
  { const v = validateDatabaseEnvironment({ DATABASE_URL: PG }, { isProduction: true }); check("7 password never in the validation result", !JSON.stringify(v).includes("s3cr3tPASSWORD")); }
  // 8. expected provider.
  check("8 expectedDbProvider prod=postgres dev=sqlite", expectedDbProvider(true) === "postgresql" && expectedDbProvider(false) === "sqlite");
  check("host class private for .internal", validateDatabaseEnvironment({ DATABASE_URL: PG }, { isProduction: true }).hostClass === "private");

  // --- startup classification ---
  { const c = classifyStartup({ DATABASE_URL: "file:./x.db" }, { isProduction: true }); check("26 fatal on prod sqlite + missing session secret", c.fatal.some((f) => f.includes("PRODUCTION_SQLITE_FORBIDDEN")) && c.fatal.includes("SESSION_SECRET_MISSING_OR_SHORT")); }
  { const c = classifyStartup({ DATABASE_URL: "file:./x.db", SESSION_SECRET: "x".repeat(40) }, { isProduction: false }); check("14/15/16 dev optional deps degraded not fatal", c.fatal.length === 0 && c.degraded.includes("ofd")); }

  // --- schema compatibility (mock rows) ---
  check("10 pending migration → not compatible", !(await checkSchemaCompatibility(mockClient({ migrations: [{ migration_name: "20200101000000_init", finished_at: new Date(), rolled_back_at: null }] }))).compatible);
  check("11 failed migration → not compatible", !(await checkSchemaCompatibility(mockClient({ migrations: [{ migration_name: EXPECTED_LATEST_MIGRATION, finished_at: null, rolled_back_at: null }] }))).compatible);
  check("no migrations table → not compatible", !(await checkSchemaCompatibility(mockClient({ down: true }))).compatible);
  check("expected present → compatible", (await checkSchemaCompatibility(mockClient({}))).compatible);

  // --- DB probe ---
  check("2 checkDatabase down → failed", (await checkDatabase(mockClient({ down: true }))).status === "failed");
  check("checkDatabase up → ok", (await checkDatabase(mockClient({}))).status === "ok");
  check("9 detectDbProvider (mock postgres) = postgresql", (await detectDbProvider(mockClient({ provider: "postgresql" }))) === "postgresql");

  // --- computeReadiness with mock clients (dev env: storage local ok) ---
  check("ready with a healthy DB", (await computeReadiness(mockClient({}))).ready === true);
  check("2 not_ready with DB down", (await computeReadiness(mockClient({ down: true }))).ready === false);
  check("10 not_ready with pending migration", (await computeReadiness(mockClient({ migrations: [{ migration_name: "20200101000000_init", finished_at: new Date(), rolled_back_at: null }] }))).ready === false);
  check("9 not_ready on provider mismatch (dev expects sqlite, DB is postgres)", (await computeReadiness(mockClient({ provider: "postgresql" }))).ready === false);
  // 27/28. no raw error / secret in the readiness checks.
  { const v = await computeReadiness(mockClient({ down: true })); const s = JSON.stringify(v); check("27/28 readiness carries no raw error/secret", !s.includes("ECONNREFUSED") && !s.includes("s3cr3t")); }

  // --- cache single-flight (20) ---
  { let calls = 0; const get = createProbeCache(1000, async () => { calls++; return calls; }); await Promise.all([get(), get(), get()]); check("20 single-flight coalesces concurrent probes", calls === 1, `calls=${calls}`); }
  // 21. cache does not hide a required failure past TTL.
  { let state = "down"; const get = createProbeCache(1, async () => state); await get(); state = "up"; await new Promise((r) => setTimeout(r, 5)); check("21 cache expires (failure not stuck)", (await get()) === "up"); }

  // 29. deploymentVersion preserved.
  check("29 deploymentVersion shape preserved", typeof deploymentVersion().commit === "string" && "environment" in deploymentVersion());

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("rem-06 tests crashed:", e); process.exit(1); });
