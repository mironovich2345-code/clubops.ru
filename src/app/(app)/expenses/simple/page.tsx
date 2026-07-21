import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
import { ensureExpenseCategoriesSeeded, getActiveExpenseCategories } from "@/lib/expense-categories";
import { isCashForbiddenCategory } from "@/lib/expenses";
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
  const [categories, payer] = await Promise.all([
    // System categories + THIS company's own active categories only.
    getActiveExpenseCategories(companyId),
    // Payer is always the authenticated user — fetch only their display name.
    prisma.user.findUnique({ where: { id: ctx.user.id }, select: { name: true, firstName: true, lastName: true, deletedAt: true } }),
  ]);

  // Cash form hides the never-cash categories (taxes/rent/builders) — they stay
  // in the catalog/invoices/analytics; the server rejects them too.
  const cashCategories = categories.filter((c) => !isCashForbiddenCategory(c.key));

  return (
    <div>
      <PageHeader title="Новый расход" description="Упрощённый расход клуба (оплата наличными из ИП клуба)" />
      <div className="mt-4">
        <SimpleExpenseForm
          categories={cashCategories.map((c) => ({ key: c.key, name: c.name }))}
          payerName={payer ? formatUserDisplayName(payer) : "Текущий пользователь"}
        />
      </div>
    </div>
  );
}
