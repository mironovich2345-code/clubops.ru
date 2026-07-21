// Security-hardening phase 1 — behavioural mirrors of the shipped guards + a real-DB
// test of the cash "Директор → Клуб" direct-manager rule, plus static wiring guards.
// Covers: OpenAI prod ban, secret length policy, timing-safe compare, CSP/headers,
// Company-creation restriction, cash direct-role confirmation, xlsx limits, compose.
// npm run pilot:security-hardening
import { readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- AI provider policy (mirror of openai-client.ts) ----
const selectedProvider = (env) => {
  if (env.AI_PROVIDER === "yandex" && env.YANDEX_AI_API_KEY && env.YANDEX_FOLDER_ID) return "yandex";
  if (env.AI_PROVIDER === "openai" && env.OPENAI_API_KEY) {
    if (env.NODE_ENV === "production") return "mock"; // fail-closed: never openai in prod
    return "openai";
  }
  if (env.AI_PROVIDER === "ru_ai" && env.RU_AI_ENDPOINT && env.RU_AI_API_KEY) return "ru_ai";
  return "mock";
};
const openAiHttpBlocked = (env) => env.NODE_ENV === "production"; // chatCompletion refuses in prod

// ---- secret policy (mirror of env-secrets.ts) ----
const resolveSecret = (env, name, { minLength, devFallback }) => {
  const value = env[name];
  const isProd = env.NODE_ENV === "production";
  if (value && value.length > 0) {
    if (isProd && value.length < minLength) throw new Error(`${name} must be at least ${minLength} characters in production`);
    return value;
  }
  if (isProd) throw new Error(`${name} is required in production`);
  return devFallback;
};

// ---- timing-safe compare (mirror of secure-compare.ts) ----
const secretEquals = (p, e) => {
  if (typeof e !== "string" || e.length === 0) return false;
  const a = Buffer.from(typeof p === "string" ? p : "", "utf8");
  const b = Buffer.from(e, "utf8");
  if (a.length !== b.length) { timingSafeEqual(b, b); return false; }
  return timingSafeEqual(a, b);
};
const bearerEquals = (h, e) => {
  if (typeof e !== "string" || e.length === 0) return false;
  const pre = "Bearer ";
  const hh = typeof h === "string" ? h : "";
  if (!hh.startsWith(pre)) { secretEquals("", e); return false; }
  return secretEquals(hh.slice(pre.length), e);
};

// ---- CSP (mirror of middleware.ts buildCsp) ----
const buildCsp = (nonce, isProd) => [
  "default-src 'self'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  "frame-src 'self'", "object-src 'none'", "img-src 'self' data: blob:", "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'nonce-${nonce}'${isProd ? "" : " 'unsafe-eval'"}`,
  `connect-src 'self'${isProd ? "" : " ws: wss:"}`, "worker-src 'self' blob:", "media-src 'self'", "manifest-src 'self'",
].join("; ");

async function main() {
  // ===== AI PROVIDER POLICY =====
  check("AI1 prod + yandex → yandex", selectedProvider({ NODE_ENV: "production", AI_PROVIDER: "yandex", YANDEX_AI_API_KEY: "k", YANDEX_FOLDER_ID: "f" }) === "yandex");
  check("AI2 prod + openai(+key) → mock (never openai)", selectedProvider({ NODE_ENV: "production", AI_PROVIDER: "openai", OPENAI_API_KEY: "k" }) === "mock");
  check("AI3 dev + openai(+key) → openai (allowed outside prod)", selectedProvider({ NODE_ENV: "development", AI_PROVIDER: "openai", OPENAI_API_KEY: "k" }) === "openai");
  check("AI4 prod fallback never openai", selectedProvider({ NODE_ENV: "production", AI_PROVIDER: "banana", OPENAI_API_KEY: "k" }) === "mock");
  check("AI5 OpenAI HTTP client blocked in production (no request)", openAiHttpBlocked({ NODE_ENV: "production" }) === true && openAiHttpBlocked({ NODE_ENV: "development" }) === false);
  const openai = src("../src/lib/ai/openai-client.ts");
  check("AI-S1 selectedAiProvider blocks openai in prod (returns mock)", openai.includes("if (isProductionRuntime()) {") && /warnOpenAiBlockedOnce\(\);\s*return "mock";/.test(openai));
  check("AI-S2 chatCompletion refuses in prod BEFORE any fetch/key read", (() => { const b = openai.slice(openai.indexOf("async function chatCompletion")); return b.indexOf('if (isProductionRuntime())') < b.indexOf("process.env.OPENAI_API_KEY") && b.indexOf('if (isProductionRuntime())') < b.indexOf("fetch("); })());
  check("AI-S3 health surfaces a safe policy code (no keys/docs)", src("../src/app/api/health/route.ts").includes("policy: aiProviderDiagnostic()") && openai.includes('return "openai_forbidden_in_production"'));
  check("AI-S4 block message carries no key/document/OCR text", openai.includes('message: "openai_forbidden_in_production"'));

  // ===== SECRETS =====
  let threwMissing = false, threwShort = false;
  try { resolveSecret({ NODE_ENV: "production" }, "SESSION_SECRET", { minLength: 32, devFallback: "x" }); } catch (e) { threwMissing = /SESSION_SECRET is required/.test(e.message) && !e.message.includes("x"); }
  try { resolveSecret({ NODE_ENV: "production", SESSION_SECRET: "short" }, "SESSION_SECRET", { minLength: 32, devFallback: "x" }); } catch (e) { threwShort = /at least 32/.test(e.message) && !e.message.includes("short"); }
  check("SEC1 prod + missing secret → fail closed (name only)", threwMissing);
  check("SEC2 prod + secret < 32 → fail closed (length, not value)", threwShort);
  check("SEC3 prod + secret >= 32 → accepted", resolveSecret({ NODE_ENV: "production", SESSION_SECRET: "a".repeat(32) }, "SESSION_SECRET", { minLength: 32, devFallback: "x" }) === "a".repeat(32));
  check("SEC4 dev + missing → dev fallback (not prod-like)", resolveSecret({ NODE_ENV: "development" }, "OTP_SECRET", { minLength: 32, devFallback: "dev-insecure-otp" }) === "dev-insecure-otp");
  check("SEC-S1 tokens.ts + otp.ts enforce >= 32 via resolveSecret", src("../src/lib/tokens.ts").includes('resolveSecret("SESSION_SECRET"') && src("../src/lib/tokens.ts").includes("minLength: SESSION_SECRET_MIN_LENGTH") && src("../src/lib/otp.ts").includes('resolveSecret("OTP_SECRET"') && src("../src/lib/otp.ts").includes("OTP_SECRET_MIN_LENGTH = 32"));

  // ===== TIMING-SAFE COMPARE =====
  const secret = "s".repeat(40);
  check("TS1 correct secret matches", secretEquals(secret, secret) === true);
  check("TS2 wrong secret rejected", secretEquals("wrong", secret) === false);
  check("TS3 different length handled (no crash) + rejected", secretEquals("short", secret) === false && secretEquals(secret + "x", secret) === false);
  check("TS4 missing/empty server secret → false (fail closed)", secretEquals(secret, "") === false && secretEquals(secret, null) === false);
  check("TS5 bearer: correct prefix matches, missing prefix rejected", bearerEquals(`Bearer ${secret}`, secret) === true && bearerEquals(secret, secret) === false && bearerEquals("Bearer wrong", secret) === false);
  check("TS-S1 cron/drain/webhook use timing-safe secure-compare", src("../src/lib/ofd/daily.ts").includes("bearerEquals(p.authorization, p.secret)") && src("../src/app/api/internal/notifications/drain/route.ts").includes("bearerEquals(req.headers.get(\"authorization\")") && src("../src/app/api/telegram/webhook/route.ts").includes("secretEquals(req.headers.get(\"x-telegram-bot-api-secret-token\")"));

  // ===== HEADERS =====
  const cspProd = buildCsp("NONCE", true);
  check("H1 script-src uses a nonce and NOT 'unsafe-inline'", cspProd.includes("script-src 'self' 'nonce-NONCE'") && !/script-src[^;]*'unsafe-inline'/.test(cspProd));
  check("H2 frame-ancestors none + object-src none retained", cspProd.includes("frame-ancestors 'none'") && cspProd.includes("object-src 'none'"));
  const nextcfg = src("../next.config.mjs");
  const mw = src("../src/middleware.ts");
  const layout = src("../src/app/layout.tsx");
  check("H-S1 next.config: no CSP header (moved to middleware) + poweredByHeader:false", !nextcfg.includes('key: "Content-Security-Policy"') && nextcfg.includes("poweredByHeader: false"));
  check("H-S2 middleware: nonce CSP without script 'unsafe-inline' + Permissions-Policy", mw.includes("script-src 'self' 'nonce-${nonce}'") && !/script-src 'self' 'nonce-\$\{nonce\}'[^`]*unsafe-inline/.test(mw) && mw.includes('response.headers.set("permissions-policy"'));
  check("H-S3 layout applies the request nonce to the theme script", layout.includes('headers()).get("x-nonce")') && layout.includes("<script nonce={nonce}"));

  // ===== COMPANY CREATION =====
  const settingsActions = src("../src/app/(app)/settings/actions.ts");
  const settingsPage = src("../src/app/(app)/settings/page.tsx");
  check("CO-S1 createCompany requires system_admin (getCurrentSystemAdmin), no tenant path", settingsActions.includes("const admin = await getCurrentSystemAdmin();") && settingsActions.includes("Создание новой организации доступно только администратору платформы.") && !/createCompany[\s\S]{0,400}canAnyRoleAccessPage\(ctx\.effectiveRoles, "settings"\)/.test(settingsActions));
  check("CO-S2 create-company UI removed from settings page", !settingsPage.includes("<AddCompanyForm"));
  check("CO-S3 onboarding (primary path) still gated by no-existing-access", src("../src/app/onboarding/actions.ts").includes("if (companyAccess || clubAccess) redirect(\"/dashboard\")"));

  // ===== CASH "ДИРЕКТОР → КЛУБ" DIRECT-MANAGER (real DB) =====
  const directRole = async (userId, clubId, role) => {
    const c = await prisma.clubUserAccess.findFirst({ where: { userId, clubId, role }, select: { id: true } });
    if (c) return true;
    const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
    if (!club) return false;
    const co = await prisma.companyUserAccess.findFirst({ where: { userId, companyId: club.companyId, role }, select: { id: true } });
    return co !== null;
  };
  const T = Date.now();
  const company = await prisma.company.create({ data: { name: `cashtest_${T}` } });
  const club = await prisma.club.create({ data: { name: `k_${T}`, city: "—", companyId: company.id } });
  const mk = (suffix, role) => prisma.user.create({ data: { email: `${role}_${T}_${suffix}@t.local`, name: role, role: "manager" } });
  const uReg = await mk("reg", "regional_director");
  const uMgr = await mk("mgr", "manager");
  const uCoMgr = await mk("comgr", "comanager");
  await prisma.clubUserAccess.create({ data: { clubId: club.id, userId: uReg.id, role: "regional_director" } });
  await prisma.clubUserAccess.create({ data: { clubId: club.id, userId: uMgr.id, role: "manager" } });
  await prisma.companyUserAccess.create({ data: { companyId: company.id, userId: uCoMgr.id, role: "manager" } });
  try {
    check("CASH1 regional director is NOT a direct manager (cannot self-confirm)", (await directRole(uReg.id, club.id, "manager")) === false);
    check("CASH2 a direct club manager IS a direct manager", (await directRole(uMgr.id, club.id, "manager")) === true);
    check("CASH3 a company-level manager counts as a direct manager", (await directRole(uCoMgr.id, club.id, "manager")) === true);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [uReg.id, uMgr.id, uCoMgr.id] } } });
    await prisma.company.delete({ where: { id: company.id } }); // cascades club + accesses
  }
  check("CASH-S1 confirm action uses userHasDirectClubRole (ignores implications)", src("../src/app/(app)/expenses/cash-actions.ts").includes("userHasDirectClubRole(c.ctx.user.id, c.clubId, \"manager\")") && src("../src/lib/access.ts").includes("export async function userHasDirectClubRole"));
  check("CASH-S2 direct-role check does NOT expand ROLE_IMPLICATIONS", (() => { const b = src("../src/lib/access.ts"); const s = b.indexOf("export async function userHasDirectClubRole"); const body = b.slice(s, s + 700); return body.includes("role }") && !body.includes("anyRoleSatisfies") && !body.includes("ROLE_IMPLICATIONS"); })());

  // ===== XLSX LIMITS =====
  const excel = src("../src/lib/excel-import.ts");
  check("XLSX-S1 workbook bounds: size/sheets/rows/cols + typed WorkbookLimitError", excel.includes("MAX_WORKBOOK_BYTES = 5 * 1024 * 1024") && excel.includes("MAX_WORKBOOK_SHEETS") && excel.includes("MAX_WORKBOOK_ROWS") && excel.includes("class WorkbookLimitError"));
  check("XLSX-S2 parse errors are caught (no stack trace) + import actions handle them", excel.includes("throw new WorkbookLimitError(\"Не удалось прочитать файл") && src("../src/app/(app)/budgets/budget-import-actions.ts").includes("e instanceof WorkbookLimitError"));

  // ===== PRODUCTION COMPOSE =====
  const altCompose = src("../docker-compose.production.yml");
  check("COMPOSE-S1 alt compose no longer publishes 3000 on all interfaces", !/^\s*-\s*"3000:3000"/m.test(altCompose) && altCompose.includes('"127.0.0.1:3000:3000"'));
  check("COMPOSE-S2 alt compose marked NON-CANONICAL, points to hardened stack", altCompose.includes("NON-CANONICAL") && altCompose.includes("deploy/docker-compose.prod.yml"));

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
