import { PageHeader } from "@/components/PageHeader";
import { PlaceholderCard } from "@/components/PlaceholderCard";
import { requirePageAccess } from "@/lib/auth";

export default async function ExpensesPage() {
  await requirePageAccess("expenses");

  return (
    <div>
      <PageHeader
        title="Расходы"
        description="Учёт расходов клуба: чеки, категории, согласования."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PlaceholderCard title="Список расходов" hint="Таблица расходов появится позже." />
        <PlaceholderCard title="Категории" hint="Управление категориями расходов." />
      </div>
    </div>
  );
}
