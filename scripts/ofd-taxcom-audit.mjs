// READ-ONLY audit of Taxcom connections + KKT mappings. NO mutations. NO secrets
// printed — only presence + a non-reversible cabinet fingerprint (sha256 of
// serverBaseUrl|authType|credential) so you can see which connections are the SAME
// cabinet. Run against the target DB:
//   DATABASE_URL="postgresql://…" node scripts/ofd-taxcom-audit.mjs
//   (or, for the local dev DB, just: node scripts/ofd-taxcom-audit.mjs)
import { PrismaClient } from "@prisma/client";
import { createHash, createDecipheriv } from "node:crypto";

const p = new PrismaClient();
const s = (v) => (v == null ? "—" : String(v));

// Mirror of lib/ofd/crypto decrypt (v1 AES-256-GCM) — used ONLY to compute the cabinet
// fingerprint in-memory; the plaintext is never printed.
const OFD_SECRET = process.env.OFD_SECRET && process.env.OFD_SECRET.length >= 32 ? process.env.OFD_SECRET : "dev-insecure-ofd-secret-at-least-32-bytes";
const aesKey = createHash("sha256").update(`ofd:aes:${OFD_SECRET}`).digest();
const decryptOfd = (payload) => { if (!payload) return null; const i = payload.indexOf(":"); if (i < 0 || payload.slice(0, i) !== "v1") return null; try { const buf = Buffer.from(payload.slice(i + 1), "base64"); const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28); const d = createDecipheriv("aes-256-gcm", aesKey, iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]).toString("utf8"); } catch { return null; } };
const cabinetFingerprint = (serverBaseUrl, authType, credential) => { if (!credential) return null; const base = (serverBaseUrl || "").replace(/\/+$/, "").toLowerCase(); return createHash("sha256").update(`ofd:cabinet:${base}|${authType}|${credential}`).digest("hex").slice(0, 12); };

const conns = await p.ofdConnection.findMany({ where: { provider: "taxcom" }, orderBy: { createdAt: "asc" } });
const maps = await p.ofdCashRegisterMapping.findMany({ where: { provider: "taxcom" }, orderBy: { createdAt: "asc" } });

const clubIds = [...new Set(maps.map((m) => m.clubId))];
const leIds = [...new Set([...maps.map((m) => m.legalEntityId), ...conns.map((c) => c.legalEntityId)].filter(Boolean))];
const clubs = new Map((await p.club.findMany({ where: { id: { in: clubIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
const les = new Map((await p.legalEntity.findMany({ where: { id: { in: leIds } }, select: { id: true, name: true } })).map((l) => [l.id, l.name]));

const fpOf = (c) => cabinetFingerprint(c.serverBaseUrl, c.authType, decryptOfd(c.loginEncrypted) ?? decryptOfd(c.integrationTokenEncrypted));

console.log(`\n=== OfdConnection (taxcom): ${conns.length} ===`);
for (const c of conns) {
  console.log(`• ${c.id.slice(0, 8)} "${c.displayName}" company=${c.companyId.slice(0, 8)} legalEntity=${c.legalEntityId ? les.get(c.legalEntityId) ?? c.legalEntityId : "—"} contract=${s(c.contractNumber)} active=${c.isActive} creds{login=${Boolean(c.loginEncrypted)},pass=${Boolean(c.passwordEncrypted)},token=${Boolean(c.integrationTokenEncrypted)}} cabinetFp=${s(fpOf(c))} createdAt=${c.createdAt.toISOString?.() ?? c.createdAt}`);
}

console.log(`\n=== SAFE TABLE ===`);
console.log("| connectionId | label | cabinetFp | conn.legalEntity | FN | club | mapping.legalEntity | active |");
console.log("|---|---|---|---|---|---|---|---|");
for (const m of maps) {
  const c = conns.find((x) => x.id === m.connectionId);
  console.log(`| ${m.connectionId.slice(0, 8)} | ${s(c?.displayName)} | ${c ? s(fpOf(c)) : "?"} | ${c ? (c.legalEntityId ? les.get(c.legalEntityId) ?? c.legalEntityId : "—") : "?"} | ${s(m.fnNumber)} | ${s(clubs.get(m.clubId) ?? m.clubId)} | ${m.legalEntityId ? les.get(m.legalEntityId) ?? m.legalEntityId : "⚠ НЕТ"} | ${m.isActive} |`);
}

// Group connections by cabinet fingerprint → detect duplicates.
const byFp = new Map();
for (const c of conns) { const fp = fpOf(c) ?? `nofp-${c.id.slice(0, 6)}`; if (!byFp.has(fp)) byFp.set(fp, []); byFp.get(fp).push(c); }
console.log(`\n=== Дубликаты кабинетов ===`);
let dupFound = false;
for (const [fp, group] of byFp) {
  if (group.length > 1) {
    dupFound = true;
    console.log(`Кабинет fp=${fp}: ${group.length} подключений → ${group.map((c) => `${c.id.slice(0, 8)}("${c.displayName}")`).join(", ")} — ОДИН кабинет, кандидат на merge.`);
  }
}
if (!dupFound) console.log("Дубликатов кабинетов не обнаружено (или у подключений нет credentials для fingerprint).");

console.log(`\n=== Кассы без юрлица (требуют привязки) ===`);
const unbound = maps.filter((m) => m.isActive && !m.legalEntityId);
if (unbound.length === 0) console.log("Нет.");
for (const m of unbound) console.log(`ФН ${m.fnNumber} · клуб ${s(clubs.get(m.clubId) ?? m.clubId)} · conn ${m.connectionId.slice(0, 8)} — укажите юрлицо в UI перед импортом.`);

console.log(`\n=== OfdReceiptImport по клубам (taxcom) ===`);
const receipts = await p.ofdReceiptImport.groupBy({ by: ["clubId"], where: { provider: "taxcom" }, _count: { _all: true } });
for (const r of receipts) console.log(`клуб ${s(clubs.get(r.clubId) ?? r.clubId)}: ${r._count._all} чеков`);

await p.$disconnect();
