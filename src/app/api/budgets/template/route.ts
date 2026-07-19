import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext } from "@/lib/access";
import { canImportPlansAndBudgets } from "@/lib/auth";
import { normalizeMonth } from "@/lib/sales-plans";
import { BUDGET_CATEGORIES, budgetCategoryLabel } from "@/lib/budgets";
import { buildBudgetTemplateBuffer } from "@/lib/imports/budget-import";

export const dynamic = "force-dynamic";

// Budget-by-category XLSX template — owner / general director only. One row per
// (club × budget category) for the selected month, amounts left blank. No secrets.
export async function GET(req: Request) {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || !canImportPlansAndBudgets(ctx.effectiveRoles)) {
    return new NextResponse("Not found", { status: 404 });
  }
  const url = new URL(req.url);
  const month = normalizeMonth(url.searchParams.get("month") ?? "");
  if (!month) return new NextResponse("Bad month", { status: 400 });

  const clubs = ctx.allowedClubIds.length
    ? (await prisma.club.findMany({ where: { companyId: ctx.selectedCompanyId, id: { in: ctx.allowedClubIds } }, select: { id: true, name: true, city: true }, orderBy: { name: "asc" } })).map((c) => ({ id: c.id, name: c.name, city: c.city ?? "" }))
    : [];
  const categories = BUDGET_CATEGORIES.map((c) => ({ key: c.key, label: budgetCategoryLabel(c.key) }));
  const buf = new Uint8Array(buildBudgetTemplateBuffer(month, clubs, categories));
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="budgets-template-${month}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
