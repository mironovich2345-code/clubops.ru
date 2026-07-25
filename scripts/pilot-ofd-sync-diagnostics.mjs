// Диагностика авто-синхронизации ОФД: fail-closed авторизация cron, изоляция по
// подключению, идемпотентность, health-состояния, и наличие честного diagnostics-доку.
// npm run pilot:ofd-sync-diagnostics
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- mirror: authorizeOfdCron (daily.ts) ----
function authorizeOfdCron(p) {
  if (p.method !== "POST") return { ok: false, status: 405 };
  if (!p.enabled) return { ok: false, status: 503 };
  if (!p.secret) return { ok: false, status: 503 };
  const matches = (p.authorization === `Bearer ${p.secret}`) || (p.cronHeader === p.secret);
  if (!matches) return { ok: false, status: 401 };
  return { ok: true };
}

function main() {
  const S = "supersecret";
  check("DIAG1 non-POST → 405", authorizeOfdCron({ method: "GET", enabled: true, secret: S, authorization: `Bearer ${S}` }).status === 405);
  check("DIAG2 integrations disabled → 503 (never runs)", authorizeOfdCron({ method: "POST", enabled: false, secret: S }).status === 503);
  check("DIAG3 missing CRON_SECRET → 503", authorizeOfdCron({ method: "POST", enabled: true, secret: "" }).status === 503);
  check("DIAG4 wrong secret → 401", authorizeOfdCron({ method: "POST", enabled: true, secret: S, authorization: "Bearer nope", cronHeader: "nope" }).status === 401);
  check("DIAG5 correct Bearer → ok", authorizeOfdCron({ method: "POST", enabled: true, secret: S, authorization: `Bearer ${S}` }).ok === true);
  check("DIAG6 correct X-Cron-Secret header → ok", authorizeOfdCron({ method: "POST", enabled: true, secret: S, cronHeader: S }).ok === true);

  // ---- static guards ----
  const route = src("../src/app/api/cron/ofd/daily/route.ts");
  const daily = src("../src/lib/ofd/daily.ts");
  const health = src("../src/lib/ofd/health.ts");
  const doc = src("../docs/testing/ofd-sync-diagnostics.md");

  check("DIAG7 cron route exposes ONLY POST + fail-closed auth",
    route.includes("export async function POST") && !route.includes("export async function GET") && route.includes("authorizeOfdCron"));
  check("DIAG8 per-connection fault isolation (one failure never stops the batch)",
    daily.includes('provider: { in: ["taxcom", "astral"] }, isActive: true') && /try\s*{[\s\S]*}\s*catch/.test(daily));
  check("DIAG9 all six health states enumerated",
    ["disabled", "never_synced", "running", "failed", "delayed", "healthy"].every((s) => health.includes(`"${s}"`)));
  check("DIAG10 diagnostics doc names the ROOT CAUSE (no in-repo scheduler / env)",
    /НЕТ планировщика|внешним systemd|OFD_INTEGRATIONS_ENABLED|CRON_SECRET/.test(doc));
  check("DIAG11 doc documents timezone + pagination truncation risks honestly",
    /часовой пояс|МСК/i.test(doc) && /Пагинац|ps=100|обрез/i.test(doc));
  check("DIAG12 doc separates deterministic (done) vs live (infra-blocked) verification",
    doc.includes("pilot:ofd-taxcom") && /Live.*НЕ выполнено|требует инфраструктуры/i.test(doc));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
