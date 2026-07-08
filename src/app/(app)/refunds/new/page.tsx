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
      <NewRefundStarter clubs={clubs} defaultClubId={defaultClubId} />
    </div>
  );
}
