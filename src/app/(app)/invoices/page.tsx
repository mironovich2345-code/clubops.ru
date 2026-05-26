import { PageHeader } from "@/components/PageHeader";
import { PlaceholderCard } from "@/components/PlaceholderCard";
import { requirePageAccess } from "@/lib/auth";

export default async function InvoicesPage() {
  await requirePageAccess("invoices");

  return (
    <div>
      <PageHeader
        title="Счета"
        description="Входящие и исходящие счета, статусы оплаты."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PlaceholderCard title="К оплате" hint="Список счетов появится позже." />
        <PlaceholderCard title="Оплаченные" hint="Архив оплаченных счетов." />
      </div>
    </div>
  );
}
