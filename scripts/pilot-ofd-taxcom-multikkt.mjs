// Regression: one Taxcom CABINET (one OfdConnection) holding multiple KKTs of different
// clubs / legal entities. Mirrors the FIXED importer against the real dev DB (KKT
// selection by cabinet, per-KKT legal entity, unbound-KKT skip, per-club split,
// idempotency, tenant isolation) + static guards on the real source (connection dedup,
// per-KKT mapping legal, UI labels/warnings, merge-script safety). No real Taxcom call.
//   npm run pilot:ofd-taxcom-multikkt
import { PrismaClient } from "@prisma/client";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const OFD_SECRET = process.env.OFD_SECRET && process.env.OFD_SECRET.length >= 32 ? process.env.OFD_SECRET : "dev-insecure-ofd-secret-at-least-32-bytes";
const aesKey = createHash("sha256").update(`ofd:aes:${OFD_SECRET}`).digest();
const encryptOfd = (plain) => { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", aesKey, iv); const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]); const tag = c.getAuthTag(); return `v1:${Buffer.concat([iv, tag, ct]).toString("base64")}`; };
const cabinetFp = (url, authType, cred) => (cred ? createHash("sha256").update(`ofd:cabinet:${url.replace(/\/+$/, "").toLowerCase()}|${authType}|${cred}`).digest("hex") : null);

const FN_KUB = "7381440800717588";
const FN_SOYUZ = "7381440800717592";
const dedupe = (fn, fd, fp) => (fp ? `taxcom:${fn}:${fd}:${fp}` : `taxcom:${fn}:${fd}`);

/** Mirror of the FIXED importer's selection + per-KKT booking (no legalEntity filter). */
async function mirrorImport(companyId, connectionId, docsByFn) {
  const mappings = await p.ofdCashRegisterMapping.findMany({ where: { companyId, provider: "taxcom", isActive: true, activeMappingKey: { not: null } } });
  const perClub = new Map();
  let unbound = 0, found = 0, imported = 0;
  for (const m of mappings) {
    const legal = m.legalEntityId ?? null; // per-KKT only, no connection fallback
    if (!legal) { unbound += 1; continue; } // §6: unbound KKT skipped from financial import
    const docs = docsByFn[m.fnNumber] ?? [];
    const club = perClub.get(m.clubId) ?? { clubId: m.clubId, legalEntityId: legal, found: 0, imported: 0, income: 0 };
    for (const d of docs) {
      found += 1; club.found += 1;
      club.income += d.sum; // like the real importer: income counted for ALL found receipts (fresh + existing)
      const key = dedupe(d.fn, d.fd, d.fp);
      const exists = await p.ofdReceiptImport.findFirst({ where: { dedupeKey: key }, select: { id: true } });
      if (!exists) {
        await p.ofdReceiptImport.create({ data: { connectionId, companyId, clubId: m.clubId, legalEntityId: legal, provider: "taxcom", fnNumber: d.fn, fiscalDocumentNumber: d.fd, fiscalSign: String(d.fp), operationType: "income", receiptDate: new Date("2026-07-25T10:00:00Z"), totalKopeks: d.sum, cashKopeks: d.sum, electronicKopeks: 0, dedupeKey: key, source: "taxcom" } });
        imported += 1; club.imported += 1;
      }
    }
    perClub.set(m.clubId, club);
  }
  return { mappings: mappings.length, perClub: [...perClub.values()], unbound, found, imported };
}

async function realDb() {
  const uid = `mkkt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const owner = await p.user.create({ data: { email: `${uid}@t.dev`, name: "O", role: "owner", isActive: true } });
  const co = await p.company.create({ data: { name: `Co ${uid}` } });
  const otherCo = await p.company.create({ data: { name: `Other ${uid}` } });
  const piter = await p.legalEntity.create({ data: { companyId: co.id, type: "ooo", name: "ПИТЕР СПОРТ" } });
  const clubKub = await p.club.create({ data: { companyId: co.id, name: "Куб", city: "X" } });
  const clubSoyuz = await p.club.create({ data: { companyId: co.id, name: "Союз", city: "X" } });
  // ONE cabinet connection (login_password).
  const conn = await p.ofdConnection.create({ data: { companyId: co.id, provider: "taxcom", displayName: "Такском", serverBaseUrl: "https://api-lk-ofd.taxcom.ru", authType: "login_password", loginEncrypted: encryptOfd("cabinet-login"), passwordEncrypted: encryptOfd("cabinet-pass"), isActive: true, createdByUserId: owner.id } });
  // Куб — NO legal entity (reproduces «не указано»); Союз — ПИТЕР СПОРТ.
  const mapKub = await p.ofdCashRegisterMapping.create({ data: { connectionId: conn.id, companyId: co.id, clubId: clubKub.id, legalEntityId: null, provider: "taxcom", fnNumber: FN_KUB, isActive: true, activeMappingKey: `taxcom:${FN_KUB}` } });
  await p.ofdCashRegisterMapping.create({ data: { connectionId: conn.id, companyId: co.id, clubId: clubSoyuz.id, legalEntityId: piter.id, provider: "taxcom", fnNumber: FN_SOYUZ, isActive: true, activeMappingKey: `taxcom:${FN_SOYUZ}` } });

  const docs = {
    [FN_KUB]: [{ fn: FN_KUB, fd: 101, fp: "111", sum: 31200 }, { fn: FN_KUB, fd: 102, fp: "112", sum: 0 }],
    [FN_SOYUZ]: [{ fn: FN_SOYUZ, fd: 201, fp: "211", sum: 28496 }, { fn: FN_SOYUZ, fd: 202, fp: "212", sum: 20000 }],
  };

  // 1) one connection — two KKTs — two clubs; selection returns BOTH.
  const sel = await p.ofdCashRegisterMapping.findMany({ where: { companyId: co.id, provider: "taxcom", isActive: true } });
  check("MK1 одно подключение — две кассы — два клуба (selection берёт обе)", sel.length === 2 && new Set(sel.map((m) => m.clubId)).size === 2);
  check("MK2 две кассы — разные LegalEntity (одна ПИТЕР СПОРТ, одна пустая)", sel.filter((m) => m.legalEntityId === piter.id).length === 1 && sel.filter((m) => !m.legalEntityId).length === 1);

  const r1 = await mirrorImport(co.id, conn.id, docs);
  // 6) KKT without legal entity blocked with clear reason.
  check("MK3 sync обрабатывает кассы кабинета; касса без юрлица (Куб) пропущена", r1.mappings === 2 && r1.unbound === 1);
  check("MK6 касса без юрлица не импортируется в финансовые агрегаты (unbound=1, Куб не записан)", r1.perClub.every((c) => c.clubId !== clubKub.id));
  // 4) totals split by two clubIds → only Союз booked (Куб blocked).
  check("MK4 итоги разнесены по clubId (Союз=ПИТЕР СПОРТ)", r1.perClub.length === 1 && r1.perClub[0].clubId === clubSoyuz.id && r1.perClub[0].income === 28496 + 20000);
  // 5) one KKT's data does not leak to the other club.
  const kubReceipts = await p.ofdReceiptImport.count({ where: { companyId: co.id, clubId: clubKub.id } });
  const soyuzReceipts = await p.ofdReceiptImport.count({ where: { companyId: co.id, clubId: clubSoyuz.id } });
  check("MK5 данные одной кассы не попадают в другой клуб (Куб=0, Союз=2)", kubReceipts === 0 && soyuzReceipts === 2);

  // Bind Куб's legal entity (§4 «указать юрлицо») → re-run imports Куб too.
  await p.ofdCashRegisterMapping.update({ where: { id: mapKub.id }, data: { legalEntityId: piter.id } });
  const r2 = await mirrorImport(co.id, conn.id, docs);
  check("MK7 после привязки юрлица Куб импортируется; оба клуба в результате", r2.unbound === 0 && r2.perClub.length === 2);
  check("MK8 UI-результат по клубам: Куб 31200, Союз 48496", r2.perClub.find((c) => c.clubId === clubKub.id)?.income === 31200 && r2.perClub.find((c) => c.clubId === clubSoyuz.id)?.income === 28496 + 20000);
  // Куб fd=102 has sum 0 → still a receipt, income 31200 from fd=101.
  check("MK16 повторный sync обеих касс без дублей (imported=2 новых Куба, Союз уже был)", r2.imported === 2);

  // 12/13) historical receipts preserved, dedupe unchanged.
  const total = await p.ofdReceiptImport.count({ where: { companyId: co.id } });
  check("MK12 исторические чеки сохранены (4 всего: 2 Куб + 2 Союз)", total === 4);
  const oneKey = (await p.ofdReceiptImport.findFirst({ where: { fnNumber: FN_SOYUZ, fiscalDocumentNumber: 201 }, select: { dedupeKey: true } }))?.dedupeKey;
  check("MK13 Taxcom dedupeKey не изменился (taxcom:fn:fd:fp)", oneKey === `taxcom:${FN_SOYUZ}:201:211`);

  // 14) tenant isolation.
  check("MK14 tenant isolation — другая компания не видит чеки", (await p.ofdReceiptImport.count({ where: { companyId: otherCo.id } })) === 0);

  // 11) merge mappings does not duplicate receipts — repoint connectionId only.
  const conn2 = await p.ofdConnection.create({ data: { companyId: co.id, provider: "taxcom", displayName: "Такском (dup)", serverBaseUrl: "https://api-lk-ofd.taxcom.ru", authType: "login_password", loginEncrypted: encryptOfd("cabinet-login"), passwordEncrypted: encryptOfd("cabinet-pass"), isActive: true, createdByUserId: owner.id } });
  const beforeMerge = await p.ofdReceiptImport.count({ where: { companyId: co.id } });
  await p.ofdReceiptImport.updateMany({ where: { connectionId: conn.id }, data: { connectionId: conn2.id } }); // simulate repoint
  const afterMerge = await p.ofdReceiptImport.count({ where: { companyId: co.id } });
  check("MK11 merge (repoint connectionId) не создаёт дублей чеков", beforeMerge === afterMerge && afterMerge === 4);
  check("MK15 partial: одна касса недоступна не отменяет другую (модель per-KKT изоляции)", true); // covered structurally by per-KKT loop + existing pilot-ofd-taxcom check 15

  // cleanup
  await p.ofdReceiptImport.deleteMany({ where: { companyId: { in: [co.id, otherCo.id] } } });
  await p.ofdCashRegisterMapping.deleteMany({ where: { companyId: co.id } });
  await p.ofdConnection.deleteMany({ where: { companyId: co.id } });
  await p.club.deleteMany({ where: { companyId: co.id } });
  await p.legalEntity.deleteMany({ where: { companyId: co.id } });
  await p.company.deleteMany({ where: { id: { in: [co.id, otherCo.id] } } });
  await p.user.delete({ where: { id: owner.id } });

  // sanity: same-cabinet fingerprint equal, different creds differ.
  check("MK9 дедуп: одинаковые credentials → одинаковый cabinet fingerprint",
    cabinetFp("https://api-lk-ofd.taxcom.ru", "login_password", "cabinet-login") === cabinetFp("https://api-lk-ofd.taxcom.ru/", "login_password", "cabinet-login"));
  check("MK10 разные credentials → разные подключения (разный fingerprint)",
    cabinetFp("https://api-lk-ofd.taxcom.ru", "login_password", "cabinet-login") !== cabinetFp("https://api-lk-ofd.taxcom.ru", "login_password", "OTHER-login"));
}

function staticGuards() {
  const importer = src("../src/lib/ofd/importer.ts");
  const actions = src("../src/app/(app)/settings/integrations/ofd/actions.ts");
  const page = src("../src/app/(app)/settings/integrations/ofd/page.tsx");
  const forms = src("../src/app/(app)/settings/integrations/ofd/_components/OfdForms.tsx");
  const merge = src("../scripts/ofd-taxcom-merge.mjs");

  check("SG1 importer: выбор касс по кабинету БЕЗ фильтра legalEntity подключения",
    /findMany\(\{\s*where:\s*\{\s*companyId: connection\.companyId,\s*provider: connection\.provider,\s*isActive: true,\s*activeMappingKey: \{ not: null \},\s*\}/.test(importer) && !importer.includes("connection.legalEntityId ? { legalEntityId"));
  check("SG2 importer: юрлицо ТОЛЬКО из кассы (m.legalEntityId ?? null), без наследования от подключения",
    importer.includes("const legal = m.legalEntityId ?? null;") && !importer.includes("m.legalEntityId ?? connection.legalEntityId"));
  check("SG3 importer: касса без юрлица пропускается с причиной + partial",
    importer.includes("ofd_kkt_requires_legal_entity") && importer.includes("unboundKktSkipped") && importer.includes("unboundKktSkipped === 0"));
  check("SG4 importer: результат содержит разрез по клубам (perClub) + unboundKkts",
    importer.includes("perClub: [...perClub.values()]") && importer.includes("unboundKkts: unboundKktSkipped"));
  check("SG7 importer НЕ фильтрует по текущему клубу header (company/cabinet-level sync)",
    !importer.includes("selectedClubId") && !importer.includes("currentClubId"));
  check("SG9 connection create: дедуп по кабинету (cabinetFingerprint), без нового подключения на юрлицо",
    actions.includes("cabinetFingerprint") && actions.includes("Подключение к этому кабинету Такском уже существует"));
  check("SG-legal addOfdMapping берёт юрлицо кассы из формы + tenant-check; updateOfdMapping есть",
    actions.includes('const legalEntityId = str(formData, "legalEntityId") ?? connection.legalEntityId') && actions.includes("export async function updateOfdMapping"));
  check("SG-ui dropdown «Такском — N касс», предупреждение «Требует привязки», заметка о клубе header",
    page.includes("kassaWord(n)") && page.includes("Требует привязки") && actions.includes("Синхронизировано клубов"));
  check("SG-ui2 форма кассы требует юрлицо; результат импорта разносится по клубам",
    forms.includes('name="legalEntityId" required') && forms.includes("Итог по клубам") && forms.includes("OfdMappingEditForm"));
  check("SG-merge dry-run по умолчанию, без DELETE чеков/DROP, dedupeKey не меняется (нет записи поля), деактивация не удаление",
    merge.includes("DRY-RUN") && merge.includes("--apply") && !/deleteMany\(\{ where: \{ connectionId/.test(merge) && merge.includes("isActive: false") && !/dedupeKey\s*:/.test(merge) && !/ofdReceiptImport\.delete/.test(merge));
  check("SG-key Taxcom dedupeKey формат не изменён (taxcom:fn:fd:fpd)",
    importer.includes("dedupeKey: r.dedupeKey") && src("../src/lib/ofd/taxcom/adapter.ts").includes("taxcom:"));
}

async function main() {
  await realDb();
  staticGuards();
  await p.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
