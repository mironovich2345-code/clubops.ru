// Month closing: once a (company [+ club] + month) period is closed, financial
// changes for that period are blocked server-side. A company-wide close
// (clubId null) covers every club.
import { prisma } from "@/lib/prisma";

export const MONTH_CLOSED_ERROR = "Месяц закрыт для изменений";

export function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function isValidMonth(month: string): boolean {
  return /^\d{4}-\d{2}$/.test(month);
}

/** True if the (company, club, month) period is closed — either by a
 * club-specific close or a company-wide (clubId null) close. */
export async function isMonthClosed(companyId: string, clubId: string | null, month: string): Promise<boolean> {
  const row = await prisma.monthClose.findFirst({
    where: {
      companyId,
      month,
      status: "closed",
      OR: [{ clubId: null }, ...(clubId ? [{ clubId }] : [])],
    },
    select: { id: true },
  });
  return row != null;
}

/** Returns the month-closed error string if the period is closed, else null. */
export async function monthClosedError(companyId: string, clubId: string | null, date: Date): Promise<string | null> {
  return (await isMonthClosed(companyId, clubId, monthKeyOf(date))) ? MONTH_CLOSED_ERROR : null;
}

/** Cached per-action checker (avoids repeated queries inside import loops). */
export function makeMonthCloseChecker(companyId: string) {
  const cache = new Map<string, boolean>();
  return async (clubId: string, date: Date): Promise<boolean> => {
    const key = `${clubId}|${monthKeyOf(date)}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const closed = await isMonthClosed(companyId, clubId, monthKeyOf(date));
    cache.set(key, closed);
    return closed;
  };
}

export type MonthCloseInfo = {
  month: string;
  status: "open" | "closed";
  closedByName: string | null;
  closedAt: Date | null;
  comment: string | null;
};

/** Effective close status for a scope (a company-wide close takes precedence). */
export async function getMonthCloseInfo(
  companyId: string,
  clubId: string | null,
  month: string,
): Promise<MonthCloseInfo> {
  const rows = await prisma.monthClose.findMany({
    where: { companyId, month, OR: [{ clubId: null }, ...(clubId ? [{ clubId }] : [])] },
    orderBy: { updatedAt: "desc" },
  });
  const closed = rows.find((r) => r.status === "closed");
  if (!closed) return { month, status: "open", closedByName: null, closedAt: null, comment: null };
  const user = closed.closedByUserId
    ? await prisma.user.findUnique({ where: { id: closed.closedByUserId }, select: { name: true } })
    : null;
  return { month, status: "closed", closedByName: user?.name ?? null, closedAt: closed.closedAt, comment: closed.comment };
}
