// Behavioural (real dev SQLite DB) test of the DB-backed fixed-window rate limiter.
// Executes the SAME upsert-increment logic the server uses (rate-limit.ts) against
// real RateLimitBucket rows: per-account and per-IP caps, id/company isolation,
// window expiry, concurrent increments, and privacy (no raw email/IP is stored —
// only an HMAC hash). Uses injectable `now` + unique identifiers, and cleans up.
// npm run pilot:rate-limit
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// --- exact mirror of rate-limit.ts (with a fixed test key; behaviour is key-agnostic) ---
const KEY = "pilot-fixed-hmac-key-32-bytes-minimum!!";
const hashId = (idType, id) => createHmac("sha256", KEY).update(`ratelimit:${idType}:${id}`).digest("hex");
const bucketKeyFor = (action, idType, idHash, w) => createHmac("sha256", "ratelimit-bucket").update(`${action}|${idType}|${idHash}|${w}`).digest("hex");
const MIN = 60_000, HOUR = 60 * MIN;
const RULES = {
  "login:email": { limit: 10, windowMs: 15 * MIN },
  "login:ip": { limit: 30, windowMs: 15 * MIN },
  "register:ip": { limit: 5, windowMs: HOUR },
  "ai_analyze:user": { limit: 20, windowMs: HOUR },
  "ai_analyze_company:company": { limit: 100, windowMs: HOUR },
  "ofd_sync_now:company": { limit: 1, windowMs: 5 * MIN },
  "telegram_link:user": { limit: 5, windowMs: HOUR },
};
const createdKeys = new Set();
async function record(action, idType, id, now) {
  const rule = RULES[`${action}:${idType}`];
  const w = Math.floor(now / rule.windowMs);
  const bucketKey = bucketKeyFor(action, idType, hashId(idType, id), w);
  createdKeys.add(bucketKey);
  const row = await prisma.rateLimitBucket.upsert({
    where: { bucketKey },
    create: { bucketKey, action, windowStart: new Date(w * rule.windowMs), count: 1, expiresAt: new Date((w + 1) * rule.windowMs) },
    update: { count: { increment: 1 } },
    select: { count: true },
  });
  return { allowed: row.count <= rule.limit, count: row.count, bucketKey };
}

async function main() {
  const T = Date.now();
  const email = `ratetest_${T}@example.com`;
  const ip = `203.0.113.${T % 200}`;
  const now0 = T; // window base

  try {
    // RL1 — per-account login cap: 10 allowed, 11th blocked.
    let last;
    for (let i = 0; i < 10; i++) last = await record("login", "email", email, now0);
    check("RL1 account: 10 attempts allowed", last.allowed === true && last.count === 10);
    const eleventh = await record("login", "email", email, now0);
    check("RL1b account: 11th attempt blocked", eleventh.allowed === false && eleventh.count === 11);

    // RL2 — per-IP login cap: 30 allowed, 31st blocked.
    let ipLast;
    for (let i = 0; i < 30; i++) ipLast = await record("login", "ip", ip, now0);
    check("RL2 IP: 30 attempts allowed", ipLast.allowed === true);
    check("RL2b IP: 31st attempt blocked", (await record("login", "ip", ip, now0)).allowed === false);

    // RL3 — different accounts do NOT share a counter (isolation).
    const other = await record("login", "email", `other_${T}@example.com`, now0);
    check("RL3 different account has its own counter", other.count === 1 && other.allowed === true);

    // RL4 — company AI cap isolation.
    const cA = await record("ai_analyze_company", "company", `coA_${T}`, now0);
    const cB = await record("ai_analyze_company", "company", `coB_${T}`, now0);
    check("RL4 different companies isolated", cA.count === 1 && cB.count === 1);

    // RL5 — window expiry: next window frees the limit (new bucket).
    const rule = RULES["login:email"];
    const nextWindow = now0 + rule.windowMs; // +15m → next window index
    const fresh = await record("login", "email", email, nextWindow);
    check("RL5 next window resets the account counter", fresh.count === 1 && fresh.allowed === true);

    // RL6 — PRIVACY: neither the bucketKey nor the stored row contains the raw email/IP.
    const rows = await prisma.rateLimitBucket.findMany({ where: { bucketKey: { in: [...createdKeys] } }, select: { bucketKey: true, action: true } });
    const anyLeak = rows.some((r) => r.bucketKey.includes(email) || r.bucketKey.includes(ip) || r.action.includes("@"));
    check("RL6 no raw email/IP stored (HMAC only)", !anyLeak && eleventh.bucketKey.length === 64 && !eleventh.bucketKey.includes(email));

    // RL7 — OFD sync-now: 1 per 5 min per company; 2nd in-window blocked, cron unaffected concept.
    const co = `syncco_${T}`;
    check("RL7 OFD sync-now: first allowed", (await record("ofd_sync_now", "company", co, now0)).allowed === true);
    check("RL7b OFD sync-now: second in-window blocked", (await record("ofd_sync_now", "company", co, now0)).allowed === false);
    check("RL7c OFD sync-now: allowed again after cooldown window", (await record("ofd_sync_now", "company", co, now0 + 5 * MIN)).allowed === true);

    // RL8 — concurrent increments all accumulate (unique bucketKey serialises them).
    const cc = `concur_${T}`;
    await Promise.all(Array.from({ length: 8 }, () => record("telegram_link", "user", cc, now0)));
    const ccRow = await prisma.rateLimitBucket.findUnique({ where: { bucketKey: bucketKeyFor("telegram_link", "user", hashId("user", cc), Math.floor(now0 / HOUR)) }, select: { count: true } });
    check("RL8 concurrent increments accumulate (no lost updates)", ccRow?.count === 8);

    // RL9 — a successful login does not permanently lock (account counter counts only
    // failures in the app; here we verify a fresh id is never pre-blocked).
    check("RL9 a fresh identifier is never pre-blocked", (await record("register", "ip", `freship_${T}`, now0)).allowed === true);
  } finally {
    if (createdKeys.size) await prisma.rateLimitBucket.deleteMany({ where: { bucketKey: { in: [...createdKeys] } } });
  }

  // Static guards on the shipped limiter + wiring.
  const rl = src("../src/lib/rate-limit.ts");
  const auth = src("../src/app/auth-actions.ts");
  const invoices = src("../src/app/(app)/invoices/actions.ts");
  const ofd = src("../src/app/(app)/settings/integrations/ofd/actions.ts");
  check("S1 limiter stores only HMAC hashes (no raw id), atomic upsert-increment", rl.includes("createHmac(\"sha256\", key)") && rl.includes("prisma.rateLimitBucket.upsert(") && rl.includes("count: { increment: 1 }"));
  check("S2 conservative default limits present", rl.includes('"login:email": { limit: 10, windowMs: 15 * MIN }') && rl.includes('"register:ip": { limit: 5, windowMs: HOUR }') && rl.includes('"ofd_sync_now:company": { limit: 1, windowMs: 5 * MIN }'));
  check("S3 login records IP (every attempt) + account failures only (peek then record)", auth.includes('checkRateLimit("login", "ip"') && auth.includes('peekRateLimit("login", "email"') && auth.includes('await checkRateLimit("login", "email", email)'));
  check("S4 registration + AI + OFD sync-now are rate limited", auth.includes('checkRateLimit("register", "ip"') && invoices.includes('isRateLimited("ai_analyze"') && ofd.includes('isRateLimited("ofd_sync_now", "company"'));
  check("S5 generic message never reveals counters/IP/email", rl.includes('RATE_LIMIT_MESSAGE = "Слишком много попыток. Повторите позже."'));
  check("S6 cron OFD daily is NOT gated by the user rate limiter", !src("../src/app/api/cron/ofd/daily/route.ts").includes("isRateLimited") && !src("../src/lib/ofd/daily.ts").includes("isRateLimited"));

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
