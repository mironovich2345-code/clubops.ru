// Cash balance snapshots (Finance Control v1.0). Append-only log per club +
// legal entity; the latest snapshot (by snapshotDate, then createdAt) is the
// current balance. Provides the real source of truth for ООО / ИП balances.
//
// All queries are scope-safe: callers pass companyId + allowedClubIds and we
// never widen beyond them.
import { prisma } from "@/lib/prisma";
import { normalizeEntityType, type LegalEntityType } from "@/lib/legal-entities";

export type EntityBalance = { kopeks: number | null; latestDate: Date | null };

export type ScopeBalances = {
  ooo: EntityBalance;
  ip: EntityBalance;
  totalKopeks: number | null; // null when neither has a snapshot; never invented
};

const EMPTY: EntityBalance = { kopeks: null, latestDate: null };

/** Sum of the latest snapshot per (club, entity), aggregated by ООО / ИП for the scope. */
export async function getLatestBalancesForScope(companyId: string, clubIds: string[]): Promise<ScopeBalances> {
  if (clubIds.length === 0) return { ooo: EMPTY, ip: EMPTY, totalKopeks: null };
  const snaps = await prisma.balanceSnapshot.findMany({
    where: { companyId, clubId: { in: clubIds } },
    orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }],
    select: { clubId: true, legalEntityId: true, actualBalanceKopeks: true, snapshotDate: true, legalEntity: { select: { type: true } } },
  });

  const seen = new Set<string>(); // clubId|legalEntityId — first row is the latest
  let oooKopeks: number | null = null;
  let ipKopeks: number | null = null;
  let oooDate: Date | null = null;
  let ipDate: Date | null = null;
  for (const s of snaps) {
    const key = `${s.clubId}|${s.legalEntityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = normalizeEntityType(s.legalEntity.type);
    if (t === "ooo") {
      oooKopeks = (oooKopeks ?? 0) + s.actualBalanceKopeks;
      if (!oooDate || s.snapshotDate > oooDate) oooDate = s.snapshotDate;
    } else if (t === "ip") {
      ipKopeks = (ipKopeks ?? 0) + s.actualBalanceKopeks;
      if (!ipDate || s.snapshotDate > ipDate) ipDate = s.snapshotDate;
    }
  }
  const totalKopeks = oooKopeks === null && ipKopeks === null ? null : (oooKopeks ?? 0) + (ipKopeks ?? 0);
  return {
    ooo: { kopeks: oooKopeks, latestDate: oooDate },
    ip: { kopeks: ipKopeks, latestDate: ipDate },
    totalKopeks,
  };
}

export type ClubBalances = { oooKopeks: number | null; ipKopeks: number | null; latestDate: Date | null };

/**
 * Latest ООО / ИП balance per club for the dashboard club cards.
 *
 * When `asOfExclusive` is given, only snapshots with `snapshotDate < asOfExclusive`
 * are considered — i.e. the latest snapshot at or before the end of the selected
 * month (pass the first day of the FOLLOWING month). This never falls forward to
 * a future snapshot; a club/entity with no qualifying snapshot stays null
 * ("Нет данных"). Without the cutoff, returns the absolute latest (today).
 */
export async function getLatestBalancesByClub(
  companyId: string,
  clubIds: string[],
  asOfExclusive?: Date,
): Promise<Map<string, ClubBalances>> {
  const out = new Map<string, ClubBalances>();
  if (clubIds.length === 0) return out;
  const snaps = await prisma.balanceSnapshot.findMany({
    where: {
      companyId,
      clubId: { in: clubIds },
      ...(asOfExclusive ? { snapshotDate: { lt: asOfExclusive } } : {}),
    },
    orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }],
    select: { clubId: true, legalEntityId: true, actualBalanceKopeks: true, snapshotDate: true, legalEntity: { select: { type: true } } },
  });
  const seen = new Set<string>();
  for (const s of snaps) {
    const key = `${s.clubId}|${s.legalEntityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = out.get(s.clubId) ?? { oooKopeks: null, ipKopeks: null, latestDate: null };
    const t = normalizeEntityType(s.legalEntity.type);
    if (t === "ooo") row.oooKopeks = (row.oooKopeks ?? 0) + s.actualBalanceKopeks;
    else if (t === "ip") row.ipKopeks = (row.ipKopeks ?? 0) + s.actualBalanceKopeks;
    if (!row.latestDate || s.snapshotDate > row.latestDate) row.latestDate = s.snapshotDate;
    out.set(s.clubId, row);
  }
  return out;
}

export type SnapshotHistoryRow = {
  id: string;
  snapshotDate: Date;
  legalEntityName: string;
  legalEntityType: LegalEntityType | null;
  clubName: string;
  actualBalanceKopeks: number;
  comment: string | null;
  createdByName: string;
};

/** Most recent snapshots for the scope (financial-control log; read-only). */
export async function getRecentSnapshots(companyId: string, clubIds: string[], limit = 10): Promise<SnapshotHistoryRow[]> {
  if (clubIds.length === 0) return [];
  const rows = await prisma.balanceSnapshot.findMany({
    where: { companyId, clubId: { in: clubIds } },
    orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }],
    take: limit,
    select: {
      id: true, snapshotDate: true, actualBalanceKopeks: true, comment: true,
      club: { select: { name: true } },
      legalEntity: { select: { name: true, type: true } },
      createdBy: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    snapshotDate: r.snapshotDate,
    legalEntityName: r.legalEntity.name,
    legalEntityType: normalizeEntityType(r.legalEntity.type),
    clubName: r.club.name,
    actualBalanceKopeks: r.actualBalanceKopeks,
    comment: r.comment,
    createdByName: r.createdBy.name,
  }));
}

export type SnapshotTarget = { clubId: string; clubName: string; legalEntityId: string; legalEntityName: string; type: LegalEntityType | null };

/** (club, active legal entity) pairs the user may snapshot, scoped. */
export async function getSnapshotTargetsForScope(companyId: string, clubIds: string[]): Promise<SnapshotTarget[]> {
  if (clubIds.length === 0) return [];
  const links = await prisma.clubLegalEntity.findMany({
    // Active associations only (join.isActive) of globally-active entities.
    where: { clubId: { in: clubIds }, isActive: true, legalEntity: { companyId, isActive: true } },
    select: { clubId: true, club: { select: { name: true } }, legalEntityId: true, legalEntity: { select: { name: true, type: true } } },
  });
  return links
    .map((l) => ({
      clubId: l.clubId,
      clubName: l.club.name,
      legalEntityId: l.legalEntityId,
      legalEntityName: l.legalEntity.name,
      type: normalizeEntityType(l.legalEntity.type),
    }))
    .sort((a, b) => a.clubName.localeCompare(b.clubName) || (a.type ?? "").localeCompare(b.type ?? ""));
}
