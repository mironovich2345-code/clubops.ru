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
const docs = read("docs/YANDEX_DEPLOYMENT.md");
const chkPkg = read("scripts/check-runtime-packages.sh");
const docsSec = read("docs/CONTAINER_SECURITY.md");

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

// ---- VM registry auth via metadata IAM token (no static key, no persistence) ----
// The --check block: from the CHECK_ONLY guard to its exit 0.
const checkBlock = (() => {
  const i = deploySh.indexOf('if [ "$CHECK_ONLY" = "1" ]');
  const j = deploySh.indexOf("exit 0", i);
  return i >= 0 && j >= 0 ? deploySh.slice(i, j) : "";
})();

check("A1 uses the metadata token endpoint 169.254.169.254", /169\.254\.169\.254\/computeMetadata\/v1\/instance\/service-accounts\/default\/token/.test(deploySh));
check("A2 sends Metadata-Flavor: Google header", /Metadata-Flavor:\s*Google/.test(deploySh));
check("A3 docker login username is iam", /docker login --username iam/.test(deploySh));
check("A4 login uses --password-stdin", /--password-stdin/.test(deploySh));
check("A5 token never passed as a docker login argument", !/docker login[^\n]*--password\s+[^-\s]/.test(deploySh) && !/docker login[^\n]*\$IAM_TOKEN/.test(deploySh));
check("A6 temp DOCKER_CONFIG via mktemp -d + export", /mktemp -d/.test(deploySh) && /export DOCKER_CONFIG=/.test(deploySh));
check("A7 umask 077 before creating the config", /umask 077/.test(deploySh));
check("A8 cleanup trap on EXIT + INT/TERM", /trap cleanup EXIT/.test(deploySh) && /trap .*INT TERM/.test(deploySh));
check("A9 temp docker config removed", /rm -rf "\$DOCKER_CONFIG_DIR"/.test(deploySh));
check("A10 IAM_TOKEN is unset", /unset IAM_TOKEN/.test(deploySh));
check("A11 DOCKER_CONFIG is unset in cleanup", /unset IAM_TOKEN DOCKER_CONFIG/.test(deploySh));
check("A12 no YC_SA_KEY_JSON anywhere on the VM side", !/YC_SA_KEY_JSON/.test(deploySh) && !/YC_SA_KEY_JSON/.test(compose) && !/YC_SA_KEY_JSON/.test(svc) && !/YC_SA_KEY_JSON/.test(installSh));
check("A13 no static key / configure-docker / --password literal", !/configure-docker/.test(deploySh) && !/docker login[^\n]*--password\s+["']?[A-Za-z0-9]/.test(deploySh));
check("A14 no hardcoded IAM token / access_token value", !/t1\.9eu[A-Za-z0-9._-]{10}/.test(deploySh) && !/"access_token"\s*:\s*"[A-Za-z0-9]/.test(deploySh));
check("A15 systemd unit carries no token/secret Environment", !/IAM_TOKEN|YC_SA_KEY_JSON|access_token/.test(svc) && !/Environment=[^\n]*(TOKEN|SECRET|PASSWORD|KEY_JSON)/.test(svc));
check("A16 curl has connect/max timeouts + retries", /--connect-timeout/.test(deploySh) && /--max-time/.test(deploySh) && /--retry/.test(deploySh));
check("A17 auth happens BEFORE remote digest + pull", deploySh.indexOf("setup_docker_config\nregistry_login") > 0 && deploySh.indexOf("setup_docker_config\nregistry_login") < deploySh.indexOf('REMOTE_DIGEST="$(remote_digest)"') && deploySh.indexOf('REMOTE_DIGEST="$(remote_digest)"') < deploySh.indexOf('docker pull "$NEW_IMAGE"'));
check("A18 does not enable `set -x` (would echo the token)", !/^\s*set\s+-x/m.test(deploySh) && !/set -[A-Za-z]*x/.test(deploySh.replace("set -Eeuo pipefail", "")));
check("A19 re-authenticates right before pull", (deploySh.match(/registry_login/g) || []).length >= 3);
check("A20 does not print raw metadata response / token", !/log[^\n]*\$IAM_TOKEN/.test(deploySh) && !/echo[^\n]*\$IAM_TOKEN/.test(deploySh) && !/log[^\n]*\$resp/.test(deploySh));

// --check must NOT pull / migrate / backup / compose up / touch state.
check("A21 --check does not pull/migrate/backup/compose-up/write-state", checkBlock.length > 0 && !/docker pull/.test(checkBlock) && !/compose run --rm migrate/.test(checkBlock) && !/pg_dump/.test(checkBlock) && !/compose up/.test(checkBlock) && !/> "\$STATE_FILE"/.test(checkBlock));
check("A22 --check verifies temp-only config (no persistent creds)", /\/root\/\.docker\/config\.json/.test(deploySh) && /\$HOME\/\.docker\/config\.json/.test(deploySh) && /persistent registry credentials/.test(deploySh));

// VM (iam) and CI (json_key) use DIFFERENT auth schemes.
check("A23 VM uses iam token, not json_key", /--username iam/.test(deploySh) && !/json_key/.test(deploySh));
check("A24 CI workflow uses json_key, not the metadata iam token", /json_key/.test(wf) && !/--username iam/.test(wf) && !/169\.254\.169\.254/.test(wf));

// install script checks the metadata-auth deps.
check("A25 install checks curl + python3 + flock", /curl/.test(installSh) && /python3/.test(installSh) && /flock/.test(installSh) && /missing/.test(installSh));

// docs record the VM auth model.
check("A26 docs document club-ops-vm + puller + metadata token, no persistent key", /club-ops-vm/.test(docs) && /images\.puller/.test(docs) && /169\.254\.169\.254/.test(docs) && /Metadata-Flavor/.test(docs) && /No static key|no persistent|no long-lived registry secret/i.test(docs));

// ---- image security hardening (Debian updates + minimisation) ----
check("SEC1 Dockerfile runs apt-get update", /apt-get update/.test(dockerfile));
check("SEC2 Dockerfile runs apt-get upgrade -y", /apt-get upgrade -y/.test(dockerfile));
check("SEC3 uses --no-install-recommends", /--no-install-recommends/.test(dockerfile));
check("SEC4 apt lists removed (no stale cache in image)", /rm -rf \/var\/lib\/apt\/lists/.test(dockerfile) && /apt-get clean/.test(dockerfile));
check("SEC5 APT_REFRESH arg used immediately before apt update", /ARG APT_REFRESH/.test(dockerfile) && /APT refresh: \$\{APT_REFRESH\}"[\s\S]{0,80}apt-get update/.test(dockerfile));
check("SEC6 runner installs no wget/curl (surface minimised)", !/apt-get install[^\n]*\bwget\b/.test(dockerfile) && !/apt-get install[^\n]*\bcurl\b/.test(dockerfile));
check("SEC7 HEALTHCHECK uses the Node runtime (not wget)", /HEALTHCHECK[\s\S]{0,240}CMD \["node"/.test(dockerfile) && /\/api\/health/.test(dockerfile));
check("SEC8 compose app healthcheck uses node, not wget", /test: \["CMD", "node"/.test(compose) && !/wget -/.test(compose));
check("SEC9 deploy.sh health probe uses node, not wget", /compose exec -T app node -e/.test(deploySh) && !/exec -T app wget/.test(deploySh));
check("SEC10 workflow pulls a fresh base image", /pull:\s*true/.test(wf));
check("SEC11 workflow passes APT_REFRESH build-arg", /APT_REFRESH=\$\{\{ github\.sha \}\}/.test(wf));
check("SEC12 workflow verifies the built image BEFORE push", wf.indexOf("check-runtime-packages.sh") > 0 && wf.indexOf("check-runtime-packages.sh") < wf.indexOf("docker push") && /push: false/.test(wf) && /load: true/.test(wf));
check("SEC13 check script enforces libgnutls30 >= fix + amd64 + fails hard", /3\.7\.9-2\+deb12u7/.test(chkPkg) && /dpkg --compare-versions/.test(chkPkg) && /dpkg --print-architecture/.test(chkPkg) && /amd64/.test(chkPkg) && /exit 1/.test(chkPkg));
check("SEC14 check script prints no env/secrets", !/printenv/.test(chkPkg) && !/\$\{?(SESSION_SECRET|DATABASE_URL|S3_SECRET|SMTP_PASSWORD|OPENAI_API_KEY|OTP_SECRET|ACCOUNT_RECOVERY)/.test(chkPkg));
check("SEC15 CONTAINER_SECURITY docs analyse the 3 remaining Criticals + policy", /CVE-2026-8376/.test(docsSec) && /CVE-2026-42496/.test(docsSec) && /CVE-2023-45853/.test(docsSec) && /32-bit/.test(docsSec) && /Archive::Tar/.test(docsSec) && /MiniZip/.test(docsSec) && /blocks production/i.test(docsSec));
check("SEC16 base unchanged: Node 20 Bookworm + non-root (not weakened)", /node:20-bookworm-slim/.test(dockerfile) && /USER nodejs/.test(dockerfile));
check("SEC17 no auto testing/unstable repos or unofficial .deb", !/testing|unstable|trixie|sid/.test(dockerfile) && !/dpkg -i|wget[^\n]*\.deb|curl[^\n]*\.deb/.test(dockerfile));

// ---- no real secrets committed anywhere in the deploy surface ----
const surface = [dockerfile, compose, caddy, deploySh, installSh, wf, entry].join("\n");
check("X1 no private key blocks", !/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/.test(surface));
check("X2 no AWS/YC access-key literals", !/AKIA[0-9A-Z]{16}/.test(surface) && !/aws_secret_access_key\s*=/i.test(surface));
check("X3 no inline DATABASE_URL with credentials", !/postgres(ql)?:\/\/[^\s"']*:[^\s"'@]+@/.test(surface));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
