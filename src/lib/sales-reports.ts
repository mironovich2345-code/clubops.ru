import type { SalesReport, SalesReportLine, SalesReportDocument } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DataScope, AccessContext } from "@/lib/access";
import type { Role } from "@/lib/auth";
import {
  SALES_REPORT_ACTION_LABELS,
  REVENUE_LINE_KEY,
  type SalesReportAction,
  type SalesReportStatus,
} from "@/lib/sales-report-rows";

// Re-export the client-safe pieces so existing imports from "@/lib/sales-reports"
// keep working (rows, labels, validation, action map).
export * from "@/lib/sales-report-rows";

// ---------------------------------------------------------------------------
// Daily sales report (сменный отчёт). Mirrors the Sale verification workflow:
// a manager submits a report (named amount lines) as pending_accountant; an
// accountant/owner confirms it into realized revenue or rejects it. Only the
// "confirmed" report's total_revenue line counts toward dashboard/analytics.
// ---------------------------------------------------------------------------

type ReportTransition = { ok: true; to: SalesReportStatus } | { ok: false; error: string };

/**
 * Pure decision table (single source of truth):
 *  - confirm/reject: accountant or owner, on a pending report. A non-owner may
 *    not confirm a report they submitted (separation of duties).
 *  - cancel: the creator or the owner, on a pending report.
 */
export function applySalesReportAction(
  action: SalesReportAction,
  status: string,
  roles: readonly Role[],
  isCreator: boolean,
): ReportTransition {
  const isOwner = roles.includes("owner");
  const isAccountant = roles.includes("accountant");

  switch (action) {
    case "confirm":
      if (!(isAccountant || isOwner)) return { ok: false, error: "Недостаточно прав для подтверждения" };
      if (isCreator && !isOwner) return { ok: false, error: "Нельзя подтвердить собственный отчёт" };
      if (status !== "pending_accountant") return { ok: false, error: "Подтвердить можно отчёт на проверке" };
      return { ok: true, to: "confirmed" };
    case "reject":
      if (!(isAccountant || isOwner)) return { ok: false, error: "Недостаточно прав для отклонения" };
      if (status !== "pending_accountant") return { ok: false, error: "Отклонить можно отчёт на проверке" };
      return { ok: true, to: "rejected" };
    case "cancel":
      if (status !== "pending_accountant") return { ok: false, error: "Отменить можно только отчёт на проверке" };
      if (!(isOwner || isCreator)) return { ok: false, error: "Недостаточно прав для отмены" };
      return { ok: true, to: "canceled" };
  }
}

export function availableSalesReportActions(
  status: string,
  roles: readonly Role[],
  isCreator: boolean,
): SalesReportAction[] {
  return (Object.keys(SALES_REPORT_ACTION_LABELS) as SalesReportAction[]).filter(
    (a) => applySalesReportAction(a, status, roles, isCreator).ok,
  );
}

/** A pending report may have documents attached by its creator or an owner. */
export function canEditReport(status: string, roles: readonly Role[], isCreator: boolean): boolean {
  if (status !== "pending_accountant") return false;
  return roles.includes("owner") || isCreator;
}

// --- queries ---------------------------------------------------------------

export type SalesReportWithRelations = SalesReport & {
  club: { id: string; name: string; city: string };
  createdBy: { id: string; name: string };
  lines: SalesReportLine[];
  documents: SalesReportDocument[];
};

export type SalesReportListRow = SalesReport & {
  club: { id: string; name: string };
  createdBy: { id: string; name: string };
  lines: Array<{ key: string; amountKopeks: number }>;
  _count: { documents: number };
};

/** Reports for the scope (list view), newest first, with the revenue line + doc count. */
export async function getSalesReportsForScope(scope: DataScope): Promise<SalesReportListRow[]> {
  if (!scope.company || scope.clubIds.length === 0) return [];
  const rows = await prisma.salesReport.findMany({
    where: { companyId: scope.company.id, clubId: { in: scope.clubIds } },
    orderBy: [{ reportDate: "desc" }, { createdAt: "desc" }],
    include: {
      club: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      lines: { where: { key: REVENUE_LINE_KEY }, select: { key: true, amountKopeks: true } },
      _count: { select: { documents: true } },
    },
    take: 200,
  });
  return rows as SalesReportListRow[];
}

/** Single report scoped to the access context (company + allowed clubs). */
export async function getSalesReportForContext(
  ctx: AccessContext,
  reportId: string,
): Promise<SalesReportWithRelations | null> {
  if (!ctx.selectedCompanyId) return null;
  const report = await prisma.salesReport.findUnique({
    where: { id: reportId },
    include: {
      club: true,
      createdBy: { select: { id: true, name: true } },
      lines: { orderBy: { sortOrder: "asc" } },
      documents: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!report) return null;
  if (report.companyId !== ctx.selectedCompanyId) return null;
  if (!ctx.allowedClubIds.includes(report.clubId)) return null;
  return report as SalesReportWithRelations;
}

export type ReportRevenueEvent = { clubId: string; amountKopeks: number; saleDate: Date; source: string };

/**
 * Confirmed reports as revenue events (total_revenue line), shaped like Sale
 * revenue so dashboard/analytics can fold them into existing aggregations.
 */
export async function getConfirmedReportRevenue(scope: DataScope): Promise<ReportRevenueEvent[]> {
  if (!scope.company || scope.clubIds.length === 0) return [];
  const rows = await prisma.salesReport.findMany({
    where: { companyId: scope.company.id, clubId: { in: scope.clubIds }, status: "confirmed" },
    select: {
      clubId: true,
      reportDate: true,
      lines: { where: { key: REVENUE_LINE_KEY }, select: { amountKopeks: true } },
    },
  });
  return rows.map((r) => ({
    clubId: r.clubId,
    amountKopeks: r.lines[0]?.amountKopeks ?? 0,
    saleDate: r.reportDate,
    source: "Сменный отчёт",
  }));
}

export type PendingReportRow = {
  id: string;
  clubName: string;
  reportDate: Date;
  totalKopeks: number;
  by: string;
};

/** Pending (awaiting accountant) sales reports for the dashboard. */
export async function getPendingSalesReports(scope: DataScope): Promise<PendingReportRow[]> {
  if (!scope.company || scope.clubIds.length === 0) return [];
  const rows = await prisma.salesReport.findMany({
    where: { companyId: scope.company.id, clubId: { in: scope.clubIds }, status: "pending_accountant" },
    orderBy: { reportDate: "desc" },
    include: {
      club: { select: { name: true } },
      createdBy: { select: { name: true } },
      lines: { where: { key: REVENUE_LINE_KEY }, select: { amountKopeks: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    clubName: r.club.name,
    reportDate: r.reportDate,
    totalKopeks: r.lines[0]?.amountKopeks ?? 0,
    by: r.createdBy.name,
  }));
}
