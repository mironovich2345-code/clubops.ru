// Deployment configuration guard (static). Enforces the safety invariants of the
// Yandex Cloud production deploy without touching Docker or any server. Fails the
// build if a compose port is exposed, a secret leaks, the migrate step drifts to
// db push, the timer would auto-enable, etc. npm run pilot:deploy-config
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

const dockerfile = read("Dockerfile");
const dockerignore = read(".dockerignore");
const compose = read("deploy/docker-compose.prod.yml");
const caddy = read("deploy/Caddyfile");
const deploySh = read("deploy/deploy.sh");
const installSh = read("deploy/install-on-server.sh");
const svc = read("deploy/systemd/club-ops-deploy.service");
const timer = read("deploy/systemd/club-ops-deploy.timer");
const wf = read(".github/workflows/deploy-yandex.yml");
const entry = read("docker-entrypoint.sh");
const nextCfg = read("next.config.mjs");
const depVer = read("src/lib/deployment-version.ts");

// ---- Dockerfile ----
check("D1 multi-stage build (base/deps/builder/runner)", /AS base/.test(dockerfile) && /AS builder/.test(dockerfile) && /AS runner/.test(dockerfile));
check("D2 official Node LTS base image", /FROM node:20-bookworm-slim/.test(dockerfile));
check("D3 deterministic install (npm ci)", /npm ci/.test(dockerfile));
check("D4 production build via build:prod (Postgres client)", /npm run build:prod/.test(dockerfile));
check("D5 standalone server copied", /\.next\/standalone/.test(dockerfile) && /\.next\/static/.test(dockerfile));
check("D6 prisma CLI + engines copied for migrate", /node_modules\/prisma/.test(dockerfile) && /node_modules\/@prisma/.test(dockerfile));
check("D7 runs as non-root user", /USER nodejs/.test(dockerfile) && /useradd/.test(dockerfile));
check("D8 NODE_ENV=production + PORT 3000", /ENV NODE_ENV=production/.test(dockerfile) && /ENV PORT=3000/.test(dockerfile) && /EXPOSE 3000/.test(dockerfile));
check("D9 HEALTHCHECK hits /api/health", /HEALTHCHECK/.test(dockerfile) && /\/api\/health/.test(dockerfile));
check("D10 only non-secret build arg APP_GIT_SHA", /ARG APP_GIT_SHA/.test(dockerfile) && !/ARG\s+(SESSION_SECRET|DATABASE_URL|OPENAI|S3_|SMTP|OTP_SECRET|ACCOUNT_RECOVERY)/i.test(dockerfile));
check("D11 no obvious secret literal baked in", !/(SESSION_SECRET|S3_SECRET_ACCESS_KEY|OPENAI_API_KEY|SMTP_PASSWORD)\s*=\s*["'][^"']+["']/i.test(dockerfile));

// ---- .dockerignore ----
check("DI1 ignores .env", /(^|\n)\.env(\n|$)/.test(dockerignore) && /\.env\.\*/.test(dockerignore));
check("DI2 ignores uploads + backups + local db", /(^|\n)uploads(\n|$)/.test(dockerignore) && /backups/.test(dockerignore) && /\*\.db/.test(dockerignore));
check("DI3 does NOT ignore prisma migrations", !/prisma\/migrations/.test(dockerignore) && !/(^|\n)prisma(\n|$)/.test(dockerignore));

// ---- compose ----
check("C1 postgres uses external volume club_ops_postgres_data", /external:\s*true/.test(compose) && /name:\s*club_ops_postgres_data/.test(compose));
check("C2 external network club_ops_internal", /name:\s*club_ops_internal/.test(compose));
check("C3 postgres NOT published (no 5432 host port)", !/5432:5432/.test(compose) && !/"5432"/.test(compose));
check("C4 app port 3000 NOT published to host", !/3000:3000/.test(compose) && !/"3000:3000"/.test(compose));
check("C5 migrate uses `prisma ... migrate deploy` (never db push)", /migrate.*deploy|migrate", "deploy/.test(compose) && !/db push/.test(compose) && !/migrate reset/.test(compose));
check("C6 app waits for successful migrate", /service_completed_successfully/.test(compose) && /migrate:/.test(compose));
check("C7 app waits for healthy postgres", /service_healthy/.test(compose));
check("C8 only caddy publishes 80/443", /"80:80"/.test(compose) && /"443:443"/.test(compose));
check("C9 app image comes from a variable (never built on VM)", /image:\s*\$\{APP_IMAGE\}/.test(compose) && !/build:/.test(compose));
check("C10 log rotation configured", /max-size/.test(compose) && /max-file/.test(compose));
check("C11 restart policies set", /restart:\s*unless-stopped/.test(compose));
check("C12 no seed / reset / destructive command in compose", !/prisma\s+db\s+push/.test(compose) && !/migrate\s+reset/.test(compose) && !/db\s+seed/.test(compose));

// ---- Caddy ----
check("CA1 reverse_proxy to internal app:3000", /reverse_proxy\s+app:3000/.test(caddy));
check("CA2 request body >= 40MB", /max_size\s+40MB/.test(caddy));
check("CA3 uses SITE_DOMAIN", /\{\$SITE_DOMAIN\}/.test(caddy));

// ---- entrypoint ----
check("E1 entrypoint migrates then starts standalone", /migrate\s+deploy/.test(entry) && /node server\.js/.test(entry));
check("E2 entrypoint never db push / reset", !/db push/.test(entry) && !/migrate reset/.test(entry));

// ---- health / version ----
check("H1 next.config standalone output", /output:\s*["']standalone["']/.test(nextCfg));
check("H2 health version supports APP_GIT_SHA priority over Railway", /APP_GIT_SHA/.test(depVer) && /RAILWAY_GIT_COMMIT_SHA/.test(depVer) && depVer.indexOf("APP_GIT_SHA") < depVer.indexOf("RAILWAY_GIT_COMMIT_SHA"));
check("H3 version reads no secret env values (comments may name them)", !/env\.(DATABASE_URL|SESSION_SECRET|OPENAI_API_KEY|SMTP_PASSWORD|S3_SECRET_ACCESS_KEY)/.test(depVer));

// ---- GitHub workflow ----
check("W1 triggers only on main push + manual dispatch", /branches:\s*\[main\]/.test(wf) && /workflow_dispatch/.test(wf));
check("W2 pushes both SHA and main tags to cr.yandex", /club-ops:\$\{\{ github\.sha \}\}/.test(wf) && /club-ops:main/.test(wf) && /cr\.yandex/.test(wf));
check("W3 login via json_key + password-stdin, secret never echoed", /--password-stdin/.test(wf) && /json_key/.test(wf) && !/echo\s+"?\$\{\{\s*secrets\.YC_SA_KEY_JSON/.test(wf));
check("W4 minimal permissions", /permissions:\s*\n\s*contents:\s*read/.test(wf));
check("W5 concurrency + job timeout", /concurrency:/.test(wf) && /timeout-minutes:/.test(wf));
check("W6 passes APP_GIT_SHA build-arg = commit sha", /APP_GIT_SHA=\$\{\{ github\.sha \}\}/.test(wf));
check("W7 image labels present", /org\.opencontainers\.image\.revision/.test(wf) && /org\.opencontainers\.image\.source/.test(wf) && /org\.opencontainers\.image\.created/.test(wf));

// ---- deploy.sh ----
check("S1 strict mode", /set -Eeuo pipefail/.test(deploySh));
check("S2 single-flight lock via flock", /flock/.test(deploySh));
check("S3 pg_dump custom-format backup before change", /pg_dump/.test(deploySh) && /-F c/.test(deploySh) && /backup/i.test(deploySh));
check("S4 backup failure aborts deploy", /backup failed/.test(deploySh) && /die/.test(deploySh));
check("S5 digest gate (no redeploy when unchanged)", /digest/.test(deploySh) && /STATE_FILE/.test(deploySh));
check("S6 migrate runs before app update", deploySh.indexOf("migrate") < deploySh.indexOf("up -d postgres app caddy"));
check("S7 health check + rollback to previous image", /\/api\/health/.test(deploySh) && /rolling app back|roll the APP back|PREV_IMAGE/.test(deploySh));
check("S8 never deletes volume / never prune -a (as a command)", !/^\s*docker\s+system\s+prune\s+-a/m.test(deploySh) && !/^\s*docker\s+volume\s+rm/m.test(deploySh) && !/\bdown\b[^\n]*-v\b/.test(deploySh));
check("S9 keeps limited backups + images", /KEEP_BACKUPS/.test(deploySh) && /KEEP_IMAGES/.test(deploySh));
check("S10 --check mode changes nothing", /--check/.test(deploySh) && /CHECK_ONLY/.test(deploySh));
check("S11 does not print DATABASE_URL / passwords", !/echo.*DATABASE_URL/.test(deploySh) && !/echo.*PASSWORD/i.test(deploySh));

// ---- install-on-server.sh ----
check("I1 requires root", /id -u.*-eq 0|need.*sudo|run with sudo/.test(installSh));
check("I2 never overwrites existing .env", /left untouched|never overwrite/i.test(installSh) && !/install .* \.env/i.test(installSh));
check("I3 backs up existing compose before replacing", /\.bak\./.test(installSh) && /cp -a/.test(installSh));
check("I4 timer NOT enabled by default (needs --enable-timer)", /--enable-timer/.test(installSh) && /ENABLE_TIMER=0/.test(installSh));
check("I5 daemon-reload run", /systemctl daemon-reload/.test(installSh));
check("I6 never removes postgres volume", !/volume\s+rm/.test(installSh) && !/docker volume rm/.test(installSh));

// ---- systemd ----
check("SY1 timer checks ~1 minute", /OnUnitActiveSec=1min/.test(timer));
check("SY2 timer persistent + boot delay", /Persistent=true/.test(timer) && /OnBootSec=/.test(timer));
check("SY3 service is oneshot", /Type=oneshot/.test(svc));
check("SY4 service has NO [Install] section (only timer enables it)", !/^\[Install\]/m.test(svc));

// ---- no real secrets committed anywhere in the deploy surface ----
const surface = [dockerfile, compose, caddy, deploySh, installSh, wf, entry].join("\n");
check("X1 no private key blocks", !/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/.test(surface));
check("X2 no AWS/YC access-key literals", !/AKIA[0-9A-Z]{16}/.test(surface) && !/aws_secret_access_key\s*=/i.test(surface));
check("X3 no inline DATABASE_URL with credentials", !/postgres(ql)?:\/\/[^\s"']*:[^\s"'@]+@/.test(surface));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
