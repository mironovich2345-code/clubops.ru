import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { canAnyRoleAccessPage, canCreateOperational } from "@/lib/auth";
import { getCurrentAccessContext, getCurrentCompanyAndClub, getClubsInScope, recordAudit } from "@/lib/access";
import { EXPENSE_CATEGORY_OPTIONS, PAYMENT_METHOD_OPTIONS } from "@/lib/expenses";

export const dynamic = "force-dynamic";

const HEADER = [
  "Дата",
  "Клуб",
  "Статья",
  "Тип",
  "Способ оплаты",
  "Юрлицо",
  "Контрагент / магазин / получатель",
  "Сумма",
  "Комментарий",
];

// GET /api/expenses/template — XLSX template of accessible clubs for importing
// expenses. Allowed categories / payment methods are listed on a second sheet.
export async function GET() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || !canAnyRoleAccessPage(ctx.effectiveRoles, "expenses")) {
    return NextResponse.json({ error: "Нет доступа" }, { status: 401 });
  }
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return NextResponse.json({ error: "Доступно управляющим и региональным директорам" }, { status: 403 });
  }

  const scope = await getCurrentCompanyAndClub(ctx.user);
  const clubs = await getClubsInScope(scope);
  const example = ["2026-06-01", clubs[0]?.name ?? "Чапаева", "Реклама", "Ручной", "Карта", "ООО", "Яндекс Директ", 15000, "Таргет июнь"];
  const clubRows = clubs.length > 0 ? clubs.map((c) => ["", c.name, "", "", "", "", "", "", ""]) : [];

  const ws = XLSX.utils.aoa_to_sheet([HEADER, example, ...clubRows]);
  ws["!cols"] = HEADER.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Расходы");

  // Reference sheet: allowed values (categories + payment methods).
  const ref = [
    ["Допустимые статьи", "Допустимые способы оплаты"],
    ...EXPENSE_CATEGORY_OPTIONS.map((c, i) => [c.label, PAYMENT_METHOD_OPTIONS[i]?.label ?? ""]),
  ];
  const wsRef = XLSX.utils.aoa_to_sheet(ref);
  wsRef["!cols"] = [{ wch: 22 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, wsRef, "Справочник");

  const buf = new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);

  await recordAudit({
    action: "expense.template_downloaded",
    entityType: "Expense",
    companyId: ctx.selectedCompanyId,
    userId: ctx.user.id,
    metadata: { clubs: clubs.length },
  });

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="expenses-template.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
