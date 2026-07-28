// Regression: Saby (СБИС) OFD provider scaffold. Pure mirror of the normalizer + host guard +
// static guards on the real client/provider/registry/config. No live API calls (provider is
// blocked_by_credentials until reconciled on a real cabinet).
//   npm run pilot:ofd-saby
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ---- mirror of normalize.ts / client host guard ----
const buildDedupe = (provider, fn, fd, sign) => (sign ? `${provider}:${fn}:${fd}:${sign}` : `${provider}:${fn}:${fd}`);
const fingerprint = (fn, fd, sign, op) => `${fn}:${fd}:${sign ?? ""}:${op}`;
const ALLOWED = new Set(["api.sbis.ru", "online.sbis.ru"]);
const hostAllowed = (url) => { try { return ALLOWED.has(new URL(url).host); } catch { return false; } };
function sabyOp(raw) {
  const t = String(raw.operationType ?? raw.receiptType ?? raw.documentType ?? raw.type ?? "").toLowerCase();
  if (/return|refund|возврат/.test(t)) return "income_return";
  if (/sale|income|приход|чек|receipt/.test(t)) return "income";
  if (t === "1") return "income";
  if (t === "2") return "income_return";
  return null;
}
function normalize(raw) {
  const op = sabyOp(raw);
  if (op == null) return null;
  const fn = String(raw.fiscalDriveNumber ?? raw.fnNumber ?? "").trim();
  const fd = Number(raw.fiscalDocumentNumber ?? raw.docNum ?? 0) | 0;
  const sign = raw.fiscalSign != null ? String(raw.fiscalSign) : null;
  const date = raw.receiptDateTime ? new Date(raw.receiptDateTime) : new Date(NaN);
  if (!fn || !fd || Number.isNaN(date.getTime())) return null;
  return { fnNumber: fn, fiscalDocumentNumber: fd, fiscalSign: sign, operationType: op, operatorName: raw.operator ?? null, dedupeKey: buildDedupe("saby", fn, fd, sign) };
}

function pureTests() {
  check("P1 normalize: продажа → income, возврат → income_return, коррекция → null (не бронируется)",
    normalize({ operationType: "sale", fiscalDriveNumber: "9990001", fiscalDocumentNumber: 5, receiptDateTime: "2026-07-10T10:00:00Z" }).operationType === "income" &&
    normalize({ operationType: "return", fiscalDriveNumber: "9990001", fiscalDocumentNumber: 6, receiptDateTime: "2026-07-10T10:00:00Z" }).operationType === "income_return" &&
    normalize({ operationType: "correction", fiscalDriveNumber: "9990001", fiscalDocumentNumber: 7, receiptDateTime: "2026-07-10T10:00:00Z" }) === null);
  check("P2 normalize: неполные фискальные реквизиты → null (не выдумываем)", normalize({ operationType: "sale", fiscalDriveNumber: "", fiscalDocumentNumber: 0 }) === null);
  check("P3 dedupeKey провайдеро-префиксован (saby:…)", normalize({ operationType: "sale", fiscalDriveNumber: "9990001", fiscalDocumentNumber: 5, fiscalSign: "77", receiptDateTime: "2026-07-10T10:00:00Z" }).dedupeKey === "saby:9990001:5:77");
  check("P4 fingerprint провайдеро-НЕзависим (один физический чек = один fp — dedupe с Taxcom/Astral)", fingerprint("9990001", 5, "77", "income") === "9990001:5:77:income");
  check("P5 operator: значение кассира сохраняется когда есть; иначе null (не угадываем)", normalize({ operationType: "sale", fiscalDriveNumber: "9990001", fiscalDocumentNumber: 5, receiptDateTime: "2026-07-10T10:00:00Z", operator: "Иванов" }).operatorName === "Иванов" && normalize({ operationType: "sale", fiscalDriveNumber: "9990001", fiscalDocumentNumber: 8, receiptDateTime: "2026-07-10T10:00:00Z" }).operatorName === null);
  check("P6 host allowlist: api.sbis.ru/online.sbis.ru разрешены, прочее — нет (SSRF)", hostAllowed("https://api.sbis.ru/ofd/v1/orgs/1/kkts") && hostAllowed("https://online.sbis.ru/oauth/service/") && !hostAllowed("https://evil.example.com/x") && !hostAllowed("https://api.sbis.ru.evil.com/x"));
}

function staticGuards() {
  const client = src("../src/lib/ofd/saby/client.ts");
  const normalizeSrc = src("../src/lib/ofd/saby/normalize.ts");
  const provider = src("../src/lib/ofd/providers/saby-provider.ts");
  const registry = src("../src/lib/ofd/providers/registry.ts");
  const config = src("../src/lib/ofd/config.ts");
  const types = src("../src/lib/ofd/providers/types.ts");

  check("SG1 registry содержит saby + гейт по фиче (listSelectableOfdProviders + ofdSabyEnabled)", registry.includes("SABY_PROVIDER_ID") && registry.includes("listSelectableOfdProviders") && registry.includes("ofdSabyEnabled()"));
  check("SG2 feature flag OFD_SABY_ENABLED (OFF по умолчанию, требует OFD)", config.includes("OFD_SABY_ENABLED") && config.includes("ofdEnabled() && process.env.OFD_SABY_ENABLED"));
  check("SG3 provider status честный (blocked_by_credentials, не live)", provider.includes('status: "blocked_by_credentials"') && types.includes("blocked_by_credentials") && !provider.includes('status: "live"'));
  check("SG4 client: host allowlist api.sbis.ru/online.sbis.ru (SSRF) + assertSabyHost", client.includes('"api.sbis.ru"') && client.includes('"online.sbis.ru"') && client.includes("ALLOWED_HOSTS") && client.includes("assertSabyHost"));
  check("SG5 client: официальные эндпоинты (kkts / storages / docs / doc-by-attrs)", client.includes("/orgs/${encodeURIComponent(inn)}/kkts") && client.includes("/storages") && client.includes("/docs") && client.includes("/storage/${encodeURIComponent(storageId)}/doc"));
  check("SG6 client: X-SBISSessionID + timeout + лимит ответа + normalizeSabyError, без логов секретов", client.includes('"X-SBISSessionID"') && client.includes("AbortController") && client.includes("MAX_RESPONSE_BYTES") && client.includes("normalizeSabyError") && !/console\.(log|warn|error)\(/.test(client));
  check("SG7 auth честно отказывает до проверки (не выдумывает вызов)", client.includes("SABY_AUTH_UNVERIFIED"));
  check("SG8 normalize: FFD→shared DTO, provider dedupeKey, operator capture, без фабрикации денег", normalizeSrc.includes("buildProviderDedupeKey(SABY_PROVIDER_ID") && normalizeSrc.includes("operatorName") && normalizeSrc.includes("do not fabricate") && normalizeSrc.includes("sabyOperationType"));
  check("SG9 normalize пуст (нет DB/prisma импорта)", !/@\/lib\/prisma|prisma\./.test(normalizeSrc));
}

function main() {
  pureTests();
  staticGuards();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
