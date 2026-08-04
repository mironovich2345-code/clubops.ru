// Pilot — REM-06 readiness / health contract (§31). Fast STRUCTURAL checks that the
// three endpoints, the health library, DB/provider validation, deploy integration
// and docs are in place. BEHAVIORAL proof = test:rem-06-readiness (28/28 with mock
// clients). Real PostgreSQL/S3 = the staging gate. Runs in pilot:full.
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => { try { return readFileSync(new URL(p, import.meta.url), "utf8"); } catch { return ""; } };

const live = src("../src/app/api/health/live/route.ts");
const ready = src("../src/app/api/health/ready/route.ts");
const deps = src("../src/app/api/health/dependencies/route.ts");
const healthAlias = src("../src/app/api/health/route.ts");
const dbVal = src("../src/lib/health/database-validation.ts");
const readiness = src("../src/lib/health/readiness.ts");
const schema = src("../src/lib/health/schema-compatibility.ts");
const runtime = src("../src/lib/health/runtime-checks.ts");
const startup = src("../src/lib/health/startup-validation.ts");
const cache = src("../src/lib/health/cache.ts");
const dependencies = src("../src/lib/health/dependencies.ts");
const instrumentation = src("../src/instrumentation.ts");
const deploySh = src("../deploy/deploy.sh");
const dockerfile = src("../Dockerfile");
const composeProd = src("../deploy/docker-compose.prod.yml");
const railway = src("../railway.json");
const cli = src("../scripts/audit-readiness.mjs");
const tests = src("../scripts/rem-06-readiness-tests.mjs");
const pkg = src("../package.json");
const report = src("../docs/remediation/rem-06-final-report.md");
const contract = src("../docs/remediation/rem-06-health-contract.md");
const dbDoc = src("../docs/remediation/rem-06-database-validation.md");
const readyDesign = src("../docs/remediation/rem-06-readiness-design.md");
const deployDoc = src("../docs/remediation/rem-06-deploy-integration.md");
const rehearsal = src("../docs/testing/rem-06-postgres-readiness-rehearsal.md");
const checklist = src("../docs/testing/rem-06-readiness-checklist.md");
const readyRunbook = src("../docs/operations/readiness-runbook.md");
const depRunbook = src("../docs/operations/dependency-health-runbook.md");
const spec = src("../docs/operations/health-readiness-spec.md");

// 1/2/3. endpoints exist.
check("1 /live endpoint exists (liveness, no DB)", live.includes('status: "alive"') && !/prisma|queryRaw|checkDatabase/.test(live));
check("2 /ready endpoint exists (503 when not ready)", ready.includes("getReadiness") && ready.includes("503"));
check("3 /dependencies endpoint exists", deps.includes("getDependencies"));
// backward-compat alias untouched.
check("3b /api/health kept as liveness alias (unchanged)", healthAlias.includes('status: "ok"') && !/getReadiness|checkDatabase/.test(healthAlias));
// 4. DB required for ready.
check("4 DB required for readiness", readiness.includes('name: "database"') && readiness.includes("requiredForReadiness: true"));
// 5. Storage required in production.
check("5 storage required for readiness in production", readiness.includes("storageRequired") && readiness.includes("isProduction"));
// 6. Optional degraded only.
check("6 optional integrations degraded only", dependencies.includes('"degraded"') && dependencies.includes("requiredForReadiness: false"));
// 7. Production sqlite rejected.
check("7 production rejects sqlite", dbVal.includes("PRODUCTION_SQLITE_FORBIDDEN"));
// 8. Malformed URL rejected.
check("8 malformed DB URL rejected", dbVal.includes("DATABASE_URL_MALFORMED") && dbVal.includes("DATABASE_URL_EMPTY"));
// 9. Provider mismatch detected.
check("9 provider mismatch detected", dbVal.includes("PROVIDER_MISMATCH") && runtime.includes("detectDbProvider") && readiness.includes('name: "prisma_provider"'));
// 10. Migration mismatch detected.
check("10 migration compatibility (pending/failed)", schema.includes("pending_migration") && schema.includes("failed_migration") && schema.includes("_prisma_migrations"));
// 10b. health never applies migrations.
check("10b health never applies migrations", !/migrate deploy|prisma migrate|\$executeRaw/.test(schema));
// 11. Secrets redacted / never returned.
check("11 DB value/password never returned", dbVal.includes("never leave") || dbVal.includes("never returned") || dbVal.includes("value never leaves") || /never.*(returned|logged)/i.test(dbVal));
// 12. Bounded timeouts.
check("12 bounded timeouts", runtime.includes("timeoutMs") && cache.includes("withTimeout"));
// 13. Probe caching safe (single-flight + failure not stuck).
check("13 cache single-flight + TTL (failure not stuck)", cache.includes("inflight") && cache.includes("ttlMs") && cache.includes("single-flight"));
// 14. No raw errors in responses.
check("14 no raw errors (codes only)", ready.includes("errorCode") && !/e\.message|err\.stack/.test(ready) && !/e\.message|err\.stack/.test(deps));
// 15. Deploy uses ready.
check("15 deploy waits for /ready (two-stage live→ready)", deploySh.includes("/api/health/ready") && deploySh.includes("/api/health/live"));
// 16. Railway uses ready.
check("16 Railway healthcheckPath = /ready", railway.includes('"healthcheckPath": "/api/health/ready"'));
// 17. Compose uses ready.
check("17 Compose + Dockerfile healthchecks use /ready", composeProd.includes("/api/health/ready") && dockerfile.includes("/api/health/ready"));
// 18/19. DB + storage recovery supported (cache TTL clears failure; readiness recomputes).
check("18/19 recovery supported (short TTL, recompute)", readiness.includes("createProbeCache(2000") && cache.includes("now - cached.at < ttlMs"));
// 20. CLI readiness.
check("20 audit:readiness CLI (read-only)", cli.includes("computeReadiness") && cli.includes("READ-ONLY") && !/prisma\.\w+\.(create|update|delete)/.test(cli));
// 21. env audit exists (audit:env-contract already registered; audit:readiness covers env).
check("21 env contract covered by CLI", cli.includes("validateDatabaseEnvironment") && cli.includes("validateStorageEnv") && cli.includes("classifyStartup"));
// 22. No production writes (health is read-only).
check("22 health library performs no writes", !/\.(create|update|delete|upsert)\(/.test(readiness) && !/\$executeRaw/.test(runtime));
// 23. Business logic unchanged (health lib touches no domain models).
check("23 no domain-model access in health lib", !/prisma\.(expense|invoice|refund|payroll|company|user)\b/i.test(readiness + schema + runtime));
// 24. Real integration tests.
check("24 real tests (mock-client failure scenarios)", tests.includes("computeReadiness") && tests.includes("mockClient") && pkg.includes("test:rem-06-readiness"));
// 25. PostgreSQL gate documented.
check("25 PostgreSQL staging gate documented", rehearsal.includes("NOT EXECUTED") && rehearsal.includes("PROVIDER_MISMATCH") && rehearsal.includes("pending_migration"));
// 26/27. prisma dev/prod (no schema change).
check("26/27 no schema migration required", !readiness.includes("prisma/migrations") && !dbVal.includes("ALTER TABLE"));
// 28. tsc clean marker (imports wired).
check("28 endpoints wired to health lib", ready.includes('from "@/lib/health/readiness"') && deps.includes('from "@/lib/health/dependencies"'));
// 29. startup fail-fast via instrumentation.
check("29 startup fail-fast (instrumentation)", instrumentation.includes("assertProductionStartup") && instrumentation.includes("assertStorageConfigured") && instrumentation.includes('NEXT_RUNTIME === "nodejs"'));
// 30. pilot + tests registered.
check("30 pilot + tests registered", pkg.includes("pilot:rem-06-readiness") && src("../scripts/pilot-full.mjs").includes("pilot-rem-06-readiness.mjs"));
// docs + findings closure.
check("31 docs present", contract.length > 200 && dbDoc.length > 200 && readyDesign.length > 200 && deployDoc.length > 200 && readyRunbook.length > 200 && depRunbook.length > 200 && checklist.includes("G-READY"));
check("32 findings closure honest", report.includes("ARCH-015") && report.includes("OPS-003") && report.includes("OPS-013") && report.includes("ARCH-013") && report.includes("PARTIALLY CLOSED") && spec.includes("REM-06"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
