import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/access";
import { getCurrentCompanyAndClub, getClubsInScope, getCurrentAccessContext } from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
import { NoCompanyState } from "@/components/NoCompanyState";
import { ImportForm } from "./_components/ImportForm";

export const dynamic = "force-dynamic";

export default async function ImportsPage() {
  const user = await requirePageAccess("imports");

  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return (
      <NoCompanyState
        title="Импорт данных"
        description="Загрузка исторических продаж и расходов из Excel/CSV"
      />
    );
  }

  const [clubs, ctx] = await Promise.all([getClubsInScope(scope), getCurrentAccessContext()]);
  const canCreate = ctx ? canCreateOperational(ctx.effectiveRoles) : false;

  return (
    <div>
      <PageHeader
        title="Импорт данных"
        description="Загрузка исторических продаж и расходов из Excel/CSV"
      />
      {canCreate ? (
        <ImportForm clubs={clubs} />
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
          Импорт доступен управляющим и региональным директорам.
        </div>
      )}
    </div>
  );
}
