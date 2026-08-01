// Server-side data helpers for the two cash-movement features:
//  1) «Передать деньги региональному директору» (CashRegionalTransfer)
//  2) append-only / versioned control balances (BalanceSnapshot versioning)
// Reads + pure interval math only; write actions live in collections/actions.ts.
// No secrets, no PII beyond the recipient display name that the operation snapshots.
import { prisma } from "@/lib/prisma";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Start of the club-local calendar day (the cash contour compares by day). */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function nextDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

// --- Transfer: eligible recipients ----------------------------------------
export type RegionalDirectorOption = { id: string; name: string };

/** Active regional directors who have access to this club (club-level assignment) OR to
 *  the company (company-level regional). Archived / inactive users are never returned —
 *  cash may only be handed to a real, eligible regional director. */
export async function getEligibleRegionalDirectorsForClub(companyId: string, clubId: string): Promise<RegionalDirectorOption[]> {
  const [clubLevel, companyLevel] = await Promise.all([
    prisma.clubUserAccess.findMany({ where: { clubId, role: "regional_director", user: { isActive: true } }, select: { user: { select: { id: true, name: true } } } }),
    prisma.companyUserAccess.findMany({ where: { companyId, role: "regional_director", user: { isActive: true } }, select: { user: { select: { id: true, name: true } } } }),
  ]);
  const byId = new Map<string, string>();
  for (const r of [...clubLevel, ...companyLevel]) byId.set(r.user.id, r.user.name);
  return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/** True only if the user holds an EXPLICIT club-manager assignment for this club. A
 *  regional director (implied-manager via role implications) is deliberately NOT a
 *  manager here — they cannot confirm receipt of their own transfer. */
export async function isExplicitClubManager(userId: string, clubId: string): Promise<boolean> {
  const row = await prisma.clubUserAccess.findFirst({ where: { clubId, userId, role: "manager" }, select: { id: true } });
  return Boolean(row);
}

// --- Transfer: history -----------------------------------------------------
export type RegionalTransferRow = {
  id: string; clubId: string; amountKopeks: number; operationDate: Date; recipientNameSnapshot: string;
  status: string; comment: string | null; createdById: string; createdAt: Date;
  confirmedById: string | null; confirmedAt: Date | null; cancelledById: string | null; cancellationReason: string | null;
};
export async function getRegionalTransfersForClub(clubId: string, limit = 50): Promise<RegionalTransferRow[]> {
  return prisma.cashRegionalTransfer.findMany({
    where: { clubId }, orderBy: [{ operationDate: "desc" }, { createdAt: "desc" }], take: limit,
    select: { id: true, clubId: true, amountKopeks: true, operationDate: true, recipientNameSnapshot: true, status: true, comment: true, createdById: true, createdAt: true, confirmedById: true, confirmedAt: true, cancelledById: true, cancellationReason: true },
  });
}

// --- Snapshot versioning + timeline ---------------------------------------
/** The ACTIVE snapshot for (club, legalEntity) on a given calendar day, if any — used to
 *  refuse a plain same-date duplicate (task §11) and as the correction target. */
export async function getActiveSnapshotOnDate(clubId: string, legalEntityId: string, date: Date) {
  return prisma.balanceSnapshot.findFirst({
    where: { clubId, legalEntityId, status: "active", snapshotDate: { gte: startOfDay(date), lt: nextDay(date) } },
    select: { id: true, snapshotDate: true, actualBalanceKopeks: true, version: true },
  });
}

/** The next ACTIVE control point strictly AFTER a given day (for the backdated warning /
 *  affected-interval preview). */
export async function getNextActiveSnapshotAfter(clubId: string, legalEntityId: string, date: Date) {
  return prisma.balanceSnapshot.findFirst({
    where: { clubId, legalEntityId, status: "active", snapshotDate: { gte: nextDay(date) } },
    orderBy: { snapshotDate: "asc" },
    select: { id: true, snapshotDate: true, actualBalanceKopeks: true },
  });
}

export type SnapshotTimelineRow = {
  id: string; legalEntityId: string; snapshotDate: Date; actualBalanceKopeks: number; comment: string | null;
  status: string; version: number; supersedesSnapshotId: string | null; correctionReason: string | null;
  cancelledById: string | null; cancellationReason: string | null;
  createdById: string; createdAt: Date;
  effectiveFrom: string; effectiveTo: string | null; // "с 01.07 до 02.07" / "с 02.07 по настоящее время"
};

/** Timeline of control points for a club's legal entity: every version (active +
 *  superseded + cancelled), each active point annotated with its coverage interval (until
 *  the next active point, else «по настоящее время»). */
export async function getSnapshotTimeline(clubId: string, legalEntityId: string): Promise<SnapshotTimelineRow[]> {
  const rows = await prisma.balanceSnapshot.findMany({
    where: { clubId, legalEntityId },
    orderBy: [{ snapshotDate: "desc" }, { version: "desc" }, { createdAt: "desc" }],
    select: { id: true, legalEntityId: true, snapshotDate: true, actualBalanceKopeks: true, comment: true, status: true, version: true, supersedesSnapshotId: true, correctionReason: true, cancelledById: true, cancellationReason: true, createdById: true, createdAt: true },
  });
  const activeAsc = rows.filter((r) => r.status === "active").sort((a, b) => a.snapshotDate.getTime() - b.snapshotDate.getTime());
  const nextByActiveId = new Map<string, Date | null>();
  for (let i = 0; i < activeAsc.length; i++) nextByActiveId.set(activeAsc[i].id, i + 1 < activeAsc.length ? activeAsc[i + 1].snapshotDate : null);
  return rows.map((r) => ({
    ...r,
    effectiveFrom: ymd(r.snapshotDate),
    effectiveTo: r.status === "active" ? (nextByActiveId.get(r.id) ? ymd(nextByActiveId.get(r.id)!) : null) : null,
  }));
}
