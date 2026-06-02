import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth";
import { getCurrentCompanyAndClub, getClubsInScope } from "@/lib/access";
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

  const clubs = await getClubsInScope(scope);

  return (
    <div>
      <PageHeader
        title="Импорт данных"
        description="Загрузка исторических продаж и расходов из Excel/CSV"
      />
      <ImportForm clubs={clubs} />
    </div>
  );
}
