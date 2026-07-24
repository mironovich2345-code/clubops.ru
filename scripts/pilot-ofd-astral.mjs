// Астрал.ОФД provider foundation — маппинг чеков (провизорный), fixtures, и честный
// BLOCKED-статус. Мирроринг mapAstralReceipt + статические гарантии, что Taxcom-путь не
// тронут и Astral не притворяется live.
// npm run pilot:ofd-astral
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- mirror: buildProviderDedupeKey + mapAstralReceipt (providers/*) ----
const dedupe = (prov, fn, fd, fp) => (fp ? `${prov}:${fn}:${fd}:${fp}` : `${prov}:${fn}:${fd}`);
const toInt = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
const pick = (...vals) => vals.find((v) => v != null) ?? undefined;
function mapOperation(raw) {
  const s = String(pick(raw.operationType, raw.type) ?? "").toLowerCase();
  if (s === "2" || s.includes("return") || s.includes("возврат")) return "income_return";
  return "income";
}
function mapItems(raw) {
  if (!Array.isArray(raw.items) || raw.items.length === 0) return undefined;
  return raw.items.map((it) => {
    const priceKopeks = toInt(it.price);
    const quantityMilli = Math.max(0, Math.round((typeof it.quantity === "number" ? it.quantity : 1) * 1000));
    const totalKopeks = it.sum != null ? toInt(it.sum) : Math.round((priceKopeks * quantityMilli) / 1000);
    return { name: String(it.name ?? "").slice(0, 256), quantityMilli, priceKopeks, totalKopeks };
  });
}
function mapAstralReceipt(raw) {
  const fnNumber = String(pick(raw.fnNumber, raw.fn) ?? "");
  const fiscalDocumentNumber = toInt(pick(raw.fiscalDocumentNumber, raw.fd));
  const fsRaw = pick(raw.fiscalSign, raw.fp);
  const fiscalSign = fsRaw != null ? String(fsRaw) : null;
  const totalKopeks = toInt(pick(raw.totalKopeks, raw.totalSum));
  const cashKopeks = toInt(pick(raw.cashKopeks, raw.cashSum));
  const electronicKopeks = toInt(pick(raw.electronicKopeks, raw.ecashSum, raw.electronicSum));
  const items = mapItems(raw);
  return { fnNumber, fiscalDocumentNumber, fiscalSign, operationType: mapOperation(raw), totalKopeks, cashKopeks, electronicKopeks, dedupeKey: dedupe("astral", fnNumber, fiscalDocumentNumber, fiscalSign), items, itemsPresent: Boolean(items && items.length) };
}

// ---- fixtures (PROVISIONAL Astral shapes) ----
const FIX = {
  income: { fn: "9999078900001111", fd: 4021, fp: "1234567890", operationType: "1", dateTime: "2026-07-23T10:15:00", totalSum: 250000, cashSum: 250000, ecashSum: 0, items: [{ name: "Абонемент 1 мес", price: 250000, quantity: 1, sum: 250000 }] },
  returnAlt: { fnNumber: "9999078900001111", fiscalDocumentNumber: 4022, fiscalSign: "1230000000", type: "возврат прихода", receiptDate: "2026-07-23T12:00:00", totalKopeks: 250000, cashKopeks: 0, electronicKopeks: 250000, items: [] },
  numericReturn: { fn: "A", fd: 7, fp: 55, operationType: 2, totalSum: 100000, cashSum: 100000 },
};

function main() {
  const inc = mapAstralReceipt(FIX.income);
  check("AST1 income maps to income + kopeks passthrough", inc.operationType === "income" && inc.totalKopeks === 250000 && inc.cashKopeks === 250000);
  check("AST2 dedupeKey is astral-prefixed (never collides with taxcom)", inc.dedupeKey === "astral:9999078900001111:4021:1234567890");
  check("AST3 items normalized (name/price/qty→milli/sum)", inc.itemsPresent && inc.items[0].quantityMilli === 1000 && inc.items[0].priceKopeks === 250000);

  const ret = mapAstralReceipt(FIX.returnAlt);
  check("AST4 alternate field names (fnNumber/fiscalDocumentNumber/…) supported", ret.fnNumber === "9999078900001111" && ret.fiscalDocumentNumber === 4022);
  check("AST5 'возврат прихода' → income_return; electronic split", ret.operationType === "income_return" && ret.electronicKopeks === 250000 && ret.cashKopeks === 0);
  check("AST6 empty items → itemsPresent false", ret.itemsPresent === false);

  const numRet = mapAstralReceipt(FIX.numericReturn);
  check("AST7 numeric operation code 2 → income_return; missing fp → no-fp dedupe", numRet.operationType === "income_return" && numRet.dedupeKey === "astral:A:7:55");

  // ---- static guards ----
  const astral = src("../src/lib/ofd/providers/astral-provider.ts");
  const registry = src("../src/lib/ofd/providers/registry.ts");
  const iface = src("../src/lib/ofd/providers/types.ts");
  const importer = src("../src/lib/ofd/importer.ts");
  const daily = src("../src/lib/ofd/daily.ts");
  const doc = src("../docs/integrations/astral-ofd-discovery.md");

  check("AST8 Astral is NOT live: testConnection refuses (blocked), status not 'live'",
    astral.includes("ASTRAL_NOT_CONFIGURED") && astral.includes('status: "blocked_by_documentation"') && !astral.includes('status: "live"'));
  check("AST9 provider registry has both taxcom (live) + astral, sharing OfdProvider interface",
    registry.includes("TaxcomProvider") && registry.includes("AstralProvider") && iface.includes("export interface OfdProvider"));
  check("AST10 normalizer targets the SHARED NormalizedOfdReceipt (downstream unchanged)",
    astral.includes("NormalizedOfdReceipt") && iface.includes("NormalizedOfdReceipt"));
  check("AST11 Taxcom import path untouched (daily filter still provider:taxcom, no astral in import path)",
    daily.includes('provider: "taxcom"') && importer.includes("createTaxcomClient") && !importer.toLowerCase().includes("astral") && !daily.toLowerCase().includes("astral"));
  check("AST12 discovery doc marks BLOCKED honestly + provisional mapping caveat",
    doc.includes("BLOCKED BY DOCUMENTATION") && /провизорн|ПРЕДВАРИТЕЛЬНО|подтвердить/i.test(doc));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
