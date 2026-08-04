// REM-06 — READ-ONLY readiness + env-contract audit (§24/§25). Imports & EXECUTES the
// ACTUAL validators via jiti (validateDatabaseEnvironment / validateStorageEnv /
// classifyStartup) and runs the real computeReadiness against the current DB. Same
// contract the /api/health/ready endpoint enforces. NO writes. Secrets never printed
// (validators return codes/classes only).
//   node --env-file=.env scripts/audit-readiness.mjs [--json] [--production]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const require = createRequire(import.meta.url);
const jiti = require("jiti")(fileURLToPath(import.meta.url), { alias: { "@": SRC, "server-only": join(ROOT, "scripts", "_stubs", "server-only.cjs") }, interopDefault: true, esmResolve: true });
const { validateDatabaseEnvironment } = jiti("@/lib/health/database-validation.ts");
const { validateStorageEnv } = jiti("@/lib/storage/config.ts");
const { classifyStartup } = jiti("@/lib/health/startup-validation.ts");
const { computeReadiness } = jiti("@/lib/health/readiness.ts");
const { prisma } = jiti("@/lib/prisma.ts");

const JSON_ONLY = process.argv.includes("--json");
const FORCE_PROD = process.argv.includes("--production");
const isProduction = FORCE_PROD || process.env.NODE_ENV === "production";

async function main() {
  const db = validateDatabaseEnvironment(process.env, { isProduction, allowLocalhost: process.env.ALLOW_DB_LOCALHOST === "true" });
  const storage = validateStorageEnv(process.env, { isProduction });
  const startup = classifyStartup(process.env, { isProduction });
  let readiness;
  try {
    readiness = await computeReadiness(prisma);
  } catch (e) {
    readiness = { status: "not_ready", ready: false, checks: [{ name: "readiness", status: "failed", errorCode: String(e.message || e).slice(0, 60) }] };
  }

  const out = {
    environment: isProduction ? "production" : "non-production",
    databaseContract: { ok: db.ok, provider: db.provider, expected: db.expectedProvider, hostClass: db.hostClass, errors: db.errors, warnings: db.warnings },
    storageContract: { ok: storage.ok, provider: storage.provider, errors: storage.errors },
    startup: startup,
    readiness: { status: readiness.status, ready: readiness.ready, checks: readiness.checks.map((c) => ({ name: c.name, status: c.status, required: c.requiredForReadiness, errorCode: c.errorCode ?? null })) },
  };

  if (JSON_ONLY) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`Readiness audit — ${out.environment}`);
    console.log(`  DB contract: ${db.ok ? "OK" : "FAIL"} provider=${db.provider} expected=${db.expectedProvider} host=${db.hostClass}${db.errors.length ? " errors=" + db.errors.join(",") : ""}`);
    console.log(`  Storage contract: ${storage.ok ? "OK" : "FAIL"} provider=${storage.provider}${storage.errors.length ? " errors=" + storage.errors.join(",") : ""}`);
    console.log(`  Startup: fatal=[${startup.fatal.join(", ")}] degraded=[${startup.degraded.join(", ")}]`);
    console.log(`  Readiness: ${out.readiness.status}`);
    for (const c of out.readiness.checks) console.log(`    ${c.status === "ok" ? "OK  " : c.status === "failed" ? "FAIL" : c.status.padEnd(4)} ${c.name}${c.required ? " (required)" : ""}${c.errorCode ? " :: " + c.errorCode : ""}`);
  }
  await prisma.$disconnect();
  // Non-zero only when PRODUCTION would be blocked (fatal startup or not-ready).
  const blocked = isProduction && (startup.fatal.length > 0 || !readiness.ready);
  process.exit(blocked ? 2 : 0);
}
main().catch(async (e) => { console.error("readiness audit failed:", String(e.message || e).slice(0, 200)); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
