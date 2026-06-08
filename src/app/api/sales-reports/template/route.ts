import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { canAnyRoleAccessPage, canCreateOperational } from "@/lib/auth";
import { getCurrentAccessContext, getCurrentCompanyAndClub, getClubsInScope, recordAudit } from "@/lib/access";

export const dynamic = "force-dynamic";

const HEADER = [
  "Дата отчёта",
  "Клуб",
  "Менеджер смены",
  "Наличные ООО",
  "Карты ООО",
  "СБП ООО",
  "Ссылка ООО",
  "Абонементы ООО",
  "ПТ + ГП ООО",
  "Инкассация ООО",
  "Изъятие",
  "Наличные ИП",
  "Карты ИП",
  "СБП ИП",
];

// GET /api/sales-reports/template — XLSX template of accessible clubs for
// importing daily sales reports. Calculated fields are intentionally omitted.
export async function GET() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || !canAnyRoleAccessPage(ctx.effectiveRoles, "sales")) {
    return NextResponse.json({ error: "Нет доступа" }, { status: 401 });
  }
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return NextResponse.json({ error: "Доступно управляющим и региональным директорам" }, { status: 403 });
  }

  const scope = await getCurrentCompanyAndClub(ctx.user);
  const clubs = await getClubsInScope(scope);
  const example = ["2026-06-01", clubs[0]?.name ?? "Чапаева", "Иванова А.", 50000, 30000, 10000, 5000, 40000, 20000, 45000, 0, 15000, 8000, 4000];
  const clubRows = clubs.length > 0 ? clubs.map((c) => ["", c.name, "", "", "", "", "", "", "", "", "", "", "", ""]) : [];

  const ws = XLSX.utils.aoa_to_sheet([HEADER, example, ...clubRows]);
  ws["!cols"] = HEADER.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Сменные отчёты");
  const buf = new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);

  await recordAudit({
    action: "sales_report.template_downloaded",
    entityType: "SalesReport",
    companyId: ctx.selectedCompanyId,
    userId: ctx.user.id,
    metadata: { clubs: clubs.length },
  });

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="sales-reports-template.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
