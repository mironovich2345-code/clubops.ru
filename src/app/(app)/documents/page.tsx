import { PageHeader } from "@/components/PageHeader";
import { PlaceholderCard } from "@/components/PlaceholderCard";
import { requirePageAccess } from "@/lib/access";

export default async function DocumentsPage() {
  await requirePageAccess("documents");

  return (
    <div>
      <PageHeader
        title="Документы"
        description="Договоры, акты, чеки и сопровождающие документы."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PlaceholderCard title="Все документы" hint="Хранилище появится позже." />
        <PlaceholderCard title="Шаблоны" hint="Шаблоны документов появятся позже." />
      </div>
    </div>
  );
}
