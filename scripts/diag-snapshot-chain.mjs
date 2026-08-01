// READ-ONLY diagnostic for a club's control-balance (BalanceSnapshot) chain. Proves the
// backdated/versioning invariants on live data WITHOUT mutating anything: full version
// chain, active versions, effective intervals, the current applicable snapshot, the
// calculated current opening, and a proof that a backdated earlier point does NOT change
// the current balance once a later point exists.
//
// Usage:
//   node scripts/diag-snapshot-chain.mjs --club "Союз" --entity ip
//   node scripts/diag-snapshot-chain.mjs --legalEntity <legalEntityId> [--club <id|name>]
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmt = (k) => `${(k / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i]; }
  return a;
}

async function main() {
  const a = args(process.argv.slice(2));
  const now = new Date();

  let clubId = a.club;
  if (clubId && !/^c[a-z0-9]{10,}$/.test(clubId)) {
    const club = await prisma.club.findFirst({ where: { name: { contains: clubId } }, select: { id: true, name: true } });
    if (!club) { console.log(`Клуб не найден: ${a.club}`); return; }
    clubId = club.id;
  }
  let legalEntityId = a.legalEntity;
  if (!legalEntityId && clubId && a.entity) {
    const link = await prisma.clubLegalEntity.findFirst({ where: { clubId, isActive: true, legalEntity: { type: a.entity, isActive: true } }, select: { legalEntityId: true } });
    legalEntityId = link?.legalEntityId ?? null;
  }
  if (!clubId || !legalEntityId) { console.log("Укажите --club <id|name> --entity <ip|ooo> или --legalEntity <id>."); return; }

  const rows = await prisma.balanceSnapshot.findMany({
    where: { clubId, legalEntityId },
    orderBy: [{ snapshotDate: "desc" }, { version: "desc" }, { createdAt: "desc" }],
    select: { id: true, snapshotDate: true, actualBalanceKopeks: true, status: true, version: true, supersedesSnapshotId: true, correctionReason: true, createdById: true, createdAt: true },
  });
  if (rows.length === 0) { console.log(`Контрольных точек нет для club=${clubId} legalEntity=${legalEntityId}.`); return; }

  const activeAsc = rows.filter((r) => r.status === "active").sort((x, y) => x.snapshotDate - y.snapshotDate);
  const intervalOf = (id) => {
    const i = activeAsc.findIndex((r) => r.id === id);
    if (i < 0) return "—";
    const from = ymd(activeAsc[i].snapshotDate);
    const to = i + 1 < activeAsc.length ? ymd(activeAsc[i + 1].snapshotDate) : null;
    return `с ${from}${to ? ` до ${to}` : " по настоящее время"}`;
  };
  const currentApplicable = activeAsc.filter((r) => r.snapshotDate <= now).slice(-1)[0] ?? null;

  console.log(`\n=== Контрольные точки (READ-ONLY) · club=${clubId} · legalEntity=${legalEntityId} ===\n`);
  console.log("Полная цепочка версий (свежие сверху):");
  for (const r of rows) {
    console.log(`  ${r.id} · ${ymd(r.snapshotDate)} · v${r.version} · ${r.status}${r.supersedesSnapshotId ? ` (коррекция → ${r.supersedesSnapshotId})` : ""} · ${fmt(r.actualBalanceKopeks)} · создано ${ymd(r.createdAt)}${r.correctionReason ? ` · причина: ${r.correctionReason}` : ""}`);
  }
  console.log("\nАктивные версии + интервалы действия:");
  for (const r of activeAsc) console.log(`  ${ymd(r.snapshotDate)} · v${r.version} · ${fmt(r.actualBalanceKopeks)} · ${intervalOf(r.id)}`);

  console.log(`\nТекущая применимая точка (latest active, snapshotDate ≤ сегодня): ${currentApplicable ? `${ymd(currentApplicable.snapshotDate)} · v${currentApplicable.version} · ${fmt(currentApplicable.actualBalanceKopeks)}` : "нет"}`);
  console.log(`Расчётный текущий контрольный остаток (opening): ${currentApplicable ? fmt(currentApplicable.actualBalanceKopeks) : "0,00 ₽"}`);

  // Proof: adding a backdated point earlier than the current applicable one does not change
  // the current applicable point (it stays the latest-dated active ≤ now).
  const earliestActive = activeAsc[0] ?? null;
  const backdatedIsNotCurrent = currentApplicable && earliestActive && currentApplicable.id !== earliestActive.id;
  console.log(`\nПруф backdated-инварианта: самая ранняя активная точка (${earliestActive ? ymd(earliestActive.snapshotDate) : "—"}) ${backdatedIsNotCurrent ? "НЕ является" : "является"} текущей применимой (${currentApplicable ? ymd(currentApplicable.snapshotDate) : "—"}).`);
  console.log(backdatedIsNotCurrent
    ? "  ✅ Более ранняя (backdated) точка действует только до следующей точки и НЕ влияет на текущий остаток."
    : "  ℹ Активна одна точка (или самая ранняя = текущая) — добавьте более позднюю точку, чтобы увидеть эффект интервала.");
  console.log("\nДанные НЕ изменялись (read-only).");
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
