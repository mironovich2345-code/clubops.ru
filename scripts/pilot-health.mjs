// Health-check deployment version set. Verifies /api/health exposes safe
// deployment identifiers (commit / deploymentId / environment) sourced only from
// Railway system env vars, never leaks secrets, and never falls over when the
// vars are absent. Mirrors the pure resolver and statically asserts the TS source.
// npm run pilot:health
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

// ---- Mirror of src/lib/deployment-version.ts (kept in lockstep) ----
function deploymentVersion(env) {
  return {
    commit: env.RAILWAY_GIT_COMMIT_SHA ?? "local",
    deploymentId: env.RAILWAY_DEPLOYMENT_ID ?? null,
    environment: env.RAILWAY_ENVIRONMENT_NAME ?? "local",
  };
}

// Storage provider name resolver — mirror of src/lib/storage/index.ts.
function storageProviderName(env) {
  return env.STORAGE_PROVIDER === "s3" ? "s3" : "local";
}

// The full health payload shape, as the route builds it.
function healthPayload(env) {
  return { status: "ok", service: "club-ops", time: "<iso>", ...deploymentVersion(env), storage: storageProviderName(env) };
}

// 1. commit returned from RAILWAY_GIT_COMMIT_SHA when present
{
  const sha = "19c985ed632b7cadaeae722595459e17504fd7c4";
  const v = deploymentVersion({ RAILWAY_GIT_COMMIT_SHA: sha, RAILWAY_DEPLOYMENT_ID: "dep-1", RAILWAY_ENVIRONMENT_NAME: "production" });
  check("1 commit comes from RAILWAY_GIT_COMMIT_SHA", v.commit === sha, v.commit);
  check("1b environment comes from RAILWAY_ENVIRONMENT_NAME", v.environment === "production");
}

// 2. endpoint does not blow up when the vars are absent
{
  let threw = false, v = null;
  try { v = deploymentVersion({}); } catch { threw = true; }
  check("2 resolver does not throw with empty env", !threw && v !== null);
  check("2b commit falls back to 'local'", v.commit === "local", v.commit);
  check("2c environment falls back to 'local'", v.environment === "local");
  check("2d deploymentId falls back to null", v.deploymentId === null, String(v.deploymentId));
}

// 3. deploymentId only ever comes from the allowed RAILWAY_DEPLOYMENT_ID var
{
  const v = deploymentVersion({ RAILWAY_DEPLOYMENT_ID: "dep-xyz", DEPLOYMENT_ID: "SHOULD_NOT_BE_USED", RAILWAY_PROJECT_ID: "proj-secret" });
  check("3 deploymentId from RAILWAY_DEPLOYMENT_ID only", v.deploymentId === "dep-xyz", v.deploymentId);
  const json = JSON.stringify(healthPayload({ RAILWAY_DEPLOYMENT_ID: "dep-xyz", DEPLOYMENT_ID: "SHOULD_NOT_BE_USED", RAILWAY_PROJECT_ID: "proj-secret" }));
  check("3b non-allowed deployment vars not echoed", !json.includes("SHOULD_NOT_BE_USED") && !json.includes("proj-secret"));
}

// 4. no secret ever appears in the response, even if such vars exist in the env
{
  const dirtyEnv = {
    RAILWAY_GIT_COMMIT_SHA: "abc123",
    RAILWAY_DEPLOYMENT_ID: "dep-1",
    RAILWAY_ENVIRONMENT_NAME: "production",
    OPENAI_API_KEY: "sk-SECRET-MUST-NOT-LEAK",
    DATABASE_URL: "postgres://user:pw@host/db",
    SESSION_SECRET: "session-secret-value",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    RAILWAY_PROJECT_ID: "proj-id-secret",
    RAILWAY_ENVIRONMENT_ID: "env-id-secret",
    RAILWAY_SERVICE_ID: "svc-id-secret",
  };
  const json = JSON.stringify(healthPayload(dirtyEnv));
  const forbidden = ["sk-SECRET-MUST-NOT-LEAK", "OPENAI_API_KEY", "postgres://", "DATABASE_URL", "session-secret-value", "SESSION_SECRET", "aws-secret", "proj-id-secret", "env-id-secret", "svc-id-secret"];
  const leaked = forbidden.filter((f) => json.includes(f));
  check("4 no secret/forbidden identifier in response", leaked.length === 0, leaked.join(","));
  // Only the whitelisted keys are present on the payload.
  const keys = Object.keys(healthPayload(dirtyEnv)).sort().join(",");
  check("4b response keys are exactly the whitelist", keys === "commit,deploymentId,environment,service,status,storage,time", keys);
  // Storage exposes only the provider NAME, never bucket/endpoint/keys/region.
  const withS3 = healthPayload({ ...dirtyEnv, STORAGE_PROVIDER: "s3", S3_BUCKET: "secret-bucket", S3_ENDPOINT: "https://secret.endpoint", S3_ACCESS_KEY_ID: "AKIA_SECRET", S3_SECRET_ACCESS_KEY: "s3-secret" });
  check("4c storage is the provider name only", withS3.storage === "s3");
  const sjson = JSON.stringify(withS3);
  check("4d no S3 secret/bucket/endpoint leaked", !sjson.includes("secret-bucket") && !sjson.includes("secret.endpoint") && !sjson.includes("AKIA_SECRET") && !sjson.includes("s3-secret"));
  check("4e storage defaults to local when unset", storageProviderName({}) === "local");
}

// 5. existing health-check semantics preserved (status ok / service name)
{
  const p = healthPayload({});
  check("5 status still ok", p.status === "ok");
  check("5b service still club-ops", p.service === "club-ops");
  check("5c time field retained", Object.prototype.hasOwnProperty.call(p, "time"));
}

// ---- Static assertions on the real TS source ----
{
  // Strip comments so the "no forbidden usage" scan checks executable code, not
  // the doc-comments that intentionally *name* the things we must never use.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/.*$/gm, "$1");
  const routeSrc = stripComments(readFileSync(resolve(root, "src/app/api/health/route.ts"), "utf8"));
  const libSrc = stripComments(readFileSync(resolve(root, "src/lib/deployment-version.ts"), "utf8"));

  // Route delegates to the pure resolver and still returns 200/JSON.
  check("S1 route imports deploymentVersion", /deploymentVersion/.test(routeSrc) && /@\/lib\/deployment-version/.test(routeSrc));
  check("S2 route spreads version into NextResponse.json", /NextResponse\.json/.test(routeSrc) && /\.\.\.deploymentVersion\(\)/.test(routeSrc));

  // The three inputs are exactly the allowed Railway vars.
  check("S3 uses RAILWAY_GIT_COMMIT_SHA", /RAILWAY_GIT_COMMIT_SHA/.test(libSrc));
  check("S4 uses RAILWAY_DEPLOYMENT_ID", /RAILWAY_DEPLOYMENT_ID/.test(libSrc));
  check("S5 uses RAILWAY_ENVIRONMENT_NAME", /RAILWAY_ENVIRONMENT_NAME/.test(libSrc));

  // No git invocation, no .git read, no full-env dump, no secret names referenced.
  const combined = routeSrc + "\n" + libSrc;
  check("S6 no child_process / git command at request time", !/child_process|execSync|spawnSync|\bgit\b/.test(combined));
  check("S7 no .git filesystem read", !/\.git\b/.test(combined) && !/readFileSync|readFile\(/.test(combined));
  check("S8 no secret env names referenced in health code", !/OPENAI_API_KEY|DATABASE_URL|SESSION_SECRET|SECRET_ACCESS_KEY/.test(combined));
  check("S9 no full process.env dump (Object.keys/entries/JSON of env)", !/JSON\.stringify\(\s*process\.env|Object\.(keys|entries|assign)\(\s*process\.env/.test(combined));
  check("S10 no Railway project/environment/service ID exposed", !/RAILWAY_PROJECT_ID|RAILWAY_ENVIRONMENT_ID|RAILWAY_SERVICE_ID/.test(combined));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
