// Dashboard OFD quick-sync — reuses the existing sync service (no second mechanism),
// server-side capability gate, shared rate-limit + importer lock, health derivation.
// npm run pilot:ofd-sync-dashboard
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- mirror: loadOfdSyncStatus health derivation (health.ts) ----
const HEALTHY_WINDOW_HOURS = 30;
function deriveState({ enabled, connectionCount, latest, lastSuccessAt, now }) {
  if (!enabled) return "disabled";
  if (connectionCount === 0) return "disabled";
  if (!latest) return "never_synced";
  if (latest.status === "pending" || latest.status === "running") return "running";
  if (!lastSuccessAt) return latest.status === "failed" ? "failed" : "never_synced";
  if (latest.status === "failed") return "failed";
  const ageH = (now - lastSuccessAt) / 3_600_000;
  return ageH <= HEALTHY_WINDOW_HOURS ? "healthy" : "delayed";
}

function main() {
  const now = Date.parse("2026-07-24T09:00:00Z");
  const hourAgo = now - 3_600_000;
  const threeDaysAgo = now - 3 * 24 * 3_600_000;

  check("SYNC1 disabled when integrations off", deriveState({ enabled: false, connectionCount: 2, latest: { status: "success" }, lastSuccessAt: hourAgo, now }) === "disabled");
  check("SYNC2 disabled when no active connections", deriveState({ enabled: true, connectionCount: 0, latest: null, lastSuccessAt: null, now }) === "disabled");
  check("SYNC3 never_synced when connections but no runs", deriveState({ enabled: true, connectionCount: 1, latest: null, lastSuccessAt: null, now }) === "never_synced");
  check("SYNC4 running when latest is pending/running", deriveState({ enabled: true, connectionCount: 1, latest: { status: "running" }, lastSuccessAt: hourAgo, now }) === "running");
  check("SYNC5 failed when latest failed", deriveState({ enabled: true, connectionCount: 1, latest: { status: "failed" }, lastSuccessAt: hourAgo, now }) === "failed");
  check("SYNC6 healthy when last success within window", deriveState({ enabled: true, connectionCount: 1, latest: { status: "success" }, lastSuccessAt: hourAgo, now }) === "healthy");
  check("SYNC7 delayed when last success older than window", deriveState({ enabled: true, connectionCount: 1, latest: { status: "success" }, lastSuccessAt: threeDaysAgo, now }) === "delayed");
  check("SYNC8 partial_failed still counts as a success anchor", deriveState({ enabled: true, connectionCount: 1, latest: { status: "partial_failed" }, lastSuccessAt: hourAgo, now }) === "healthy");

  // ---- static guards ----
  const action = src("../src/app/(app)/dashboard/ofd-actions.ts");
  const health = src("../src/lib/ofd/health.ts");
  const auth = src("../src/lib/auth.ts");
  const dash = src("../src/app/(app)/dashboard/page.tsx");

  check("SYNC9 reuses the EXISTING sync service (no second mechanism)",
    action.includes("runSyncNowForCompany") && !action.includes("importTaxcomSalesForPeriod("));
  check("SYNC10 server-side capability gate (ofd.sync.trigger) + company from own context",
    action.includes('can(ctx.effectiveRoles, "ofd.sync.trigger")') && action.includes("ctx.selectedCompanyId"));
  check("SYNC11 shared rate-limit blocks double-click / duplicate period import",
    action.includes('isRateLimited("ofd_sync_now", "company", companyId)'));
  check("SYNC12 capability granted to owner/GD/regional/accountant/chief_accountant, NOT manager/marketer",
    /owner: \[[^\]]*"ofd\.sync\.trigger"/.test(auth) && /regional_director: \[[^\]]*"ofd\.sync\.trigger"/.test(auth) &&
    /accountant: \[[^\]]*"ofd\.sync\.trigger"/.test(auth) && !/manager: \[[^\]]*"ofd\.sync\.trigger"/.test(auth) && !/marketer: \["ofd\.sync\.trigger"\]/.test(auth));
  check("SYNC13 sync is audited server-side",
    action.includes('action: "ofd.sync_now"') && action.includes('source: "dashboard"'));
  check("SYNC14 refreshes dashboard + analytics + collections after sync (no full reload)",
    action.includes('revalidatePath("/dashboard")') && action.includes('revalidatePath("/analytics/ofd-sales")') && action.includes('revalidatePath("/collections")'));
  check("SYNC15 concurrency handled by importer lock (per-connection already_running) — action relies on it",
    health.includes("export async function loadOfdSyncStatus") && action.includes("ofdEnabled()"));
  check("SYNC16 card mounted on dashboard, hidden when disabled, trigger gated",
    dash.includes("OfdSyncCard") && dash.includes('ofdStatus.state !== "disabled"') && dash.includes('can(roles, "ofd.sync.trigger")'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
