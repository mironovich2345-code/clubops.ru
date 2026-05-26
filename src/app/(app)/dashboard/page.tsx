import { PageHeader } from "@/components/PageHeader";
import { PlaceholderCard } from "@/components/PlaceholderCard";
import { requirePageAccess } from "@/lib/auth";

export default async function DashboardPage() {
  await requirePageAccess("dashboard");

  return (
    <div>
      <PageHeader
        title="Дашборд"
        description="Сводка по клубам, выручке и операционным метрикам."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <PlaceholderCard title="Выручка за период" hint="Виджет появится позже." />
        <PlaceholderCard title="Активные клубы" hint="Виджет появится позже." />
        <PlaceholderCard title="Ключевые расходы" hint="Виджет появится позже." />
      </div>
    </div>
  );
}
