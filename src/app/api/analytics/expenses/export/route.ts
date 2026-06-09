import { NextResponse } from "next/server";
import { getCurrentAccessContext, getCurrentCompanyAndClub } from "@/lib/access";
import type { Role } from "@/lib/auth";
import { expenseCategoryLabel, PAYMENT_METHOD_LABELS } from "@/lib/expenses";
import { toCsv, csvDate, csvMoney, type CsvCell } from "@/lib/csv";
import { recordAudit } from "@/lib/access";
import { loadCategoryExpenseRows, filterDrillRows, DRILL_SOURCE_LABELS } from "@/lib/expense-drilldown";

export const dynamic = "force-dynamic";

const FINANCIAL_ROLES = new Set<Role>(["owner", "general_director", "regional_director", "accountant"]);
// "YYYY-MM-DD" → LOCAL midnight (matches the analytics period bounds).
const parseDay = (v: string | null) => {
  const m = v?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

// GET /api/analytics/expenses/export — CSV of the current category drilldown,
// honouring the same filters as the page (Part 8). Financial roles only, scoped.
export async function GET(req: Request) {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return new NextResponse("Unauthorized", { status: 401 });
  if (!ctx.effectiveRoles.some((r) => FINANCIAL_ROLES.has(r))) return new NextResponse("Forbidden", { status: 403 });

  const url = new URL(req.url);
  const category = (url.searchParams.get("category") ?? "").trim();
  if (!category) return new NextResponse("Bad request", { status: 400 });

  const scope = await getCurrentCompanyAndClub(ctx.user);
  const companyId = ctx.selectedCompanyId;
  const now = new Date();
  const start = parseDay(url.searchParams.get("from")) ?? new Date(now.getFullYear(), now.getMonth(), 1);
  const end = parseDay(url.searchParams.get("to")) ?? new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const club = url.searchParams.get("club") ?? undefined;
  const entity = url.searchParams.get("entity") ?? undefined;
  const pay = url.searchParams.get("pay") ?? undefined;
  const source = url.searchParams.get("source") ?? undefined;

  const allRows = await loadCategoryExpenseRows({ companyId, clubIds: scope.clubIds, category, start, end });
  const rows = filterDrillRows(allRows, {
    pay,
    source,
    entity: entity && scope.clubIds.length ? entity : undefined,
    club: club && scope.clubIds.includes(club) ? club : undefined,
  });

  const categoryLabel = expenseCategoryLabel(category);
  const headers = ["Дата", "Клуб", "Юрлицо", "Категория", "Тип оплаты", "Источник", "Контрагент", "Комментарий", "Сумма"];
  const csvRows: CsvCell[][] = rows.map((r) => [
    csvDate(r.date),
    r.clubName,
    r.legalEntityName ?? "",
    categoryLabel,
    r.paymentMethod ? PAYMENT_METHOD_LABELS[r.paymentMethod] ?? r.paymentMethod : r.cash ? "Наличные" : "Безналичные",
    DRILL_SOURCE_LABELS[r.source],
    r.counterparty ?? "",
    r.comment ?? "",
    csvMoney(r.amountKopeks),
  ]);
  const csv = toCsv(headers, csvRows);

  await recordAudit({
    action: "export.analytics_expenses",
    entityType: "Expense",
    companyId,
    userId: ctx.user.id,
    metadata: { category, rows: rows.length },
  });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="expenses-${category}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
