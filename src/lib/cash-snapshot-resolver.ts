// REM-02 — the SINGLE canonical rule for choosing the governing control snapshot (closes ARCH-001).
// Every reader that needs "the opening balance for a (club, legalEntity)" must use this — never an
// ad-hoc balanceSnapshot query. Rule: the latest `status:"active"` snapshot with `snapshotDate ≤ asOf`,
// per (club, legalEntity), tie-broken by createdAt desc. `superseded` and `cancelled` are excluded; a
// back-dated active point never overrides a later active one. Money = integer kopeks.
import { prisma } from "@/lib/prisma";
import type { DbClient } from "@/lib/db-client";

export const CASH_FORMULA_VERSION = "rem-02.v1";

/** The canonical WHERE fragment for the governing active snapshot. `exclusive` uses `< asOf`
 * (as-of-start-of-day reports); default uses `≤ asOf` (current balance up to and including asOf). */
export function activeSnapshotWhere(asOf: Date, opts?: { exclusive?: boolean }) {
  return { status: "active" as const, snapshotDate: opts?.exclusive ? { lt: asOf } : { lte: asOf } };
}

export type ResolvedSnapshot = { legalEntityId: string; actualBalanceKopeks: number; snapshotDate: Date };

/**
 * Latest active governing snapshot per (club, legalEntity) at `asOf`. Returns a Map keyed by
 * `${clubId}|${legalEntityId}`. One query, the canonical rule, injectable client for tests/tx.
 */
export async function resolveActiveSnapshots(
  args: { companyId?: string; clubIds: string[]; legalEntityIds?: string[]; asOf?: Date; exclusive?: boolean },
  db: DbClient = prisma,
): Promise<Map<string, ResolvedSnapshot>> {
  const out = new Map<string, ResolvedSnapshot>();
  if (args.clubIds.length === 0) return out;
  const asOf = args.asOf ?? new Date();
  const rows = await db.balanceSnapshot.findMany({
    where: {
      ...(args.companyId ? { companyId: args.companyId } : {}),
      clubId: { in: args.clubIds },
      ...(args.legalEntityIds ? { legalEntityId: { in: args.legalEntityIds } } : {}),
      ...activeSnapshotWhere(asOf, { exclusive: args.exclusive }),
    },
    orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }],
    select: { clubId: true, legalEntityId: true, actualBalanceKopeks: true, snapshotDate: true },
  });
  // Rows are desc-ordered → the first row seen per (club, legalEntity) is the governing one.
  for (const r of rows) {
    const key = `${r.clubId}|${r.legalEntityId}`;
    if (!out.has(key)) out.set(key, { legalEntityId: r.legalEntityId, actualBalanceKopeks: r.actualBalanceKopeks, snapshotDate: r.snapshotDate });
  }
  return out;
}
