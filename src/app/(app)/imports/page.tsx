import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth";
import { ensureDemoData } from "@/lib/seed";
import { getClubsForUser } from "@/lib/invoices";
import { ImportForm } from "./_components/ImportForm";

export const dynamic = "force-dynamic";

export default async function ImportsPage() {
  const user = await requirePageAccess("imports");
  await ensureDemoData();

  const clubs = await getClubsForUser(user);

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
