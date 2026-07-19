// Server loader for the managerial ОФД dashboard block. Reads the SAME safe
// projections as /analytics/ofd-sales (OfdDailySalesSummary + category-day rows)
// scoped to the caller's allowed clubs, plus the latest sync-run status for a
// managerial "sync failed" signal. Delegates all math to the pure
// buildOfdDashboardOverview. No raw fiscal data, no secrets, no PII.
import { prisma } from "@/lib/prisma";
import {
  buildOfdDashboardOverview,
  currentMonth,
  monthBounds,
  ymdLocal,
  type OfdDashboardOverview,
} from "@/lib/ofd/analytics";

/** Fact ОФД overview for the current month, scoped to `clubIds`. Returns an empty
 * (hasData=false) overview when the caller has no clubs in scope. */
export async function loadOfdDashboardSummary(companyId: string, clubIds: string[], now: Date = new Date()): Promise<OfdDashboardOverview> {
  const month = currentMonth(now);
  const { from: monthFrom, to: monthTo } = monthBounds(month);
  const today = ymdLocal(now);
  const yesterday = ymdLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysPassed = now.getDate();

  const empty = () =>
    buildOfdDashboardOverview({
      summaries: [], categoryDays: [], clubNameById: {}, legalNameById: {},
      today, yesterday, monthFrom, monthTo, daysInMonth, daysPassed, nowHour: now.getHours(), lastSyncFailed: false,
    });

  if (clubIds.length === 0) return empty();

  const [clubs, entities, summaries, categoryDays, lastRun] = await Promise.all([
    prisma.club.findMany({ where: { companyId, id: { in: clubIds } }, select: { id: true, name: true } }),
    prisma.legalEntity.findMany({ where: { companyId }, select: { id: true, name: true } }),
    prisma.ofdDailySalesSummary.findMany({
      where: { companyId, provider: "taxcom", clubId: { in: clubIds } },
      select: { clubId: true, legalEntityId: true, date: true, incomeTotalKopeks: true, incomeCashKopeks: true, incomeElectronicKopeks: true, returnTotalKopeks: true, netTotalKopeks: true, receiptCount: true, returnReceiptCount: true },
    }),
    prisma.ofdRevenueCategoryDailySummary.findMany({
      where: { companyId, provider: "taxcom", clubId: { in: clubIds }, date: { startsWith: month } },
      select: { categoryCode: true, incomeTotalKopeks: true, returnTotalKopeks: true, netTotalKopeks: true, itemCount: true, receiptCount: true },
    }),
    // Latest sync run for the company — status only (never the raw error text).
    prisma.ofdSyncRun.findFirst({ where: { companyId }, orderBy: { createdAt: "desc" }, select: { status: true } }),
  ]);

  const clubNameById: Record<string, string> = {};
  for (const c of clubs) clubNameById[c.id] = c.name;
  const legalNameById: Record<string, string> = {};
  for (const e of entities) legalNameById[e.id] = e.name;

  return buildOfdDashboardOverview({
    summaries,
    categoryDays,
    clubNameById,
    legalNameById,
    today,
    yesterday,
    monthFrom,
    monthTo,
    daysInMonth,
    daysPassed,
    nowHour: now.getHours(),
    lastSyncFailed: lastRun?.status === "failed",
  });
}
