import { PageHeader } from "@/components/PageHeader";
import { PlaceholderCard } from "@/components/PlaceholderCard";
import { requirePageAccess } from "@/lib/auth";

export default async function SalesPage() {
  await requirePageAccess("sales");

  return (
    <div>
      <PageHeader
        title="Продажи"
        description="Абонементы, разовые услуги, динамика выручки."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PlaceholderCard title="Продажи за период" hint="Сводка появится позже." />
        <PlaceholderCard title="Топ услуг" hint="Аналитика появится позже." />
      </div>
    </div>
  );
}
