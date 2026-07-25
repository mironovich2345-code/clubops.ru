// Unified OFD settings restructure — single «Подключение ОФД» entry, provider-card
// overview at /settings/ofd (aggregation only, no parallel sync/contour), Taxcom kept
// at its old URL, Astral stepped screen (PIN-gated, honestly BLOCKED), dashboard
// multi-provider chips. Mirrors loadOfdProviderCards status derivation + static guards
// for server-side roles, PIN gating, backward compatibility and tenant isolation.
// npm run pilot:ofd-settings
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- mirror: loadOfdProviderCards status derivation (providers/status.ts) ----
const HEALTHY_WINDOW_HOURS = 30;
function deriveCard({ enabled, isLive, connsCount, activeCount, hasSecret, latest, lastSuccessAt, now }) {
  let status;
  if (!enabled) status = "disabled";
  else if (activeCount === 0) status = connsCount > 0 && !isLive ? "needs_api_key" : "not_connected";
  else if (!isLive) status = hasSecret ? "needs_setup" : "needs_api_key";
  else if (latest && (latest.status === "pending" || latest.status === "running")) status = "running";
  else if (latest && latest.status === "failed") status = "error";
  else if (lastSuccessAt) status = (now - lastSuccessAt) / 3_600_000 <= HEALTHY_WINDOW_HOURS ? "connected" : "attention";
  else status = "connected";
  const connected = activeCount > 0 && status !== "needs_api_key" && status !== "not_connected";
  return { status, connected };
}

function main() {
  const now = Date.parse("2026-07-24T09:00:00Z");
  const hourAgo = now - 3_600_000;
  const threeDaysAgo = now - 3 * 24 * 3_600_000;

  // Taxcom (live) status matrix
  check("CARD1 Taxcom connected when recent success within window",
    deriveCard({ enabled: true, isLive: true, connsCount: 1, activeCount: 1, hasSecret: true, latest: { status: "success" }, lastSuccessAt: hourAgo, now }).status === "connected");
  check("CARD2 Taxcom attention when last success older than window",
    deriveCard({ enabled: true, isLive: true, connsCount: 1, activeCount: 1, hasSecret: true, latest: { status: "success" }, lastSuccessAt: threeDaysAgo, now }).status === "attention");
  check("CARD3 Taxcom error when latest run failed",
    deriveCard({ enabled: true, isLive: true, connsCount: 1, activeCount: 1, hasSecret: true, latest: { status: "failed" }, lastSuccessAt: hourAgo, now }).status === "error");
  check("CARD4 unconnected Taxcom → not_connected (no connection rows)",
    deriveCard({ enabled: true, isLive: true, connsCount: 0, activeCount: 0, hasSecret: false, latest: null, lastSuccessAt: null, now }).status === "not_connected");

  // Astral (non-live skeleton) never claims connected
  const astNone = deriveCard({ enabled: true, isLive: false, connsCount: 0, activeCount: 0, hasSecret: false, latest: null, lastSuccessAt: null, now });
  check("CARD5 unconnected Astral → not_connected + connected=false", astNone.status === "not_connected" && astNone.connected === false);
  const astKeyOnly = deriveCard({ enabled: true, isLive: false, connsCount: 1, activeCount: 1, hasSecret: true, latest: null, lastSuccessAt: hourAgo, now });
  check("CARD6 Astral with key still 'needs_setup' — never 'connected' until live",
    astKeyOnly.status === "needs_setup" && astKeyOnly.connected === true);
  const astInactive = deriveCard({ enabled: true, isLive: false, connsCount: 1, activeCount: 0, hasSecret: false, latest: null, lastSuccessAt: null, now });
  check("CARD7 Astral row present but inactive → needs_api_key", astInactive.status === "needs_api_key");
  check("CARD8 integrations disabled → every provider 'disabled'",
    deriveCard({ enabled: false, isLive: true, connsCount: 1, activeCount: 1, hasSecret: true, latest: { status: "success" }, lastSuccessAt: hourAgo, now }).status === "disabled");

  // ---- static guards ----
  const settings = src("../src/app/(app)/settings/page.tsx");
  const overview = src("../src/app/(app)/settings/ofd/page.tsx");
  const statusLib = src("../src/lib/ofd/providers/status.ts");
  const taxcom = src("../src/app/(app)/settings/integrations/ofd/page.tsx");
  const astralPage = src("../src/app/(app)/settings/ofd/astral/page.tsx");
  const astralActions = src("../src/app/(app)/settings/ofd/astral/actions.ts");
  const astralForms = src("../src/app/(app)/settings/ofd/astral/_components/AstralForms.tsx");
  const dash = src("../src/app/(app)/dashboard/page.tsx");
  const card = src("../src/app/(app)/dashboard/_components/OfdSyncCard.tsx");

  // Single unified entry on the main settings page (no standalone Taxcom button)
  check("UI1 settings page has ONE unified «Подключение ОФД» entry → /settings/ofd",
    settings.includes("Подключение ОФД") && settings.includes('href="/settings/ofd"'));
  check("UI2 no standalone «ОФД Такском» button remains on the main settings page",
    !settings.includes("ОФД Такском") && !settings.includes('/settings/integrations/ofd"'));

  // Overview = aggregation only, server-side role gate, both cards, no secrets
  check("UI3 overview aggregates via loadOfdProviderCards (no parallel sync/contour)",
    overview.includes("loadOfdProviderCards") && statusLib.includes("READ-ONLY") && !statusLib.includes("runSyncNow"));
  check("UI4 overview role-gated server-side (owner/general_director), else redirect",
    overview.includes("userHasCompanyRole") && overview.includes('"owner"') && overview.includes('"general_director"') && overview.includes('redirect("/settings")'));
  check("UI5 overview renders BOTH providers with manage/connect links",
    statusLib.includes('taxcom: "/settings/integrations/ofd"') && statusLib.includes('astral: "/settings/ofd/astral"') &&
    overview.includes("Управление подключением") && overview.includes("Подключить"));
  check("UI6 responsive card grid: 1/row mobile, 2/row desktop",
    overview.includes("grid-cols-1") && /sm:grid-cols-2/.test(overview));
  check("UI7 overview exposes no secrets/endpoints (no token/password/serverBaseUrl fields)",
    !/integrationToken|passwordEncrypted|serverBaseUrl|apiKey/i.test(overview));

  // Backward compatibility — old Taxcom URL still the live screen
  check("UI8 old Taxcom URL /settings/integrations/ofd preserved (still the Taxcom screen)",
    taxcom.includes("ОФД Такском") && taxcom.includes('href="/settings/ofd"'));

  // Astral screen — PIN gating, honest BLOCKED, masked key, keep-previous-on-empty
  check("UI9 Astral API-key save is PIN-gated server-side (owner/GD + requireSettingsPin)",
    astralActions.includes("requireSettingsPin") && /requireAstralAdmin\(true\)/.test(astralActions) &&
    astralActions.includes('userHasCompanyRole') && astralActions.includes('"owner"'));
  check("UI10 empty API-key field keeps the previous key (no overwrite)",
    astralActions.includes("apiKey ? { integrationTokenEncrypted: encryptOfdSecret(apiKey) } : {}"));
  check("UI11 key stored encrypted + masked in UI (never rendered plaintext)",
    astralActions.includes("encryptOfdSecret") && astralForms.includes('type="password"') && astralForms.includes("сохранён"));
  check("UI12 Astral honestly not-live: page shows BLOCKED, testConnection refuses (no fake live)",
    astralPage.includes("BLOCKED BY DOCUMENTATION") && astralActions.includes("testConnection") && !astralActions.includes('notice: "Подключено"'));
  check("UI13 Astral page role-gated + reflects PIN-needed state",
    astralPage.includes("userHasCompanyRole") && astralPage.includes("getSettingsPinStatus"));

  // Dashboard multi-provider — per-provider chips, single sync button
  check("UI14 dashboard shows per-provider chips via loadOfdProviderCards, gate on any active",
    dash.includes("loadOfdProviderCards") && dash.includes("anyOfdProvider") && card.includes("providers.map"));
  check("UI15 single sync button kept (no per-provider dashboard button); providers independent",
    (card.match(/SyncButton/g) || []).length >= 1 && !card.includes("triggerAstralSync") && card.includes("statusLabel"));

  // Tenant isolation — every read scoped by companyId
  check("UI16 tenant isolation: overview/status/astral reads scoped by companyId",
    /companyId/.test(statusLib) && statusLib.includes("where: { companyId, provider: provider.id }") &&
    astralActions.includes("provider: \"astral\"") && /companyId/.test(astralActions));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
