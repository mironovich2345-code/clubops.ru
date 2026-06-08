import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { canManageSalesPlans } from "@/lib/auth";
import { getCurrentAccessContext, getCurrentCompanyAndClub, getClubsInScope, recordAudit } from "@/lib/access";
import { monthKey } from "@/lib/sales-plans";

export const dynamic = "force-dynamic";

// GET /api/sales-plans/template — XLSX template of accessible clubs for the
// general director to fill in monthly plans (общий / абонементы / персональные).
export async function GET() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) {
    return NextResponse.json({ error: "Нет доступа" }, { status: 401 });
  }
  if (!canManageSalesPlans(ctx.effectiveRoles)) {
    return NextResponse.json({ error: "Доступно только Ген.директору" }, { status: 403 });
  }

  const scope = await getCurrentCompanyAndClub(ctx.user);
  const clubs = await getClubsInScope(scope);
  const month = monthKey(new Date());

  const header = ["Город", "Клуб", "Месяц", "План общий", "План абонементы", "План персональные тренировки"];
  const exampleRow = ["Рязань", "Чапаева", "2026-06", 1_500_000, 1_000_000, 500_000];
  const clubRows =
    clubs.length > 0
      ? clubs.map((c) => [c.city, c.name, month, "", "", ""])
      : [exampleRow];

  const ws = XLSX.utils.aoa_to_sheet([header, ...clubRows]);
  ws["!cols"] = [{ wch: 16 }, { wch: 22 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 26 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Планы");
  const buf = new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);

  await recordAudit({
    action: "sales_plan.template_downloaded",
    entityType: "SalesPlan",
    companyId: ctx.selectedCompanyId,
    userId: ctx.user.id,
    metadata: { clubs: clubs.length, month },
  });

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="sales-plans-template-${month}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
