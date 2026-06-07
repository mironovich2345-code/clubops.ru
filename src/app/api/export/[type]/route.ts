import { NextResponse } from "next/server";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { resolvePeriod, type AnalyticsPeriodKey } from "@/lib/analytics";
import { toCsv } from "@/lib/csv";
import { isExportType, canExport, buildExport, exportFilename, EXPORT_AUDIT } from "@/lib/exports";

export const dynamic = "force-dynamic";

function parseDate(v: string | null): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const PERIOD_KEYS = ["current_month", "previous_month", "custom"];

export async function GET(req: Request, { params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  if (!isExportType(type)) return new NextResponse("Bad request", { status: 400 });

  const ctx = await getCurrentAccessContext();
  if (!ctx) return new NextResponse("Unauthorized", { status: 401 });
  if (!ctx.selectedCompanyId) return new NextResponse("No company", { status: 400 });
  // Role gate (same scoped checks as the pages enforce; scope below limits clubs).
  if (!canExport(ctx.effectiveRoles, type)) return new NextResponse("Forbidden", { status: 403 });

  const url = new URL(req.url);
  const periodKey = (PERIOD_KEYS.includes(url.searchParams.get("period") ?? "")
    ? url.searchParams.get("period")
    : "current_month") as AnalyticsPeriodKey;
  const period = resolvePeriod(periodKey, new Date(), parseDate(url.searchParams.get("from")), parseDate(url.searchParams.get("to")));

  // Never trust the clubId param: only honour it when it is in the viewer's
  // allowed clubs, otherwise fall back to the full allowed scope.
  const clubParam = url.searchParams.get("clubId");
  const clubIds = clubParam && ctx.allowedClubIds.includes(clubParam) ? [clubParam] : ctx.allowedClubIds;
  const status = url.searchParams.get("status") || undefined;
  const category = url.searchParams.get("category") || undefined;

  const { headers, rows } = await buildExport(type, ctx.selectedCompanyId, clubIds, period.start, period.end, { status, category });
  const csv = toCsv(headers, rows);

  await recordAudit({
    action: EXPORT_AUDIT[type],
    entityType: "Export",
    companyId: ctx.selectedCompanyId,
    userId: ctx.user.id,
    metadata: {
      type,
      period: periodKey,
      from: url.searchParams.get("from") ?? null,
      to: url.searchParams.get("to") ?? null,
      clubIds,
      status: status ?? null,
      category: category ?? null,
      count: rows.length,
    },
  });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(type, period.start, period.end)}"`,
      "Cache-Control": "no-store",
    },
  });
}
