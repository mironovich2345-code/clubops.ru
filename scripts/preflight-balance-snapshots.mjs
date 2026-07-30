// READ-ONLY preflight for the BalanceSnapshot versioning rollout (task §15). Reports
// records that need attention BEFORE/AFTER the migration — it changes nothing.
//   node scripts/preflight-balance-snapshots.mjs
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const ymd = (d) => d.toISOString().slice(0, 10);

async function main() {
  const snaps = await prisma.balanceSnapshot.findMany({
    select: { id: true, clubId: true, legalEntityId: true, snapshotDate: true, status: true, actualBalanceKopeks: true, version: true },
  });
  console.log(`Всего контрольных точек: ${snaps.length}\n`);

  // 1) Duplicate ACTIVE points on the same (club, legalEntity, date) — must be reconciled.
  const activeKey = new Map();
  const dupes = [];
  for (const s of snaps.filter((x) => x.status === "active")) {
    const k = `${s.clubId}|${s.legalEntityId}|${ymd(s.snapshotDate)}`;
    if (activeKey.has(k)) dupes.push({ k, a: activeKey.get(k), b: s.id });
    else activeKey.set(k, s.id);
  }
  console.log(`[1] Дубли активных точек на одну дату: ${dupes.length}`);
  for (const d of dupes) console.log(`    ${d.k} → ${d.a} & ${d.b}`);

  // 2) Future-dated points (a physical count can't be in the future).
  const now = new Date();
  const future = snaps.filter((s) => s.snapshotDate.getTime() > now.getTime());
  console.log(`[2] Точки с датой в будущем: ${future.length}`);
  for (const s of future) console.log(`    ${s.id} · ${ymd(s.snapshotDate)}`);

  // 3) Points whose legalEntity no longer exists.
  const leIds = [...new Set(snaps.map((s) => s.legalEntityId))];
  const les = leIds.length ? await prisma.legalEntity.findMany({ where: { id: { in: leIds } }, select: { id: true } }) : [];
  const leSet = new Set(les.map((e) => e.id));
  const orphanLE = snaps.filter((s) => !leSet.has(s.legalEntityId));
  console.log(`[3] Точки без существующего юрлица: ${orphanLE.length}`);
  for (const s of orphanLE) console.log(`    ${s.id} · legalEntityId=${s.legalEntityId}`);

  // 4) Points on archived (inactive) clubs.
  const clubIds = [...new Set(snaps.map((s) => s.clubId))];
  const clubs = clubIds.length ? await prisma.club.findMany({ where: { id: { in: clubIds } }, select: { id: true, isActive: true, name: true } }) : [];
  const inactive = new Set(clubs.filter((c) => !c.isActive).map((c) => c.id));
  const archived = snaps.filter((s) => inactive.has(s.clubId));
  console.log(`[4] Точки на архивных клубах: ${archived.length}`);
  for (const s of archived) console.log(`    ${s.id} · club=${s.clubId}`);

  // 5) Incompatible status / version (base rows should be active/v1 after migration).
  const bad = snaps.filter((s) => (s.status !== "active" && s.status !== "superseded") || !Number.isInteger(s.version) || s.version < 1);
  console.log(`[5] Некорректный status/version: ${bad.length}`);
  for (const s of bad) console.log(`    ${s.id} · status=${s.status} · version=${s.version}`);

  const total = dupes.length + future.length + orphanLE.length + archived.length + bad.length;
  console.log(`\nИтого записей, требующих внимания: ${total}. Данные НЕ изменялись (read-only).`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
