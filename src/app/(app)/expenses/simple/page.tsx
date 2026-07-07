import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
import { ensureExpenseCategoriesSeeded, getActiveExpenseCategories } from "@/lib/expense-categories";
import { formatUserDisplayName } from "@/lib/user-display";
import { SimpleExpenseForm } from "./SimpleExpenseForm";

export const dynamic = "force-dynamic";

export default async function SimpleExpensePage() {
  await requirePageAccess("expenses");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canCreateOperational(ctx.effectiveRoles)) redirect("/expenses");
  const companyId = ctx.selectedCompanyId;
  const clubId = ctx.selectedClubId ?? (ctx.allowedClubIds.length === 1 ? ctx.allowedClubIds[0] : null);
  if (!companyId || !clubId) redirect("/expenses");

  await ensureExpenseCategoriesSeeded();
  const [categories, employees] = await Promise.all([
    getActiveExpenseCategories(),
    // Active, non-deleted users with access to this Club (company- or club-level).
    prisma.user.findMany({
      where: {
        isActive: true, deletedAt: null,
        OR: [
          { clubRoles: { some: { clubId } } },
          { companyAccess: { some: { companyId } } },
        ],
      },
      select: { id: true, name: true, firstName: true, lastName: true, deletedAt: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div>
      <PageHeader title="Новый расход" description="Упрощённый расход клуба (оплата наличными из ИП клуба)" />
      <div className="mt-4">
        <SimpleExpenseForm
          categories={categories.map((c) => ({ key: c.key, name: c.name }))}
          employees={employees.map((e) => ({ id: e.id, name: formatUserDisplayName(e) }))}
        />
      </div>
    </div>
  );
}
