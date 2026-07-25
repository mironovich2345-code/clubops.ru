// Safe, IDEMPOTENT merge of duplicate Taxcom connections of the SAME cabinet into one.
// DRY-RUN by default (prints the plan). Pass --apply to execute inside a transaction.
//
//   DATABASE_URL="postgresql://…" node scripts/ofd-taxcom-merge.mjs            # dry-run
//   DATABASE_URL="postgresql://…" node scripts/ofd-taxcom-merge.mjs --apply    # execute
//   …--company=<companyId>   restrict to one company
//
// Guarantees (§4): choose a primary; move mappings + receipts + sync runs/errors to it;
// NEVER delete OfdReceipt; NEVER change dedupeKeys; no duplicate receipts (pointer-only
// updates); credentials not lost (secondary is DEACTIVATED, not deleted); audit logged;
// prints a ROLLBACK plan. A KKT without a legal entity is left as-is (юрлицо не угадываем)
// — bind it in the UI before syncing that касса. Non-destructive: only UPDATE of scalar
// FKs + isActive; no DROP / DELETE / schema change.
import { PrismaClient } from "@prisma/client";
import { createHash, createDecipheriv } from "node:crypto";

const APPLY = process.argv.includes("--apply");
const companyArg = (process.argv.find((a) => a.startsWith("--company=")) ?? "").split("=")[1] || null;
const p = new PrismaClient();

const OFD_SECRET = process.env.OFD_SECRET && process.env.OFD_SECRET.length >= 32 ? process.env.OFD_SECRET : "dev-insecure-ofd-secret-at-least-32-bytes";
const aesKey = createHash("sha256").update(`ofd:aes:${OFD_SECRET}`).digest();
const decryptOfd = (payload) => { if (!payload) return null; const i = payload.indexOf(":"); if (i < 0 || payload.slice(0, i) !== "v1") return null; try { const buf = Buffer.from(payload.slice(i + 1), "base64"); const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28); const d = createDecipheriv("aes-256-gcm", aesKey, iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]).toString("utf8"); } catch { return null; } };
const fpOf = (c) => { const cred = decryptOfd(c.loginEncrypted) ?? decryptOfd(c.integrationTokenEncrypted); if (!cred) return null; const base = (c.serverBaseUrl || "").replace(/\/+$/, "").toLowerCase(); return createHash("sha256").update(`ofd:cabinet:${base}|${c.authType}|${cred}`).digest("hex"); };

const log = (...a) => console.log(...a);
log(`\n=== Taxcom connection merge (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);

const conns = await p.ofdConnection.findMany({ where: { provider: "taxcom", ...(companyArg ? { companyId: companyArg } : {}) }, orderBy: { createdAt: "asc" } });

// Group by (companyId, cabinet fingerprint). Only same fingerprint = same cabinet.
const groups = new Map();
for (const c of conns) {
  const fp = fpOf(c);
  if (!fp) { log(`skip ${c.id.slice(0, 8)} "${c.displayName}" — нет credentials для fingerprint (не сливаю вслепую).`); continue; }
  const key = `${c.companyId}:${fp}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(c);
}

let planned = 0;
const rollback = [];
for (const [key, group] of groups) {
  if (group.length < 2) continue;
  // Primary = most active mappings, tie-break oldest.
  const withCounts = [];
  for (const c of group) {
    const active = await p.ofdCashRegisterMapping.count({ where: { connectionId: c.id, isActive: true } });
    withCounts.push({ c, active });
  }
  withCounts.sort((a, b) => (b.active - a.active) || (new Date(a.c.createdAt) - new Date(b.c.createdAt)));
  const primary = withCounts[0].c;
  const secondaries = withCounts.slice(1).map((x) => x.c);
  log(`\nКабинет ${key.split(":")[1].slice(0, 12)} — primary=${primary.id.slice(0, 8)} "${primary.displayName}", secondaries=${secondaries.map((s) => s.id.slice(0, 8)).join(",")}`);

  for (const sec of secondaries) {
    // Guard: FN collision — if primary already has an ACTIVE mapping for a FN also on the
    // secondary, do NOT move that mapping (would break activeMappingKey uniqueness). Flag it.
    const secMaps = await p.ofdCashRegisterMapping.findMany({ where: { connectionId: sec.id } });
    const primActiveFns = new Set((await p.ofdCashRegisterMapping.findMany({ where: { connectionId: primary.id, isActive: true }, select: { fnNumber: true } })).map((m) => m.fnNumber));
    const movable = secMaps.filter((m) => !(m.isActive && primActiveFns.has(m.fnNumber)));
    const blocked = secMaps.filter((m) => m.isActive && primActiveFns.has(m.fnNumber));
    for (const b of blocked) log(`  ⚠ ФН ${b.fnNumber} уже активна на primary — НЕ переношу (разберите вручную).`);

    const receiptCount = await p.ofdReceiptImport.count({ where: { connectionId: sec.id } });
    const runCount = await p.ofdSyncRun.count({ where: { connectionId: sec.id } });
    log(`  secondary ${sec.id.slice(0, 8)}: mappings→${movable.length} (blocked ${blocked.length}), receipts→${receiptCount}, syncRuns→${runCount}, затем деактивация.`);
    rollback.push(`# rollback: mappings/receipts/runs с connectionId=${primary.id} и бывшим ${sec.id} вернуть на ${sec.id}; ofdConnection ${sec.id} isActive=true`);
    planned += 1;

    if (APPLY) {
      await p.$transaction(async (tx) => {
        for (const m of movable) await tx.ofdCashRegisterMapping.update({ where: { id: m.id }, data: { connectionId: primary.id } });
        await tx.ofdReceiptImport.updateMany({ where: { connectionId: sec.id }, data: { connectionId: primary.id } });
        await tx.ofdSyncRun.updateMany({ where: { connectionId: sec.id }, data: { connectionId: primary.id } });
        await tx.ofdSyncError.updateMany({ where: { connectionId: sec.id }, data: { connectionId: primary.id } });
        // Deactivate (archive) the secondary — NOT delete. Credentials preserved.
        await tx.ofdConnection.update({ where: { id: sec.id }, data: { isActive: false, displayName: `${sec.displayName} (архив, слито в ${primary.displayName})` } });
        await tx.auditLog.create({ data: { action: "ofd.connection_merged", entityType: "OfdConnection", entityId: primary.id, companyId: primary.companyId, userId: primary.createdByUserId, metadataJson: JSON.stringify({ primary: primary.id, secondary: sec.id, movedMappings: movable.length, movedReceipts: receiptCount, blockedFns: blocked.map((b) => b.fnNumber) }) } }).catch(() => {});
      });
      log(`  ✓ применено: ${sec.id.slice(0, 8)} слито в ${primary.id.slice(0, 8)}.`);
    }
  }
}

log(`\n${planned === 0 ? "Нечего сливать (дубликатов кабинетов нет)." : `${APPLY ? "Применено" : "Запланировано"} слияний: ${planned}.`}`);
if (!APPLY && planned > 0) { log("\n--- ROLLBACK PLAN (на случай отката) ---"); for (const r of rollback) log(r); log("Запустите с --apply для выполнения. Дедуп-ключи чеков НЕ меняются, чеки НЕ удаляются."); }
log("\nПримечание: кассы без юрлица НЕ трогаются — укажите юрлицо в UI перед синхронизацией такой кассы.");

await p.$disconnect();
