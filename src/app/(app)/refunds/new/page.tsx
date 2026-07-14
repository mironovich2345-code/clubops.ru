import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
import { NewRefundStarter } from "./_components/NewRefundStarter";

export const dynamic = "force-dynamic";

export default async function NewRefundPage() {
  await requirePageAccess("refunds");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) redirect("/refunds");
  // Only manager / regional (create-capable) may start a refund draft.
  if (!canCreateOperational(ctx.effectiveRoles)) redirect("/refunds");

  const clubs = await prisma.club.findMany({
    where: { id: { in: ctx.allowedClubIds }, companyId: ctx.selectedCompanyId, isActive: true },
    select: { id: true, name: true }, orderBy: { name: "asc" },
  });
  if (clubs.length === 0) redirect("/refunds");
  const defaultClubId = ctx.selectedClubId && clubs.some((c) => c.id === ctx.selectedClubId) ? ctx.selectedClubId : clubs[0].id;

  return (
    <div>
      <PageHeader title="Новый возврат" description="Выберите тип возврата, затем загрузите документы и реквизиты" />
      {/* Sender is ALWAYS the current signed-in user (read-only). There is no
          sender selector; the server sets createdByUserId from the session and
          ignores any client-supplied sender field. */}
      <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">
        Кто отправляет: <span className="font-medium text-slate-900">{ctx.user.name}</span>
        <span className="text-slate-400"> · {ctx.user.email}</span>
      </div>
      <NewRefundStarter clubs={clubs} defaultClubId={defaultClubId} />
    </div>
  );
}
