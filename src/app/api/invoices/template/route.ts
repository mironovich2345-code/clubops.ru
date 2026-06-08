import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { canAnyRoleAccessPage, canCreateOperational } from "@/lib/auth";
import { getCurrentAccessContext, getCurrentCompanyAndClub, getClubsInScope, recordAudit } from "@/lib/access";

export const dynamic = "force-dynamic";

const HEADER = [
  "Дата счёта",
  "Клуб",
  "Юрлицо",
  "Поставщик",
  "ИНН поставщика",
  "КПП поставщика",
  "Банк поставщика",
  "БИК",
  "Расчётный счёт",
  "Корр. счёт",
  "Плательщик",
  "ИНН плательщика",
  "Номер счёта",
  "Сумма",
  "Статья расходов",
  "Срок оплаты",
  "Комментарий",
];

// GET /api/invoices/template — XLSX template of accessible clubs for importing
// supplier invoices (imported as needs_review, never paid).
export async function GET() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    return NextResponse.json({ error: "Нет доступа" }, { status: 401 });
  }
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return NextResponse.json({ error: "Доступно управляющим и региональным директорам" }, { status: 403 });
  }

  const scope = await getCurrentCompanyAndClub(ctx.user);
  const clubs = await getClubsInScope(scope);
  const example = [
    "2026-06-01",
    clubs[0]?.name ?? "Чапаева",
    "ООО",
    "ООО Поставщик",
    "7700000000",
    "770001001",
    "Сбербанк",
    "044525225",
    "40702810000000000001",
    "30101810400000000225",
    "ООО Плательщик",
    "7700000001",
    "СЧ-001",
    25000,
    "Хозрасходы",
    "2026-06-15",
    "Поставка инвентаря",
  ];
  const clubRows = clubs.length > 0 ? clubs.map((c) => ["", c.name, ...Array(HEADER.length - 2).fill("")]) : [];

  const ws = XLSX.utils.aoa_to_sheet([HEADER, example, ...clubRows]);
  ws["!cols"] = HEADER.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Счета");
  const buf = new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);

  await recordAudit({
    action: "invoice.template_downloaded",
    entityType: "Invoice",
    companyId: ctx.selectedCompanyId,
    userId: ctx.user.id,
    metadata: { clubs: clubs.length },
  });

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="invoices-template.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
