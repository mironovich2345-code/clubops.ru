import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { getRefundForContext } from "@/lib/refunds";

export const dynamic = "force-dynamic";

// Phase 1 stub — the refund calculation step is added in the next phase.
export default async function RefundDetailsStubPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess("refunds");
  const { id } = await params;
  const ctx = await getCurrentAccessContext();
  if (!ctx) redirect("/login");
  const refund = await getRefundForContext(ctx, id);
  if (!refund) redirect("/refunds");

  return (
    <div>
      <PageHeader title="Новый возврат — расчёт" description="Шаг 2" />
      <div className="mt-4 max-w-2xl rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
        <p>Расчёт возврата будет добавлен следующим этапом.</p>
        <p className="mt-2 text-slate-500">Документы и реквизиты сохранены в черновике.</p>
        <div className="mt-4 flex gap-3">
          <Link href={`/refunds/new/${id}`} className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Назад к документам</Link>
          <Link href="/refunds" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">К списку возвратов</Link>
        </div>
      </div>
    </div>
  );
}
