// Full non-production pilot suite (Phase 22). Runs every deterministic CLUB-OPS
// pilot in a safe order and reports a single summary. Refuses to run against any
// production indicator and never touches a production database.
//
//   npm run pilot:full
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// Resolve DATABASE_URL the way the pilots effectively see it: process.env first,
// otherwise the local .env (Prisma Client auto-loads .env at runtime, but this
// guard runs before any client is constructed).
function resolveDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = resolve(root, ".env");
  if (!existsSync(envPath)) return "";
  const m = readFileSync(envPath, "utf8").match(/^\s*DATABASE_URL\s*=\s*["']?([^"'\r\n]+)/m);
  return m ? m[1] : "";
}

// --- Fail-closed production guard ------------------------------------------
const dbUrl = resolveDbUrl();
const reasons = [];
if (process.env.NODE_ENV === "production") reasons.push("NODE_ENV=production");
if (!/^file:/i.test(dbUrl)) reasons.push("DATABASE_URL is not a local sqlite file: URL");
if (/^postgres/i.test(dbUrl)) reasons.push("DATABASE_URL points at PostgreSQL");
if (reasons.length > 0) {
  console.error("REFUSING to run pilot:full — production indicators detected:");
  for (const r of reasons) console.error(`  - ${r}`);
  console.error("This suite must only run against a local sqlite dev database.");
  process.exit(1);
}

// --- Pilot order (cheap → broad) -------------------------------------------
const pilots = [
  ["APP_URL / invitation links", "pilot-appurl.mjs"],
  ["Email OTP", "pilot-otp.mjs"],
  ["Sessions / revocation", "pilot-sessions.mjs"],
  ["Club / LegalEntity", "pilot-club-legal-entity.mjs"],
  ["Financial integrity", "pilot-financial.mjs"],
];

let totalPass = 0, totalFail = 0, suitesFailed = 0;
const summary = [];

for (const [label, file] of pilots) {
  const res = spawnSync(process.execPath, [resolve(here, file)], { encoding: "utf8" });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
  const passed = m ? Number(m[1]) : 0;
  const failed = m ? Number(m[2]) : 0;
  const ok = res.status === 0 && failed === 0 && m !== null;
  totalPass += passed; totalFail += failed;
  if (!ok) suitesFailed += 1;
  summary.push(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(28)} ${m ? `${passed} passed, ${failed} failed` : `(no summary; exit ${res.status})`}`);
  if (!ok && !m) process.stdout.write(out); // surface the raw failure
}

console.log("\n===== pilot:full summary =====");
for (const line of summary) console.log(line);
console.log(`------------------------------`);
console.log(`${totalPass} checks passed, ${totalFail} failed across ${pilots.length} suites (${suitesFailed} suite(s) failed)`);

process.exit(suitesFailed === 0 ? 0 : 1);
